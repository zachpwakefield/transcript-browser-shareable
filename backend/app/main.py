"""FastAPI application factory for the local, read-only browser service."""

from __future__ import annotations

import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import mimetypes
from pathlib import Path
import re
from typing import Any, Iterable

from fastapi import FastAPI, HTTPException, Path as PathParameter, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .constants import (
    ALLOWED_DETAIL_LEVELS,
    ALLOWED_SEQUENCE_KINDS,
    DEFAULT_SEARCH_LIMIT,
    MAX_EXPORT_ROWS,
    MAX_REGION_GENES,
    MAX_REGION_OVERRIDES,
    MAX_REGION_SPAN_BP,
    MAX_REGION_TRANSCRIPTS,
    MAX_SEARCH_LIMIT,
)
from .errors import QueryContractError, StartupValidationError
from .package import RuntimePackage, load_runtime_package
from .pdf_report import (
    MAX_PDF_FEATURE_ROWS,
    MAX_PDF_SEQUENCE_CHARS,
    PdfReportLimitError,
    PdfReportRequest,
    build_pdf_report,
)
from .repository import AnnotationRepository


RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
LOCAL_ALLOWED_HOSTS = ("127.0.0.1", "localhost")
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "base-uri 'none'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "script-src 'self'; "
    # React sets geometry and source colors through element.style.  Production
    # scripts and styles remain same-origin; this is the only inline allowance.
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "form-action 'self'"
)


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _etag(build_hash: str, body: bytes) -> str:
    digest = hashlib.sha256(build_hash.encode("ascii") + b"\0" + body).hexdigest()
    return f'"{digest}"'


def _if_none_match(request: Request, etag: str) -> bool:
    values = [value.strip() for value in request.headers.get("if-none-match", "").split(",")]
    return "*" in values or etag in values


def _json_response(
    request: Request,
    package: RuntimePackage,
    payload: Any,
    *,
    status_code: int = 200,
    headers: dict[str, str] | None = None,
) -> Response:
    body = _canonical_json(payload)
    etag = _etag(package.build_hash, body)
    response_headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=0, must-revalidate",
        **(headers or {}),
    }
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=response_headers)
    return Response(
        content=body,
        status_code=status_code,
        media_type="application/json",
        headers=response_headers,
    )


def _bytes_response(
    request: Request,
    package: RuntimePackage,
    body: bytes,
    media_type: str,
    headers: dict[str, str] | None = None,
) -> Response:
    etag = _etag(package.build_hash, body)
    response_headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=0, must-revalidate",
        **(headers or {}),
    }
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=response_headers)
    return Response(content=body, media_type=media_type, headers=response_headers)


def _not_found(entity: str, identifier: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "code": f"{entity.upper()}_NOT_FOUND",
            "message": f"No {entity} matching {identifier!r} exists in this build.",
        },
    )


def _query_error(exc: QueryContractError) -> HTTPException:
    status = 413 if "exceeds" in str(exc).lower() else 400
    return HTTPException(
        status_code=status,
        detail={"code": "QUERY_CONTRACT_ERROR", "message": str(exc)},
    )


def _parse_sources(value: str | None) -> list[str]:
    if not value:
        return []
    result: list[str] = []
    seen: set[str] = set()
    for raw in value.split(","):
        source = raw.strip()
        if not source:
            continue
        key = source.upper()
        if key not in seen:
            result.append(source)
            seen.add(key)
    if len(result) > 20:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "TOO_MANY_SOURCES",
                "message": "At most 20 comma-separated feature sources may be requested.",
            },
        )
    return result


def _tsv_bytes(records: list[dict[str, Any]]) -> bytes:
    if len(records) > MAX_EXPORT_ROWS:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "EXPORT_LIMIT_EXCEEDED",
                "message": f"Export exceeds the {MAX_EXPORT_ROWS:,}-row limit.",
            },
        )
    fields: list[str] = []
    seen: set[str] = set()
    for record in records:
        for key in record:
            if key not in seen:
                fields.append(key)
                seen.add(key)
    output = io.StringIO(newline="")
    if fields:
        writer = csv.DictWriter(output, fieldnames=fields, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        for record in records:
            flattened = {
                key: (
                    json.dumps(value, ensure_ascii=False, sort_keys=True)
                    if isinstance(value, (dict, list))
                    else value
                )
                for key, value in record.items()
            }
            writer.writerow(flattened)
    return output.getvalue().encode("utf-8")


def _iter_file(path: Path, start: int, length: int, chunk_size: int = 1024 * 1024) -> Iterable[bytes]:
    remaining = length
    with path.open("rb") as handle:
        handle.seek(start)
        while remaining:
            chunk = handle.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _reference_response(
    request: Request, package: RuntimePackage, public_name: str
) -> Response:
    reference = package.reference
    if reference is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "REFERENCE_UNAVAILABLE",
                "message": "This local data package has no verified whole-genome reference.",
            },
        )
    path = reference.allowed_files.get(public_name)
    if path is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "REFERENCE_FILE_NOT_FOUND",
                "message": "That file is not in the verified reference allow-list.",
            },
        )
    size = path.stat().st_size
    checksum = reference.checksums.get(public_name)
    etag = f'"{checksum}"' if checksum else f'"{package.build_hash}-{size}"'
    common = {
        "Accept-Ranges": "bytes",
        "ETag": etag,
        "Cache-Control": "private, max-age=31536000, immutable",
    }
    # Preconditions are evaluated before Range.  A matching If-None-Match
    # therefore yields 304 even when the client also supplied a Range header.
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=common)
    range_header = request.headers.get("range")
    if_range = request.headers.get("if-range")
    # Without a matching entity tag, RFC range semantics require the complete
    # representation rather than a partial response from a changed artifact.
    if range_header and if_range and if_range.strip() != etag:
        range_header = None
    start = 0
    end = size - 1
    status = 200
    if range_header:
        match = RANGE_RE.fullmatch(range_header.strip())
        if match is None or "," in range_header:
            return Response(
                status_code=416,
                headers={**common, "Content-Range": f"bytes */{size}"},
            )
        first, last = match.groups()
        if not first and not last:
            return Response(
                status_code=416,
                headers={**common, "Content-Range": f"bytes */{size}"},
            )
        if first:
            start = int(first)
            end = int(last) if last else size - 1
        else:
            suffix = int(last)
            if suffix <= 0:
                return Response(
                    status_code=416,
                    headers={**common, "Content-Range": f"bytes */{size}"},
                )
            start = max(0, size - suffix)
            end = size - 1
        if start >= size or end < start:
            return Response(
                status_code=416,
                headers={**common, "Content-Range": f"bytes */{size}"},
            )
        end = min(end, size - 1)
        status = 206
        common["Content-Range"] = f"bytes {start}-{end}/{size}"
    length = max(0, end - start + 1)
    common["Content-Length"] = str(length)
    media_type = mimetypes.guess_type(public_name)[0] or "application/octet-stream"
    if request.method == "HEAD":
        return Response(status_code=status, media_type=media_type, headers=common)
    return StreamingResponse(
        _iter_file(path, start, length),
        status_code=status,
        media_type=media_type,
        headers=common,
    )


def create_app(
    *,
    project_root: Path | None = None,
    package_root: Path | None = None,
    frontend_dist: Path | None = None,
    dev_fixture: bool = False,
    full_reference_verify: bool = False,
    full_database_verify: bool = False,
) -> FastAPI:
    project_root = (project_root or Path(__file__).resolve().parents[2]).resolve()
    package_root = Path(
        package_root
        or project_root / "data" / "builds" / ("sp1_fixture" if dev_fixture else "gencode_v45")
    ).expanduser().absolute()
    frontend_dist = Path(
        frontend_dist or project_root / "frontend" / "dist"
    ).expanduser().absolute()
    if frontend_dist.is_symlink():
        raise StartupValidationError("frontend_dist must not be a symbolic link")
    frontend_dist = frontend_dist.resolve()
    try:
        frontend_dist.relative_to(project_root)
    except ValueError as exc:
        raise StartupValidationError(
            "frontend_dist must remain inside project_root"
        ) from exc
    package = load_runtime_package(
        package_root,
        dev_fixture=dev_fixture,
        full_reference_verify=full_reference_verify,
        full_database_verify=full_database_verify,
    )
    repository = AnnotationRepository(package.database)

    app = FastAPI(
        title="Local Transcript and Protein-Feature Browser",
        version="1.1.2",
        # FastAPI's default Swagger page imports JavaScript and CSS from a CDN.
        # Keep the machine-readable local schema, but do not expose a runtime
        # network-dependent docs page in this offline application.
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    # Loopback binding does not by itself prevent DNS rebinding.  Keep the
    # accepted Host values aligned with the launcher URL and do not admit
    # TestClient's synthetic `testserver` host in production configuration.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(LOCAL_ALLOWED_HOSTS))
    app.state.runtime_package = package
    app.state.repository = repository

    @app.middleware("http")
    async def local_security_headers(request: Request, call_next: Any) -> Response:
        response: Response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
        response.headers.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        )
        return response

    @app.get("/api/v1/health")
    def health(request: Request) -> Response:
        return _json_response(
            request,
            package,
            {
                "status": "ok",
                "buildHash": package.build_hash,
                "technicalPreview": package.technical_preview,
                "readOnly": True,
            },
        )

    @app.get("/api/v1/manifest")
    def manifest(request: Request) -> Response:
        return _json_response(request, package, package.api_manifest())

    @app.get("/api/v1/search")
    def search(
        request: Request,
        q: str = Query(min_length=1, max_length=256),
        limit: int = Query(default=DEFAULT_SEARCH_LIMIT, ge=1, le=MAX_SEARCH_LIMIT),
    ) -> Response:
        try:
            payload = repository.search(q, limit)
        except QueryContractError as exc:
            raise _query_error(exc) from exc
        return _json_response(request, package, payload)

    @app.get("/api/v1/region")
    def region(
        request: Request,
        chromosome: str = Query(alias="chr", min_length=1, max_length=64),
        start0: int = Query(ge=0),
        end0: int = Query(gt=0),
        detail: str = Query(default="auto"),
        gene_offset: int = Query(default=0, alias="geneOffset", ge=0),
        gene_limit: int = Query(
            default=MAX_REGION_GENES, alias="geneLimit", ge=1, le=MAX_REGION_GENES
        ),
        transcript_offset: int = Query(
            default=0, alias="transcriptOffset", ge=0
        ),
        transcript_limit: int = Query(
            default=MAX_REGION_TRANSCRIPTS,
            alias="transcriptLimit",
            ge=1,
            le=MAX_REGION_TRANSCRIPTS,
        ),
        selected: list[str] | None = Query(default=None),
        pinned: list[str] | None = Query(default=None),
        bp_per_pixel: float | None = Query(
            default=None, alias="bpPerPixel", gt=0, le=1_000_000_000
        ),
    ) -> Response:
        if detail not in ALLOWED_DETAIL_LEVELS:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "INVALID_DETAIL",
                    "message": "detail must be auto, overview, compact, labeled, or expanded.",
                },
            )
        if end0 - start0 > MAX_REGION_SPAN_BP:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "REGION_SPAN_LIMIT",
                    "message": f"Region span exceeds the {MAX_REGION_SPAN_BP:,}-bp limit.",
                },
            )
        overrides = list(
            dict.fromkeys([*(selected or []), *(pinned or [])])
        )
        if len(overrides) > MAX_REGION_OVERRIDES:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "TOO_MANY_REGION_OVERRIDES",
                    "message": f"At most {MAX_REGION_OVERRIDES} selected/pinned entities may be requested.",
                },
            )
        try:
            payload = repository.region(
                chromosome,
                start0,
                end0,
                detail,
                gene_offset=gene_offset,
                gene_limit=gene_limit,
                transcript_offset=transcript_offset,
                transcript_limit=transcript_limit,
                overrides=overrides,
                bp_per_pixel=bp_per_pixel,
            )
        except QueryContractError as exc:
            raise _query_error(exc) from exc
        return _json_response(request, package, payload)

    @app.get("/api/v1/genes/{identifier}")
    def gene(
        request: Request,
        identifier: str = PathParameter(min_length=1, max_length=128),
    ) -> Response:
        payload = repository.get_gene(identifier)
        if payload is None:
            raise _not_found("gene", identifier)
        return _json_response(request, package, payload)

    @app.get("/api/v1/transcripts/{identifier}")
    def transcript(
        request: Request,
        identifier: str = PathParameter(min_length=1, max_length=128),
    ) -> Response:
        payload = repository.get_transcript(identifier)
        if payload is None:
            raise _not_found("transcript", identifier)
        return _json_response(request, package, payload)

    @app.get("/api/v1/transcripts/{identifier}/features")
    def transcript_features(
        request: Request,
        identifier: str = PathParameter(min_length=1, max_length=128),
        sources: str | None = Query(default=None, max_length=512),
    ) -> Response:
        try:
            payload = repository.get_features(identifier, _parse_sources(sources))
        except QueryContractError as exc:
            raise _query_error(exc) from exc
        if payload is None:
            raise _not_found("transcript", identifier)
        return _json_response(request, package, payload)

    @app.get("/api/v1/transcripts/{identifier}/sequence")
    def transcript_sequence(
        request: Request,
        identifier: str = PathParameter(min_length=1, max_length=128),
        kind: str = Query(default="protein"),
    ) -> Response:
        if kind not in ALLOWED_SEQUENCE_KINDS:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "INVALID_SEQUENCE_KIND",
                    "message": "kind must be transcript_full, cds, or protein.",
                },
            )
        payload = repository.get_sequence(identifier, kind)
        if payload is None:
            raise _not_found("transcript", identifier)
        return _json_response(request, package, payload)

    @app.post("/api/v1/report/pdf")
    def transcript_pdf_report(specification: PdfReportRequest) -> Response:
        if specification.build_hash != package.build_hash:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "PDF_BUILD_MISMATCH",
                    "message": (
                        f"PDF request requires build {specification.build_hash}; "
                        f"current build is {package.build_hash}."
                    ),
                },
            )
        gene_payload = repository.get_gene(specification.gene_id)
        if gene_payload is None:
            raise _not_found("gene", specification.gene_id)
        if specification.locus is not None:
            gene_chrom = str(gene_payload.get("chr") or "").lower().removeprefix("chr")
            locus_chrom = specification.locus.chrom.lower().removeprefix("chr")
            if gene_chrom != locus_chrom:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "PDF_LOCUS_CHROMOSOME_MISMATCH",
                        "message": "The PDF structure locus must use the selected gene chromosome.",
                    },
                )
            contig = repository.resolve_contig(str(gene_payload.get("chr") or ""))
            if contig is None or specification.locus.end0 > int(contig["length"]):
                contig_length = int(contig["length"]) if contig is not None else 0
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "PDF_LOCUS_OUT_OF_BOUNDS",
                        "message": (
                            f"The PDF structure locus exceeds {gene_payload.get('chr')} "
                            f"length {contig_length:,}."
                        ),
                    },
                )
            if specification.locus.end0 - specification.locus.start0 > MAX_REGION_SPAN_BP:
                raise HTTPException(
                    status_code=413,
                    detail={
                        "code": "PDF_LOCUS_SPAN_LIMIT",
                        "message": f"The PDF structure locus exceeds {MAX_REGION_SPAN_BP:,} bp.",
                    },
                )

        manifest_payload = package.api_manifest()
        declared_sources = manifest_payload.get("featureSources") or []
        allowed_sources = {
            str(item.get("name") if isinstance(item, dict) else item).casefold()
            for item in declared_sources
        }
        unknown_sources = [
            source
            for source in specification.feature_sources
            if source.casefold() not in allowed_sources
        ]
        if unknown_sources:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "PDF_UNKNOWN_FEATURE_SOURCE",
                    "message": f"Unknown local feature source: {unknown_sources[0]}.",
                },
            )

        items: list[dict[str, Any]] = []
        resolved_transcript_ids: set[str] = set()
        feature_total = 0
        sequence_total = 0
        for identifier in specification.transcript_ids:
            transcript_payload = repository.get_transcript(identifier)
            if transcript_payload is None:
                raise _not_found("transcript", identifier)
            resolved_identifier = str(transcript_payload.get("id") or identifier)
            if resolved_identifier in resolved_transcript_ids:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "PDF_DUPLICATE_TRANSCRIPT",
                        "message": (
                            f"Transcript {identifier} resolves to duplicate local transcript "
                            f"{resolved_identifier}."
                        ),
                    },
                )
            resolved_transcript_ids.add(resolved_identifier)
            if transcript_payload.get("geneId") != gene_payload.get("id"):
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "PDF_TRANSCRIPT_GENE_MISMATCH",
                        "message": f"Transcript {identifier} is not owned by gene {gene_payload.get('id')}.",
                    },
                )
            item: dict[str, Any] = {"transcript": transcript_payload}
            if "features" in specification.sections:
                # Repository feature queries treat an empty source list as
                # "all sources" for the general-purpose API.  In a PDF
                # specification, however, the list is the user's explicit
                # active-source selection, so an empty list must stay empty.
                if specification.feature_sources:
                    try:
                        feature_payload = repository.get_features(
                            identifier, specification.feature_sources
                        )
                    except QueryContractError as exc:
                        raise _query_error(exc) from exc
                    features = list((feature_payload or {}).get("features") or [])
                else:
                    features = []
                feature_total += len(features)
                if feature_total > MAX_PDF_FEATURE_ROWS:
                    raise HTTPException(
                        status_code=413,
                        detail={
                            "code": "PDF_FEATURE_LIMIT",
                            "message": (
                                f"Selected feature tables exceed the {MAX_PDF_FEATURE_ROWS:,}-row "
                                "PDF limit. Choose fewer transcripts or sources."
                            ),
                        },
                    )
                item["features"] = features
            if "sequence" in specification.sections and specification.sequence_excerpt is not None:
                excerpt = specification.sequence_excerpt
                sequence_payload = repository.get_sequence(identifier, excerpt.kind)
                if sequence_payload is None:
                    raise _not_found("transcript", identifier)
                if sequence_payload.get("available"):
                    sequence_length = int(sequence_payload.get("length") or 0)
                    if excerpt.end1 > sequence_length:
                        raise HTTPException(
                            status_code=400,
                            detail={
                                "code": "PDF_SEQUENCE_RANGE_OUT_OF_BOUNDS",
                                "message": (
                                    f"{identifier} {excerpt.kind} sequence is {sequence_length:,} "
                                    f"characters; requested end is {excerpt.end1:,}."
                                ),
                            },
                        )
                    sequence_total += excerpt.end1 - excerpt.start1 + 1
                    if sequence_total > MAX_PDF_SEQUENCE_CHARS:
                        raise HTTPException(
                            status_code=413,
                            detail={
                                "code": "PDF_SEQUENCE_LIMIT",
                                "message": (
                                    f"Selected sequence excerpts exceed the {MAX_PDF_SEQUENCE_CHARS:,}-character "
                                    "PDF limit. Narrow the range or transcript set."
                                ),
                            },
                        )
                item["sequence"] = sequence_payload
            items.append(item)

        try:
            body = build_pdf_report(
                manifest=manifest_payload,
                gene=gene_payload,
                items=items,
                sections=specification.sections,
                feature_sources=specification.feature_sources,
                structure_scope=specification.structure_scope,
                locus=specification.locus,
                sequence_excerpt=specification.sequence_excerpt,
                generated_at=datetime.now(timezone.utc),
            )
        except PdfReportLimitError as exc:
            raise HTTPException(
                status_code=413,
                detail={"code": "PDF_REPORT_LIMIT", "message": str(exc)},
            ) from exc
        safe_symbol = re.sub(
            r"[^A-Za-z0-9_.-]+", "-", str(gene_payload.get("symbol") or gene_payload.get("id"))
        ).strip("-.") or "gene"
        filename = f"{safe_symbol}_{len(items)}-transcript-report.pdf"
        return Response(
            content=body,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )

    @app.get("/api/v1/features/{feature_id}")
    def feature(
        request: Request,
        feature_id: str = PathParameter(min_length=1, max_length=256),
    ) -> Response:
        payload = repository.get_feature(feature_id)
        if payload is None:
            raise _not_found("feature", feature_id)
        return _json_response(request, package, payload)

    @app.get("/api/v1/export")
    def export(
        request: Request,
        entity: str = Query(default="transcript", max_length=32),
        identifier: str | None = Query(default=None, alias="id", max_length=256),
        format: str = Query(default="json", max_length=16),
        chromosome: str | None = Query(
            default=None, alias="chr", max_length=64
        ),
        start0: int | None = Query(default=None, ge=0),
        end0: int | None = Query(default=None, gt=0),
        sources: str | None = Query(default=None, max_length=512),
    ) -> Response:
        if format not in {"json", "tsv"}:
            raise HTTPException(400, detail={"code": "INVALID_EXPORT_FORMAT", "message": "format must be json or tsv."})
        entity = entity.lower()
        records: list[dict[str, Any]]
        payload: Any
        filename: str
        if entity == "gene":
            if not identifier:
                raise HTTPException(400, detail={"code": "MISSING_ID", "message": "Gene export requires id."})
            payload = repository.get_gene(identifier)
            if payload is None:
                raise _not_found("gene", identifier)
            records = list(payload.get("transcripts") or [])
            filename = f"{payload['id']}_transcripts"
        elif entity == "transcript":
            if not identifier:
                raise HTTPException(400, detail={"code": "MISSING_ID", "message": "Transcript export requires id."})
            transcript_payload = repository.get_transcript(identifier)
            if transcript_payload is None:
                raise _not_found("transcript", identifier)
            try:
                feature_payload = repository.get_features(identifier, _parse_sources(sources))
            except QueryContractError as exc:
                raise _query_error(exc) from exc
            payload = {"transcript": transcript_payload, "features": feature_payload}
            records = list((feature_payload or {}).get("features") or [])
            filename = f"{transcript_payload['id']}_features"
        elif entity == "feature":
            if not identifier:
                raise HTTPException(400, detail={"code": "MISSING_ID", "message": "Feature export requires id."})
            payload = repository.get_feature(identifier)
            if payload is None:
                raise _not_found("feature", identifier)
            records = list(payload.get("segments") or []) or [payload]
            filename = f"{payload['id']}_feature"
        elif entity == "region":
            if chromosome is None or start0 is None or end0 is None:
                raise HTTPException(400, detail={"code": "MISSING_REGION", "message": "Region export requires chr, start0, and end0."})
            if end0 - start0 > MAX_REGION_SPAN_BP:
                raise HTTPException(413, detail={"code": "REGION_SPAN_LIMIT", "message": f"Region span exceeds {MAX_REGION_SPAN_BP:,} bp."})
            try:
                region_payload = repository.region(
                    chromosome, start0, end0, "labeled"
                )
            except QueryContractError as exc:
                raise _query_error(exc) from exc
            # Region queries deliberately over-fetch one viewport on each side
            # for panning.  Exports represent the submitted locus, not that
            # transport/cache margin.
            exported_genes = [
                item
                for item in region_payload["genes"]
                if item.get("inRequestedRegion")
            ]
            exported_transcripts = [
                item
                for item in region_payload["transcripts"]
                if item.get("inRequestedRegion")
            ]
            payload = {
                **region_payload,
                "genes": exported_genes,
                "transcripts": exported_transcripts,
            }
            records = [*exported_genes, *exported_transcripts]
            filename = f"{payload['chr']}_{start0}_{end0}"
        else:
            raise HTTPException(400, detail={"code": "INVALID_EXPORT_ENTITY", "message": "entity must be gene, transcript, feature, or region."})

        disposition = {"Content-Disposition": f'attachment; filename="{filename}.{format}"'}
        if format == "json":
            body = _canonical_json(payload)
            if len(records) > MAX_EXPORT_ROWS:
                raise HTTPException(413, detail={"code": "EXPORT_LIMIT_EXCEEDED", "message": f"Export exceeds {MAX_EXPORT_ROWS:,} rows."})
            return _bytes_response(request, package, body, "application/json", disposition)
        return _bytes_response(request, package, _tsv_bytes(records), "text/tab-separated-values", disposition)

    @app.api_route(
        "/reference/{public_name:path}",
        methods=["GET", "HEAD"],
        include_in_schema=False,
    )
    def reference_file(request: Request, public_name: str) -> Response:
        if len(public_name) > 256:
            raise HTTPException(status_code=404, detail="Not found")
        return _reference_response(request, package, public_name)

    # Registered last deliberately. Unknown API/reference paths must remain 404
    # instead of being rewritten to the SPA entry point.
    @app.get("/{full_path:path}")
    def spa(full_path: str) -> Response:
        if full_path == "api" or full_path.startswith("api/") or full_path.startswith("reference/"):
            raise HTTPException(status_code=404, detail="Not found")
        if frontend_dist.is_dir():
            dist_root = frontend_dist.resolve()
            target = (dist_root / full_path).resolve()
            try:
                target.relative_to(dist_root)
            except ValueError:
                raise HTTPException(status_code=404, detail="Not found")
            if target.is_file() and not target.is_symlink():
                return FileResponse(target)
            index = dist_root / "index.html"
            if index.is_file():
                return FileResponse(index, media_type="text/html")
        return HTMLResponse(
            "<!doctype html><meta charset='utf-8'><title>Transcript Browser API</title>"
            "<h1>Frontend bundle is not built</h1>"
            "<p>The read-only API is available under <code>/api/v1/</code>.</p>",
            status_code=503,
        )

    return app
