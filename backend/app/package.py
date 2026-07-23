"""Load and validate immutable annotation data packages."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any, Mapping

from .constants import DENSITY_TILE_LEVELS, EXPECTED_SCHEMA_VERSION
from .database import AnnotationDatabase, DatabaseMetadata
from .errors import StartupValidationError


SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _read_json(path: Path, *, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise StartupValidationError(f"{label} is missing: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise StartupValidationError(f"Cannot read {label} {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise StartupValidationError(f"{label} must contain one JSON object: {path}")
    return value


def _first(mapping: Mapping[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return default


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_child(root: Path, raw_path: str) -> Path:
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        # Manifests may use paths relative either to the package or reference dir.
        if candidate.parts and candidate.parts[0] == root.name:
            candidate = root.parent / candidate
        else:
            candidate = root / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise StartupValidationError(
            f"Reference manifest path escapes its package: {raw_path}"
        ) from exc
    return resolved


def _safe_lexical_child(root: Path, raw_path: str) -> Path:
    """Return an in-package link path without following its final symlink.

    The reference builder may place a declared symlink in the package while the
    multi-gigabyte FASTA remains in the user's reference cache.  Containment is
    therefore checked lexically here; the resolved target is checked separately
    against the exact ``target_path`` recorded by the verified manifest.
    """

    candidate = Path(raw_path)
    if candidate.is_absolute():
        raise StartupValidationError(
            f"Reference link/path must be package-relative: {raw_path}"
        )
    if candidate.parts and candidate.parts[0] == root.name:
        candidate = Path(*candidate.parts[1:])
    lexical = Path(os.path.abspath(root / candidate))
    try:
        relative = lexical.relative_to(root.absolute())
    except ValueError as exc:
        raise StartupValidationError(
            f"Reference link/path escapes its package: {raw_path}"
        ) from exc
    # The final component may intentionally be an explicitly declared external
    # reference symlink.  An intermediate symlink is never required and could
    # otherwise tunnel an apparently in-package manifest/artifact path outside
    # the verified reference root.
    cursor = root.absolute()
    for part in relative.parts[:-1]:
        cursor /= part
        if cursor.is_symlink():
            raise StartupValidationError(
                f"Reference link/path has a symbolic-link parent: {raw_path}"
            )
    return lexical


def _regular_internal_file(root: Path, raw_path: str, *, label: str) -> Path:
    lexical = _safe_lexical_child(root, raw_path)
    if lexical.is_symlink() or not lexical.is_file():
        raise StartupValidationError(
            f"{label} must be a regular in-package file: {lexical}"
        )
    return lexical.resolve()


def _load_checksum_file(path: Path, root: Path) -> dict[str, str]:
    checksums: dict[str, str] = {}
    if not path.is_file():
        return checksums
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise StartupValidationError(f"Cannot read checksum file {path}: {exc}") from exc
    for number, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or not SHA256_RE.fullmatch(parts[0]):
            raise StartupValidationError(
                f"Malformed SHA-256 entry at {path}:{number}."
            )
        name = parts[1].lstrip("*").removeprefix("./")
        candidate = Path(name)
        if candidate.parts and candidate.parts[0] == root.name:
            candidate = Path(*candidate.parts[1:])
        checksums[candidate.as_posix()] = parts[0].lower()
        checksums[candidate.name] = parts[0].lower()
    return checksums


@dataclass(frozen=True)
class ReferencePackage:
    root: Path
    primary: Path
    primary_public_name: str
    fai_public_name: str | None
    gzi_public_name: str | None
    chrom_sizes: Path
    chrom_sizes_public_name: str
    allowed_files: Mapping[str, Path]
    checksums: Mapping[str, str]
    kind: str

    @property
    def primary_relative(self) -> str:
        return self.primary_public_name


@dataclass(frozen=True)
class RuntimePackage:
    root: Path
    manifest_path: Path
    manifest: Mapping[str, Any]
    database: AnnotationDatabase
    database_metadata: DatabaseMetadata
    validation_report: Mapping[str, Any] | None
    build_hash: str
    technical_preview: bool
    reference: ReferencePackage | None

    def api_manifest(self) -> dict[str, Any]:
        release = _first(
            self.manifest,
            "release",
            "gencode_release",
            "gencodeRelease",
            default="GENCODE v45",
        )
        ensembl = _first(
            self.manifest,
            "ensembl_release",
            "ensemblRelease",
            default=111,
        )
        assembly = _first(self.manifest, "assembly", default="GRCh38.p14")
        sources = _first(
            self.manifest,
            "feature_sources",
            "featureSources",
            default=[],
        )
        capabilities = dict(self.manifest.get("capabilities") or {})
        capabilities.update(
            {
                "reference": self.reference is not None,
                "wholeGenomeReference": self.reference is not None,
                "technicalPreview": self.technical_preview,
                "readOnly": True,
                "offlineRuntime": True,
                "density": self.database.table_exists("density_tile"),
                "boundedRegionPagination": True,
                "selectedEntityLodOverride": True,
                "pdfReports": True,
            }
        )
        density_levels: list[int] = []
        if capabilities["density"]:
            density_levels = [
                int(row["tile_size"])
                for row in self.database.fetch_all(
                    "SELECT DISTINCT tile_size FROM density_tile ORDER BY tile_size"
                )
            ]
        reference: dict[str, Any] = {"available": False}
        if self.reference is not None:
            reference = {
                "available": True,
                "verified": True,
                "kind": self.reference.kind,
                "url": f"/reference/{self.reference.primary_relative}",
                "chromSizesUrl": "/reference/"
                + self.reference.chrom_sizes_public_name,
            }
            if self.reference.fai_public_name is not None:
                reference["faiUrl"] = "/reference/" + self.reference.fai_public_name
            if self.reference.gzi_public_name is not None:
                reference["gziUrl"] = "/reference/" + self.reference.gzi_public_name
        return {
            "schemaVersion": EXPECTED_SCHEMA_VERSION,
            "buildHash": self.build_hash,
            "release": release,
            "ensemblRelease": ensembl,
            "assembly": assembly,
            "technicalPreview": self.technical_preview,
            "scope": self.manifest.get("scope"),
            "featureSources": sources,
            "capabilities": capabilities,
            "densityTileLevels": density_levels,
            "validation": {
                "available": self.validation_report is not None,
                "passed": bool(
                    self.validation_report
                    and _as_bool(self.validation_report.get("passed", False))
                ),
            },
            "reference": reference,
            "coordinateContract": {
                "machine": "0-based half-open",
                "display": "1-based inclusive",
            },
        }


def _resolve_primary(reference_root: Path, metadata: Mapping[str, Any]) -> Path:
    explicit = _first(
        metadata,
        "path",
        "file",
        "primary",
        "fasta",
        "fasta_path",
        "fastaPath",
        "two_bit",
        "twoBit",
    )
    if explicit:
        return _safe_child(reference_root, str(explicit))
    patterns = ("*.2bit", "*.fa.gz", "*.fasta.gz", "*.fa", "*.fasta")
    candidates: list[Path] = []
    for pattern in patterns:
        candidates.extend(sorted(reference_root.glob(pattern)))
    if len(candidates) != 1:
        raise StartupValidationError(
            "Reference manifest must identify exactly one whole-genome 2bit or FASTA file."
        )
    return candidates[0].resolve()


def _resolve_chrom_sizes(reference_root: Path, metadata: Mapping[str, Any]) -> Path:
    explicit = _first(
        metadata,
        "chrom_sizes",
        "chromSizes",
        "chrom_sizes_path",
        "chromSizesPath",
    )
    if explicit:
        return _safe_child(reference_root, str(explicit))
    candidates = sorted(reference_root.glob("*.chrom.sizes"))
    if len(candidates) != 1:
        raise StartupValidationError(
            "Reference package must contain exactly one provenance-stamped chrom.sizes file."
        )
    return candidates[0].resolve()


def _expected_checksum(
    path: Path, root: Path, metadata: Mapping[str, Any], checksums: Mapping[str, str]
) -> str | None:
    if path.name == Path(str(_first(metadata, "path", "file", default=""))).name:
        direct = _first(metadata, "sha256", "checksum")
        if direct and SHA256_RE.fullmatch(str(direct)):
            return str(direct).lower()
    relative = path.relative_to(root).as_posix()
    return checksums.get(relative) or checksums.get(path.name)


def _validate_receipt(
    receipt_path: Path,
    artifacts: Mapping[str, Path],
    expected_checksums: Mapping[str, str],
    *,
    external_artifacts: frozenset[str] = frozenset(),
    full_verify: bool,
) -> None:
    receipt = _read_json(receipt_path, label="reference verification receipt")
    raw_records = receipt.get("files", receipt.get("records"))
    if isinstance(raw_records, dict):
        records = [dict(value, path=key) for key, value in raw_records.items()]
    elif isinstance(raw_records, list):
        records = raw_records
    else:
        raise StartupValidationError(
            "Reference verification receipt must contain a files array or object."
        )

    by_path: dict[str, Mapping[str, Any]] = {}
    for record in records:
        if isinstance(record, dict) and record.get("path"):
            raw_name = str(record["path"])
            candidate = Path(raw_name)
            by_path[raw_name] = record
            by_path[candidate.as_posix()] = record
            by_path[candidate.name] = record
            try:
                by_path[str(candidate.resolve())] = record
            except OSError:
                pass
        if isinstance(record, dict):
            for key in ("public_name", "link_path", "lexical_path", "target_path"):
                if record.get(key):
                    raw_name = str(record[key])
                    by_path[raw_name] = record
                    by_path[Path(raw_name).name] = record

    for public_name, path in artifacts.items():
        record = (
            by_path.get(public_name)
            or by_path.get(path.name)
            or by_path.get(str(path))
            or by_path.get(str(path.resolve()))
        )
        if record is None:
            raise StartupValidationError(
                f"Reference verification receipt has no record for {public_name}. "
                "Run the annotation/reference build again."
            )
        expected = expected_checksums[public_name]
        recorded_hash = str(record.get("sha256", "")).lower()
        if recorded_hash != expected:
            raise StartupValidationError(
                f"Reference verification receipt checksum mismatch for {public_name}."
            )
        stat = path.stat()
        # In-package artifacts must remain portable when the project directory is
        # copied. Verify their declared size and inexpensive full SHA-256, but do
        # not bind them to an inode/device/mtime from the build directory. Large
        # external symlink targets retain the fast identity-receipt check; callers
        # can request a full rehash explicitly at launch.  Do not include
        # ``st_dev`` in that contract: macOS can assign a different device ID
        # after an APFS volume is remounted while the referenced file's bytes,
        # inode, size, and modification time remain unchanged.  Treating that
        # implementation detail as a content change makes a valid installation
        # fail to launch after an ordinary restart or volume remount.
        stat_contract = {"size": stat.st_size}
        if public_name in external_artifacts:
            stat_contract.update(
                {
                    "mtime_ns": stat.st_mtime_ns,
                    "inode": stat.st_ino,
                }
            )
        for key, actual in stat_contract.items():
            try:
                recorded = int(record[key])
            except (KeyError, TypeError, ValueError) as exc:
                raise StartupValidationError(
                    f"Reference verification receipt lacks integer {key} for {public_name}."
                ) from exc
            if recorded != actual:
                raise StartupValidationError(
                    f"Reference file identity changed after verification ({public_name}: {key}). "
                    "Run a full reference verification/rebuild before starting."
                )
        if full_verify or public_name not in external_artifacts:
            actual_hash = _sha256(path)
            if actual_hash != expected:
                raise StartupValidationError(
                    f"Full SHA-256 validation failed for reference file {public_name}."
                )


@dataclass(frozen=True)
class _DeclaredArtifact:
    public_name: str
    path: Path
    sha256: str
    size: int
    external: bool


def _declared_artifact(
    reference_root: Path,
    value: Mapping[str, Any],
    *,
    label: str,
) -> _DeclaredArtifact:
    public_name = str(value.get("public_name", "")).strip()
    if (
        not public_name
        or Path(public_name).is_absolute()
        or ".." in Path(public_name).parts
    ):
        raise StartupValidationError(f"{label} has an unsafe or missing public_name.")
    link_raw = str(value.get("link_path") or value.get("path") or public_name)
    link_path = _safe_lexical_child(reference_root, link_raw)
    target_raw = value.get("target_path")
    if target_raw:
        target = Path(str(target_raw)).expanduser().resolve()
        if not link_path.is_symlink():
            raise StartupValidationError(
                f"Declared external {label} link is not a symbolic link: {link_path}"
            )
        if link_path.resolve() != target:
            raise StartupValidationError(
                f"Declared {label} symlink target differs from target_path."
            )
        path = target
        external = True
    else:
        # An undeclared external symlink is not accepted.  The explicit target is
        # what makes the receipt/allow-list boundary auditable.
        if link_path.is_symlink():
            resolved = link_path.resolve()
            try:
                resolved.relative_to(reference_root.resolve())
            except ValueError as exc:
                raise StartupValidationError(
                    f"External {label} symlink requires an exact target_path declaration."
                ) from exc
        path = link_path.resolve()
        external = False
    if not path.is_file():
        raise StartupValidationError(f"Declared {label} file is missing: {path}")
    digest = str(value.get("sha256", "")).lower()
    if not SHA256_RE.fullmatch(digest):
        raise StartupValidationError(f"Declared {label} lacks a valid SHA-256.")
    try:
        declared_size = int(value["size"])
    except (KeyError, TypeError, ValueError) as exc:
        raise StartupValidationError(f"Declared {label} lacks an integer size.") from exc
    if declared_size != path.stat().st_size:
        raise StartupValidationError(
            f"Declared {label} size does not match the current file."
        )
    return _DeclaredArtifact(public_name, path, digest, declared_size, external)


def _load_reference(
    package_root: Path,
    outer_manifest: Mapping[str, Any],
    *,
    full_verify: bool,
) -> ReferencePackage | None:
    outer_reference = outer_manifest.get("reference")
    if not isinstance(outer_reference, dict):
        outer_reference = {}
    available = _as_bool(outer_reference.get("available", False))
    if not available:
        # Transcript models, transcript/protein sequences, and protein-feature
        # projections are complete without the optional whole-genome FASTA.
        # Keep reference range serving capability-scoped instead of blocking a
        # full annotation package at startup.
        return None

    reference_root_raw = str(outer_reference.get("directory", "reference"))
    reference_root_lexical = _safe_lexical_child(
        package_root, reference_root_raw
    )
    if reference_root_lexical.is_symlink() or not reference_root_lexical.is_dir():
        raise StartupValidationError(
            f"Reference directory is missing or unsafe: {reference_root_lexical}"
        )
    reference_root = reference_root_lexical.resolve()

    reference_manifest_name = str(
        outer_reference.get("manifest", "reference_manifest.json")
    )
    reference_manifest_path = _regular_internal_file(
        reference_root,
        reference_manifest_name,
        label="Reference manifest",
    )
    reference_manifest = _read_json(
        reference_manifest_path, label="reference manifest"
    )
    metadata = {**reference_manifest, **outer_reference}
    if not _as_bool(metadata.get("verified", False)):
        raise StartupValidationError(
            "Reference manifest is not marked checksum-verified. Rebuild the reference package."
        )
    assembly = str(metadata.get("assembly", outer_manifest.get("assembly", "")))
    if assembly != "GRCh38.p14":
        raise StartupValidationError(
            f"Reference assembly is {assembly or '<missing>'}; expected GRCh38.p14."
        )

    # Preferred manifest contract: every public reference artifact is declared
    # explicitly, including the exact external target of any package symlink.
    fasta_declaration = reference_manifest.get("fasta")
    index_declaration = reference_manifest.get("index")
    chrom_declaration = reference_manifest.get("chrom_sizes")
    if all(
        isinstance(value, dict)
        for value in (fasta_declaration, index_declaration, chrom_declaration)
    ):
        primary_artifact = _declared_artifact(
            reference_root, fasta_declaration, label="whole-genome FASTA"
        )
        index_artifact = _declared_artifact(
            reference_root, index_declaration, label="FASTA index"
        )
        chrom_artifact = _declared_artifact(
            reference_root, chrom_declaration, label="chrom.sizes"
        )
        lower_name = primary_artifact.public_name.lower()
        if lower_name.endswith((".fa.gz", ".fasta.gz")):
            kind = "bgzf_fasta"
            gzi_declaration = reference_manifest.get("gzi")
            if not isinstance(gzi_declaration, dict):
                raise StartupValidationError(
                    "BGZF FASTA reference manifest must declare its GZI index."
                )
            gzi_artifact = _declared_artifact(
                reference_root, gzi_declaration, label="BGZF GZI index"
            )
            extra_required = [gzi_artifact]
        elif lower_name.endswith((".fa", ".fasta")):
            kind = "fasta"
            gzi_artifact = None
            extra_required = []
        else:
            raise StartupValidationError(
                "Declared FASTA public_name must end in .fa/.fasta or BGZF .fa.gz/.fasta.gz."
            )

        required_artifacts = [
            primary_artifact,
            index_artifact,
            chrom_artifact,
            *extra_required,
        ]
        optional_artifacts: list[_DeclaredArtifact] = []
        aliases_declaration = reference_manifest.get("aliases")
        if isinstance(aliases_declaration, dict):
            optional_artifacts.append(
                _declared_artifact(
                    reference_root, aliases_declaration, label="chromosome aliases"
                )
            )
        all_artifacts = [*required_artifacts, *optional_artifacts]
        artifact_paths = {
            artifact.public_name: artifact.path for artifact in all_artifacts
        }
        expected = {
            artifact.public_name: artifact.sha256 for artifact in all_artifacts
        }
        receipt_name = str(
            reference_manifest.get("verification_receipt", "verification_receipt.json")
        )
        receipt_path = _regular_internal_file(
            reference_root,
            receipt_name,
            label="Reference verification receipt",
        )
        _validate_receipt(
            receipt_path,
            artifact_paths,
            expected,
            external_artifacts=frozenset(
                artifact.public_name for artifact in all_artifacts if artifact.external
            ),
            full_verify=full_verify,
        )
        return ReferencePackage(
            root=reference_root,
            primary=primary_artifact.path,
            primary_public_name=primary_artifact.public_name,
            fai_public_name=index_artifact.public_name,
            gzi_public_name=(
                gzi_artifact.public_name if gzi_artifact is not None else None
            ),
            chrom_sizes=chrom_artifact.path,
            chrom_sizes_public_name=chrom_artifact.public_name,
            allowed_files=artifact_paths,
            checksums=expected,
            kind=kind,
        )

    primary = _resolve_primary(reference_root, metadata)
    chrom_sizes = _resolve_chrom_sizes(reference_root, metadata)
    for label, path in (("whole-genome reference", primary), ("chrom.sizes", chrom_sizes)):
        if not path.is_file() or path.is_symlink():
            raise StartupValidationError(f"{label} file is missing or unsafe: {path}")

    lower_name = primary.name.lower()
    if lower_name.endswith(".2bit"):
        kind = "2bit"
        indexes: list[Path] = []
    elif lower_name.endswith((".fa.gz", ".fasta.gz")):
        kind = "bgzf_fasta"
        indexes = [Path(str(primary) + ".fai"), Path(str(primary) + ".gzi")]
    elif lower_name.endswith((".fa", ".fasta")):
        kind = "fasta"
        indexes = [Path(str(primary) + ".fai")]
    else:
        raise StartupValidationError(
            "Whole-genome reference must be .2bit, .fa/.fasta, or BGZF .fa.gz/.fasta.gz."
        )
    for index in indexes:
        if not index.is_file() or index.is_symlink():
            raise StartupValidationError(f"Required reference index is missing: {index}")

    checksum_name = str(metadata.get("checksums_file", "checksums.sha256"))
    checksum_path = _safe_child(reference_root, checksum_name)
    checksums = _load_checksum_file(checksum_path, reference_root)
    inline = metadata.get("checksums")
    if isinstance(inline, dict):
        for name, digest in inline.items():
            if SHA256_RE.fullmatch(str(digest)):
                checksums[str(name)] = str(digest).lower()
                checksums[Path(str(name)).name] = str(digest).lower()

    required_files = [primary, chrom_sizes, *indexes]
    expected: dict[Path, str] = {}
    for path in required_files:
        digest = _expected_checksum(path, reference_root, metadata, checksums)
        if digest is None:
            raise StartupValidationError(
                f"No pinned SHA-256 is recorded for reference artifact {path.name}."
            )
        expected[path] = digest

    receipt_name = str(metadata.get("verification_receipt", "verification_receipt.json"))
    receipt_path = _regular_internal_file(
        reference_root,
        receipt_name,
        label="Reference verification receipt",
    )
    artifact_paths = {path.relative_to(reference_root).as_posix(): path for path in required_files}
    expected_by_name = {
        path.relative_to(reference_root).as_posix(): digest
        for path, digest in expected.items()
    }
    _validate_receipt(
        receipt_path,
        artifact_paths,
        expected_by_name,
        external_artifacts=frozenset(),
        full_verify=full_verify,
    )

    allowed_files: dict[str, Path] = {}
    for path in [*required_files, reference_manifest_path, checksum_path, receipt_path]:
        if path.is_file() and not path.is_symlink():
            allowed_files[path.relative_to(reference_root).as_posix()] = path
    return ReferencePackage(
        root=reference_root,
        primary=primary,
        primary_public_name=primary.relative_to(reference_root).as_posix(),
        fai_public_name=(
            indexes[0].relative_to(reference_root).as_posix() if indexes else None
        ),
        gzi_public_name=(
            indexes[1].relative_to(reference_root).as_posix()
            if len(indexes) > 1
            else None
        ),
        chrom_sizes=chrom_sizes,
        chrom_sizes_public_name=chrom_sizes.relative_to(reference_root).as_posix(),
        allowed_files=allowed_files,
        checksums=expected_by_name,
        kind=kind,
    )


def _load_validation_report(
    package_root: Path,
    manifest: Mapping[str, Any],
    *,
    required: bool,
) -> Mapping[str, Any] | None:
    report_path = package_root / "validation_report.json"
    if not report_path.exists():
        if required:
            raise StartupValidationError(
                "Full build validation_report.json is missing. Rerun "
                "scripts/build_annotations.sh before normal startup."
            )
        return None
    if report_path.is_symlink() or not report_path.is_file():
        raise StartupValidationError(
            "validation_report.json must be a regular in-package file."
        )
    report = _read_json(report_path, label="build validation report")
    if not _as_bool(report.get("passed", False)):
        raise StartupValidationError(
            "The annotation build validation report is not marked passed. "
            "Inspect validation_report.json and rebuild before startup."
        )
    expected = {
        "build_hash": str(_first(manifest, "build_hash", "buildHash", default="")),
        "schema_version": str(
            _first(manifest, "schema_version", "schemaVersion", default="")
        ),
        "scope": str(manifest.get("scope", "")),
    }
    for key, value in expected.items():
        if value and str(report.get(key, "")) != value:
            raise StartupValidationError(
                f"Validation report {key} does not match manifest.json. "
                "The package may be incomplete or mixed."
            )
    for key in ("counts", "content_hashes"):
        manifest_value = manifest.get(key)
        report_value = report.get(key)
        if required and (
            not isinstance(manifest_value, dict)
            or not manifest_value
            or not isinstance(report_value, dict)
            or not report_value
        ):
            raise StartupValidationError(
                f"Full release manifest and validation report require non-empty {key}."
            )
        if manifest_value is not None and report_value is not None and manifest_value != report_value:
            raise StartupValidationError(
                f"Validation report {key} does not match manifest.json."
            )
    return report


def _validate_full_release_contract(
    database: AnnotationDatabase,
    manifest: Mapping[str, Any],
) -> None:
    if str(manifest.get("scope", "")).lower() != "full":
        raise StartupValidationError(
            "Normal mode requires a completed scope=full annotation package. "
            "Build it with scripts/build_annotations.sh --scope full, or use "
            "--dev-fixture for the labeled SP1 technical preview."
        )
    capabilities = manifest.get("capabilities")
    if not isinstance(capabilities, dict) or not _as_bool(
        capabilities.get("full_annotation", capabilities.get("fullAnnotation", False))
    ):
        raise StartupValidationError(
            "Normal mode requires capabilities.full_annotation=true from the full build."
        )
    required_density_columns = frozenset(
        {
            "contig",
            "tile_size",
            "tile_start0",
            "tile_end0",
            "gene_count",
            "transcript_count",
        }
    )
    if not database.table_exists("density_tile"):
        raise StartupValidationError(
            "Full build is missing density_tile. Rebuild annotations for broad-locus LOD."
        )
    missing = required_density_columns - database.table_columns("density_tile")
    if missing:
        raise StartupValidationError(
            "Full build density_tile is incompatible; missing columns: "
            + ", ".join(sorted(missing))
        )
    levels = {
        int(row["tile_size"])
        for row in database.fetch_all(
            "SELECT DISTINCT tile_size FROM density_tile ORDER BY tile_size"
        )
    }
    expected_levels = set(DENSITY_TILE_LEVELS)
    if levels != expected_levels:
        raise StartupValidationError(
            "Full build density levels are incomplete; expected "
            + ", ".join(str(value) for value in DENSITY_TILE_LEVELS)
            + "."
        )
    counts = manifest.get("counts")
    if not isinstance(counts, dict):
        raise StartupValidationError("Full build manifest lacks canonical table counts.")
    for table in ("gene", "transcript", "density_tile"):
        try:
            count = int(counts.get(table, 0))
        except (TypeError, ValueError) as exc:
            raise StartupValidationError(
                f"Full build manifest has an invalid {table} count."
            ) from exc
        if count <= 0:
            raise StartupValidationError(
                f"Full build manifest has no positive {table} count."
            )


def load_runtime_package(
    package_root: Path,
    *,
    dev_fixture: bool,
    full_reference_verify: bool = False,
    full_database_verify: bool = False,
) -> RuntimePackage:
    lexical_root = package_root.expanduser().absolute()
    if lexical_root.is_symlink():
        raise StartupValidationError(
            f"Data package directory must not be a symbolic link: {lexical_root}"
        )
    if not lexical_root.is_dir():
        raise StartupValidationError(f"Data package is missing or unsafe: {lexical_root}")
    package_root = lexical_root.resolve()
    manifest_path = package_root / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise StartupValidationError(
            f"Build manifest must be a regular in-package file: {manifest_path}"
        )
    manifest = _read_json(manifest_path, label="build manifest")
    database = AnnotationDatabase(package_root / "annotation.sqlite")
    database_metadata = database.validate(full_integrity=full_database_verify)

    external_schema = str(
        _first(manifest, "schema_version", "schemaVersion", default="")
    )
    external_hash = str(_first(manifest, "build_hash", "buildHash", default=""))
    if external_schema != EXPECTED_SCHEMA_VERSION:
        raise StartupValidationError(
            f"Build manifest schema version {external_schema or '<missing>'} is unsupported; "
            f"expected {EXPECTED_SCHEMA_VERSION}."
        )
    if external_hash != database_metadata.build_hash:
        raise StartupValidationError(
            "Build hash mismatch between manifest.json and annotation.sqlite; "
            "the package may be incomplete or mixed."
        )

    expected_release_metadata = {
        "release": "GENCODE v45",
        "ensembl_release": "111",
        "assembly": "GRCh38.p14",
    }
    external_metadata = {
        "release": _first(
            manifest, "release", "gencode_release", "gencodeRelease", default=""
        ),
        "ensembl_release": _first(
            manifest, "ensembl_release", "ensemblRelease", default=""
        ),
        "assembly": _first(manifest, "assembly", default=""),
    }
    internal_metadata = {
        "release": _first(
            database_metadata.values,
            "release",
            "gencode_release",
            "gencodeRelease",
            default="",
        ),
        "ensembl_release": _first(
            database_metadata.values,
            "ensembl_release",
            "ensemblRelease",
            default="",
        ),
        "assembly": _first(database_metadata.values, "assembly", default=""),
    }
    for key, expected in expected_release_metadata.items():
        external = str(external_metadata[key])
        internal = str(internal_metadata[key])
        if external != expected:
            raise StartupValidationError(
                f"Annotation {key} is {external or '<missing>'}; expected {expected}."
            )
        if internal != expected:
            raise StartupValidationError(
                f"Annotation database {key} is {internal or '<missing>'}; "
                f"expected {expected}."
            )

    technical_preview = _as_bool(
        _first(manifest, "technical_preview", "technicalPreview", default=False)
    )
    db_preview = _as_bool(database_metadata.values.get("technical_preview", False))
    if technical_preview != db_preview:
        raise StartupValidationError(
            "technical_preview differs between manifest.json and annotation.sqlite."
        )
    if dev_fixture and not technical_preview:
        raise StartupValidationError(
            "--dev-fixture requires a manifest explicitly marked technical_preview=true."
        )
    if not dev_fixture and technical_preview:
        raise StartupValidationError(
            "A technical-preview fixture cannot run in normal mode. Use --dev-fixture."
        )

    validation_report = _load_validation_report(
        package_root,
        manifest,
        required=not dev_fixture,
    )
    if not dev_fixture:
        _validate_full_release_contract(database, manifest)

    reference = _load_reference(
        package_root,
        manifest,
        full_verify=full_reference_verify,
    )
    return RuntimePackage(
        root=package_root,
        manifest_path=manifest_path,
        manifest=manifest,
        database=database,
        database_metadata=database_metadata,
        validation_report=validation_report,
        build_hash=external_hash,
        technical_preview=technical_preview,
        reference=reference,
    )
