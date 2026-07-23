#!/usr/bin/env python3
"""Exercise the read-only API against a running local transcript browser.

This deliberately uses only the Python standard library, so it can be run from
another terminal while the browser server is running.  It resolves a gene and
transcript from the search index rather than assuming that the gene endpoint
accepts a symbol directly.
"""

from __future__ import annotations

import argparse
import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


class SmokeFailure(RuntimeError):
    pass


def _get(base_url: str, path: str) -> tuple[int, Any]:
    url = base_url.rstrip("/") + path
    request = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8")
            status = int(response.status)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SmokeFailure(f"GET {path} returned HTTP {exc.code}: {body[:500]}") from exc
    except URLError as exc:
        raise SmokeFailure(f"Could not reach {base_url}: {exc.reason}") from exc
    try:
        return status, json.loads(body)
    except json.JSONDecodeError as exc:
        raise SmokeFailure(f"GET {path} did not return JSON: {body[:500]}") from exc


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def _query(**values: object) -> str:
    return urlencode({key: value for key, value in values.items() if value is not None})


def run(args: argparse.Namespace) -> None:
    base_url = args.base_url.rstrip("/")

    status, health = _get(base_url, "/api/v1/health")
    _require(status == 200, f"health returned HTTP {status}")
    _require(health.get("status") == "ok", "health status is not ok")
    _require(health.get("readOnly") is True, "runtime is not marked read-only")

    status, manifest = _get(base_url, "/api/v1/manifest")
    _require(status == 200, f"manifest returned HTTP {status}")
    _require(bool(manifest.get("buildHash")), "manifest has no buildHash")
    _require("capabilities" in manifest, "manifest has no capabilities")
    if args.expect_scope:
        _require(
            manifest.get("scope") == args.expect_scope,
            f"expected scope={args.expect_scope!r}, got {manifest.get('scope')!r}",
        )

    status, search = _get(
        base_url,
        "/api/v1/search?" + _query(q=args.gene_query, limit=50),
    )
    _require(status == 200, f"search returned HTTP {status}")
    results = list(search.get("results") or [])
    _require(results, f"search returned no results for {args.gene_query!r}")
    gene_result = next((item for item in results if item.get("kind") == "gene"), None)
    _require(gene_result is not None, "search returned no gene result")
    transcript_result = next(
        (item for item in results if item.get("kind") == "transcript"), None
    )

    gene_id = str(gene_result["id"])
    transcript_id = args.transcript or "ENST00000327443"
    if transcript_result is not None and not args.transcript_explicit:
        transcript_id = str(transcript_result["id"])

    status, gene = _get(base_url, "/api/v1/genes/" + quote(gene_id, safe=""))
    _require(status == 200, f"gene endpoint returned HTTP {status}")
    _require(gene.get("id") == gene_id, "gene endpoint returned a different gene")
    _require(len(gene.get("transcripts") or []) > 0, "gene has no transcripts")

    # The region response is the genome-browser contract: it must carry both
    # genes and transcript rows for a real locus, not only a detail endpoint.
    chromosome = gene.get("chr")
    start0 = gene.get("start0")
    end0 = gene.get("end0")
    _require(chromosome and isinstance(start0, int) and isinstance(end0, int), "gene has no locus")
    status, region = _get(
        base_url,
        "/api/v1/region?" + _query(chr=chromosome, start0=start0, end0=end0, detail="expanded"),
    )
    _require(status == 200, f"region returned HTTP {status}")
    _require(len(region.get("genes") or []) > 0, "region returned no genes")
    _require(len(region.get("transcripts") or []) > 0, "region returned no transcripts")

    status, transcript = _get(
        base_url, "/api/v1/transcripts/" + quote(transcript_id, safe="")
    )
    _require(status == 200, f"transcript endpoint returned HTTP {status}")
    _require(transcript.get("id") == transcript_id, "transcript endpoint returned a different transcript")

    status, features = _get(
        base_url,
        "/api/v1/transcripts/"
        + quote(transcript_id, safe="")
        + "/features?"
        + _query(sources=args.feature_sources),
    )
    _require(status == 200, f"feature endpoint returned HTTP {status}")
    _require(features.get("transcriptId") == transcript_id, "feature response has wrong transcript")
    _require("features" in features and "mapping" in features, "feature response is incomplete")

    status, sequence = _get(
        base_url,
        "/api/v1/transcripts/"
        + quote(transcript_id, safe="")
        + "/sequence?kind=protein",
    )
    _require(status == 200, f"sequence endpoint returned HTTP {status}")
    _require(sequence.get("kind") == "protein", "sequence response is not protein")
    _require(sequence.get("available") is True, "protein sequence is not available")
    _require(int(sequence.get("length") or 0) > 0, "protein sequence is empty")

    print("API smoke test passed")
    print(json.dumps({
        "buildHash": manifest.get("buildHash"),
        "scope": manifest.get("scope"),
        "gene": gene_id,
        "transcript": transcript_id,
        "featureCount": len(features.get("features") or []),
        "proteinLength": sequence.get("length"),
    }, indent=2, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--gene-query", default="SP1")
    parser.add_argument(
        "--transcript",
        default=None,
        help="Transcript stable ID to exercise (defaults to feature-rich SP1-201).",
    )
    parser.add_argument(
        "--feature-sources",
        default="interpro,pfam,mobidblite,elm",
        help="Comma-separated feature sources sent to the API.",
    )
    parser.add_argument(
        "--expect-scope",
        default="sp1",
        help="Expected manifest scope; pass an empty string to skip this assertion.",
    )
    args = parser.parse_args()
    args.transcript_explicit = args.transcript is not None
    if args.expect_scope == "":
        args.expect_scope = None
    try:
        run(args)
    except SmokeFailure as exc:
        print(f"API smoke test failed: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
