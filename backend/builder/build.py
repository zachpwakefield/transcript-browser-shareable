"""Command-line deterministic GENCODE v45 annotation builder.

The SP1 scope is a vertical acceptance fixture built from the authoritative raw
GTF and FASTAs. The full scope uses the same streaming path and refuses to run
without the checksum-pinned local GRCh38.p14 reference.
"""

from __future__ import annotations

import argparse
import csv
import fcntl
import gzip
import hashlib
import json
import os
import platform
import resource
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterator

from .constants import (
    ASSEMBLY,
    BUILDER_VERSION,
    DENSITY_TILE_SIZES,
    ENSEMBL_RELEASE,
    EXPECTED_FEATURE_AUDIT,
    EXPECTED_GTF_FEATURE_ROWS,
    EXPECTED_GTF_TOTAL_ROWS,
    EXPECTED_PC_TRANSCRIPT_FASTA_RECORDS,
    EXPECTED_PC_TRANSLATION_FASTA_RECORDS,
    FEATURE_INPUT_SHA256,
    FEATURE_SOURCES,
    GENCODE_RELEASE,
    OFFICIAL_GENCODE_PRIMARY_GENOME_GZ_MD5,
    PRIMARY_CONTIG_LENGTHS,
    REFERENCE_FASTA_SHA256,
    REFERENCE_FAI_SHA256,
    REFERENCE_PROVENANCE,
    REQUIRED_INPUTS,
    SCHEMA_VERSION,
    fasta_contig_name,
)
from .parsers import (
    file_digest,
    first,
    parse_gtf_attributes,
    parse_protein_fasta_header,
    parse_raw_bounding_span,
    parse_transcript_fasta_header,
    proteins_equivalent,
    split_versioned_id,
    stream_fasta,
    translate_dna,
    ucsc_bin,
)
from .projection import CodingPiece, ProjectionError, project_amino_acid_interval
from .schema import (
    canonical_table_hashes,
    connect_database,
    create_indexes,
    create_schema,
    finalize_gtf_geometry,
    populate_density_tiles,
    populate_search,
)


class BuildError(RuntimeError):
    pass


def progress(message: str) -> None:
    print(f"[annotation-builder] {message}", file=sys.stderr, flush=True)


def deterministic_timestamp(source_file: Path) -> str:
    """Return SOURCE_DATE_EPOCH or the authoritative GTF mtime as stable build time."""

    raw_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    epoch = int(raw_epoch) if raw_epoch is not None else int(source_file.stat().st_mtime)
    return datetime.fromtimestamp(epoch, timezone.utc).replace(microsecond=0).isoformat()


def write_json(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )


@contextmanager
def build_lock(output_root: Path) -> Iterator[None]:
    # Desktop may be managed by FileProvider/iCloud, which can rename an
    # O_EXCL-created marker to `.annotation-build 2.lock` during a concurrent
    # publish. Use a stable local advisory lock keyed to the resolved output
    # root; the kernel releases it even after a crash.
    lock_key = hashlib.sha256(str(output_root.resolve()).encode("utf-8")).hexdigest()[:24]
    lock_path = Path(tempfile.gettempdir()) / f"transcript-browser-build-{lock_key}.lock"
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(descriptor)
        raise BuildError(
            f"Another annotation build owns the lock for {output_root} ({lock_path})"
        ) from error
    try:
        os.ftruncate(descriptor, 0)
        os.write(descriptor, f"pid={os.getpid()}\noutput={output_root}\n".encode("utf-8"))
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def validate_source_inputs(source: Path) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    missing = [name for name in [*REQUIRED_INPUTS, *FEATURE_SOURCES.values()] if not (source / name).is_file()]
    if missing:
        raise BuildError(f"Missing annotation inputs: {', '.join(missing)}")

    for filename, expected_md5 in REQUIRED_INPUTS.items():
        path = source / filename
        actual_md5 = file_digest(path, "md5")
        if actual_md5 != expected_md5:
            raise BuildError(
                f"Checksum mismatch for {path}: expected {expected_md5}, got {actual_md5}"
            )
        results[filename] = {
            "path": filename,
            "size": path.stat().st_size,
            "md5": actual_md5,
            "verified": True,
        }

    for filename in FEATURE_SOURCES.values():
        path = source / filename
        actual_sha256 = file_digest(path, "sha256")
        expected_sha256 = FEATURE_INPUT_SHA256[filename]
        if actual_sha256 != expected_sha256:
            raise BuildError(
                f"Checksum mismatch for {path}: expected {expected_sha256}, "
                f"got {actual_sha256}"
            )
        results[filename] = {
            "path": filename,
            "size": path.stat().st_size,
            "sha256": actual_sha256,
            "verified": True,
        }
    return results


def validate_r_environment(project_root: Path, rscript: str) -> None:
    expression = (
        "source(commandArgs(trailingOnly=TRUE)[1]); "
        "run_dependency_preflight(commandArgs(trailingOnly=TRUE)[2], "
        "commandArgs(trailingOnly=TRUE)[3])"
    )
    command = [
        rscript,
        "-e",
        expression,
        str(project_root / "r" / "preflight.R"),
        str(project_root / "r" / "dependencies.lock.tsv"),
        str(project_root / "r" / "renv.lock"),
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            cwd=project_root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise BuildError(f"R preflight could not start: {error}") from error
    if result.returncode:
        details = result.stderr.strip() or result.stdout.strip()
        raise BuildError(f"R preflight failed before annotation ingestion: {details}")


def parse_fai(path: Path) -> dict[str, int]:
    contigs: dict[str, int] = {}
    with path.open("rt", encoding="ascii") as handle:
        for line in handle:
            fields = line.rstrip("\n").split("\t")
            if len(fields) < 2:
                raise BuildError(f"Malformed FAI row in {path}: {line!r}")
            contigs[fields[0]] = int(fields[1])
    return contigs


def validate_reference(reference_fasta: Path) -> dict[str, Any]:
    reference_fasta = reference_fasta.resolve()
    reference_fai = Path(f"{reference_fasta}.fai")
    if not reference_fasta.is_file() or not reference_fai.is_file():
        raise BuildError(
            f"GRCh38.p14 reference requires {reference_fasta} and {reference_fai}"
        )

    fasta_hash = file_digest(reference_fasta, "sha256")
    if fasta_hash != REFERENCE_FASTA_SHA256:
        raise BuildError(
            f"Reference SHA-256 mismatch: expected {REFERENCE_FASTA_SHA256}, got {fasta_hash}"
        )
    fai_hash = file_digest(reference_fai, "sha256")
    if fai_hash != REFERENCE_FAI_SHA256:
        raise BuildError(
            f"Reference FAI SHA-256 mismatch: expected {REFERENCE_FAI_SHA256}, got {fai_hash}"
        )

    fai_contigs = parse_fai(reference_fai)
    length_errors = []
    for canonical_name, expected_length in PRIMARY_CONTIG_LENGTHS.items():
        fasta_name = fasta_contig_name(canonical_name)
        actual_length = fai_contigs.get(fasta_name)
        if actual_length != expected_length:
            length_errors.append(
                f"{canonical_name}/{fasta_name}: expected {expected_length}, got {actual_length}"
            )
    if length_errors:
        raise BuildError("Reference primary-contig mismatch: " + "; ".join(length_errors))

    return {
        "fasta_path": reference_fasta,
        "fai_path": reference_fai,
        "fasta_sha256": fasta_hash,
        "fai_sha256": fai_hash,
        "fasta_stat": reference_fasta.stat(),
        "fai_stat": reference_fai.stat(),
        "fai_contig_count": len(fai_contigs),
    }


def _receipt_entry(
    path: Path,
    sha256: str,
    *,
    lexical_path: str | None = None,
    external: bool,
) -> dict[str, Any]:
    stat = path.stat()
    public_name = lexical_path or path.name
    record = {
        "path": str(path) if external else path.name,
        "public_name": public_name,
        "link_path": public_name,
        "external": external,
        "sha256": sha256,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "inode": stat.st_ino,
        "device": stat.st_dev,
    }
    if external:
        record["target_path"] = str(path)
    return record


def write_reference_package(
    build_directory: Path,
    reference: dict[str, Any],
    build_timestamp: str,
) -> dict[str, Any]:
    reference_directory = build_directory / "reference"
    reference_directory.mkdir(parents=True, exist_ok=True)
    fasta_link = reference_directory / "genome.fa"
    fai_link = reference_directory / "genome.fa.fai"
    fasta_link.symlink_to(reference["fasta_path"])
    fai_link.symlink_to(reference["fai_path"])

    chrom_sizes_path = reference_directory / "GRCh38.p14.primary.chrom.sizes"
    chrom_sizes_path.write_text(
        "".join(f"{name}\t{length}\n" for name, length in PRIMARY_CONTIG_LENGTHS.items()),
        encoding="ascii",
    )
    aliases_path = reference_directory / "chrom_aliases.tsv"
    aliases_path.write_text(
        "canonical\tfasta_name\taliases\n"
        + "".join(
            f"{canonical}\t{fasta_contig_name(canonical)}\t"
            f"{fasta_contig_name(canonical)},{canonical}\n"
            for canonical in PRIMARY_CONTIG_LENGTHS
        ),
        encoding="ascii",
    )
    chrom_sizes_hash = file_digest(chrom_sizes_path, "sha256")
    aliases_hash = file_digest(aliases_path, "sha256")

    receipt = {
        "algorithm": "sha256",
        "verified_at_build": build_timestamp,
        "files": {
            "genome.fa": _receipt_entry(
                reference["fasta_path"],
                reference["fasta_sha256"],
                lexical_path="genome.fa",
                external=True,
            ),
            "genome.fa.fai": _receipt_entry(
                reference["fai_path"],
                reference["fai_sha256"],
                lexical_path="genome.fa.fai",
                external=True,
            ),
            "GRCh38.p14.primary.chrom.sizes": _receipt_entry(
                chrom_sizes_path, chrom_sizes_hash, external=False
            ),
            "chrom_aliases.tsv": _receipt_entry(aliases_path, aliases_hash, external=False),
        },
    }
    write_json(reference_directory / "verification_receipt.json", receipt)

    manifest = {
        "assembly": ASSEMBLY,
        "verified": True,
        "verification_receipt": "verification_receipt.json",
        "provenance": REFERENCE_PROVENANCE,
        "official_gencode_primary_genome_gz_md5_provenance_only": (
            OFFICIAL_GENCODE_PRIMARY_GENOME_GZ_MD5
        ),
        "fasta": {
            "public_name": "genome.fa",
            "link_path": "genome.fa",
            "target_path": str(reference["fasta_path"]),
            "sha256": reference["fasta_sha256"],
            "size": reference["fasta_stat"].st_size,
        },
        "index": {
            "public_name": "genome.fa.fai",
            "link_path": "genome.fa.fai",
            "target_path": str(reference["fai_path"]),
            "sha256": reference["fai_sha256"],
            "size": reference["fai_stat"].st_size,
        },
        "chrom_sizes": {
            "public_name": chrom_sizes_path.name,
            "path": chrom_sizes_path.name,
            "sha256": chrom_sizes_hash,
            "size": chrom_sizes_path.stat().st_size,
            "contig_count": len(PRIMARY_CONTIG_LENGTHS),
        },
        "aliases": {
            "public_name": aliases_path.name,
            "path": aliases_path.name,
            "sha256": aliases_hash,
            "size": aliases_path.stat().st_size,
        },
        "fai_contig_count": reference["fai_contig_count"],
    }
    write_json(reference_directory / "reference_manifest.json", manifest)
    return manifest


def insert_contigs(connection: sqlite3.Connection) -> None:
    for order, (name, length) in enumerate(PRIMARY_CONTIG_LENGTHS.items(), start=1):
        fasta_name = fasta_contig_name(name)
        connection.execute(
            "INSERT INTO contig(name,length,display_order,is_primary,fasta_name) VALUES(?,?,?,?,?)",
            (name, length, order, 1, fasta_name),
        )
        aliases = {name, fasta_name}
        if name == "chrM":
            aliases.update({"M", "MT", "chrMT"})
        for alias in sorted(aliases):
            connection.execute(
                "INSERT OR IGNORE INTO contig_alias(alias,contig_name) VALUES(?,?)",
                (alias, name),
            )


def _phase(value: str) -> int | None:
    return None if value == "." else int(value)


def ingest_gtf(
    connection: sqlite3.Connection, path: Path, scope: str
) -> dict[str, Any]:
    selected_counts: Counter[str] = Counter()
    header: list[str] = []
    seen_contigs: set[str] = set()
    protein_updates: dict[str, tuple[str, int | None, str]] = {}

    with gzip.open(path, "rt", encoding="utf-8") as handle, connection:
        for raw_line in handle:
            if raw_line.startswith("#"):
                if len(header) < 20:
                    header.append(raw_line.rstrip("\n"))
                continue
            if scope == "sp1" and 'gene_name "SP1"' not in raw_line:
                continue
            fields = raw_line.rstrip("\n").split("\t")
            if len(fields) != 9:
                raise BuildError(f"Malformed GTF row with {len(fields)} columns")
            contig, _source, feature_type, start_text, end_text, _score, strand, phase_text, raw_attrs = fields
            attributes = parse_gtf_attributes(raw_attrs)
            if scope == "sp1" and first(attributes, "gene_name") != "SP1":
                continue
            if contig not in PRIMARY_CONTIG_LENGTHS:
                raise BuildError(f"Unexpected GTF contig {contig!r}")
            start0 = int(start_text) - 1
            end0 = int(end_text)
            if end0 > PRIMARY_CONTIG_LENGTHS[contig]:
                raise BuildError(f"GTF interval exceeds {contig} length")
            seen_contigs.add(contig)
            selected_counts[feature_type] += 1

            gene_base, gene_version, gene_versioned = split_versioned_id(first(attributes, "gene_id"))
            transcript_base, transcript_version, transcript_versioned = split_versioned_id(
                first(attributes, "transcript_id")
            )
            exon_base, exon_version, exon_versioned = split_versioned_id(first(attributes, "exon_id"))
            tags = attributes.get("tag", [])
            level_text = first(attributes, "level")
            level = int(level_text) if level_text and level_text.isdigit() else None

            if feature_type == "gene":
                if gene_base is None or gene_versioned is None:
                    raise BuildError("Gene row lacks gene_id")
                havana_base, havana_version, havana_versioned = split_versioned_id(
                    first(attributes, "havana_gene")
                )
                connection.execute(
                    "INSERT INTO gene(gene_id,gene_id_versioned,gene_version,symbol,hgnc_id,"
                    "havana_gene_id,havana_gene_id_versioned,havana_gene_version,"
                    "biotype,contig,start0,end0,strand,bin,level) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        gene_base,
                        gene_versioned,
                        gene_version,
                        first(attributes, "gene_name") or gene_base,
                        first(attributes, "hgnc_id"),
                        havana_base,
                        havana_versioned,
                        havana_version,
                        first(attributes, "gene_type") or "unknown",
                        contig,
                        start0,
                        end0,
                        strand,
                        ucsc_bin(start0, end0),
                        level,
                    ),
                )
                connection.executemany(
                    "INSERT INTO gene_tag(gene_id,tag,ordinal) VALUES(?,?,?)",
                    [(gene_base, tag, ordinal) for ordinal, tag in enumerate(tags, start=1)],
                )
                continue

            if feature_type == "transcript":
                if not all((gene_base, transcript_base, transcript_versioned)):
                    raise BuildError("Transcript row lacks stable identifiers")
                appris = next((tag for tag in tags if tag.startswith("appris_")), None)
                havana_base, havana_version, havana_versioned = split_versioned_id(
                    first(attributes, "havana_transcript")
                )
                connection.execute(
                    "INSERT INTO transcript("
                    "transcript_id,transcript_id_versioned,transcript_version,gene_id,"
                    "transcript_name,biotype,havana_transcript_id,havana_transcript_id_versioned,"
                    "havana_transcript_version,contig,start0,end0,strand,bin,level,tsl,ccds_id,"
                    "appris,is_basic,is_mane_select,is_mane_plus_clinical,is_ensembl_canonical"
                    ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        transcript_base,
                        transcript_versioned,
                        transcript_version,
                        gene_base,
                        first(attributes, "transcript_name") or transcript_base,
                        first(attributes, "transcript_type") or "unknown",
                        havana_base,
                        havana_versioned,
                        havana_version,
                        contig,
                        start0,
                        end0,
                        strand,
                        ucsc_bin(start0, end0),
                        level,
                        first(attributes, "transcript_support_level"),
                        first(attributes, "ccdsid"),
                        appris,
                        int("basic" in tags),
                        int("MANE_Select" in tags),
                        int("MANE_Plus_Clinical" in tags),
                        int("Ensembl_canonical" in tags),
                    ),
                )
                connection.executemany(
                    "INSERT INTO transcript_tag(transcript_id,tag,ordinal) VALUES(?,?,?)",
                    [
                        (transcript_base, tag, ordinal)
                        for ordinal, tag in enumerate(tags, start=1)
                    ],
                )
                continue

            if transcript_base is None:
                continue
            exon_number = first(attributes, "exon_number")
            exon_rank = int(exon_number) if exon_number else 1

            if feature_type == "exon":
                connection.execute(
                    "INSERT INTO exon(transcript_id,exon_rank,exon_id,exon_id_versioned,"
                    "exon_version,start0,end0,strand,phase,bin) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        transcript_base,
                        exon_rank,
                        exon_base,
                        exon_versioned,
                        exon_version,
                        start0,
                        end0,
                        strand,
                        _phase(phase_text),
                        ucsc_bin(start0, end0),
                    ),
                )
            elif feature_type in {"CDS", "UTR", "start_codon", "stop_codon", "Selenocysteine"}:
                table = {
                    "CDS": "_cds_raw",
                    "UTR": "_utr_raw",
                    "start_codon": "_codon_raw",
                    "stop_codon": "_codon_raw",
                    "Selenocysteine": "_selenocysteine_raw",
                }[feature_type]
                if table == "_codon_raw":
                    connection.execute(
                        "INSERT INTO _codon_raw(transcript_id,codon_type,exon_rank,start0,end0,strand,phase) "
                        "VALUES(?,?,?,?,?,?,?)",
                        (transcript_base, feature_type, exon_rank, start0, end0, strand, _phase(phase_text)),
                    )
                else:
                    connection.execute(
                        f"INSERT INTO {table}(transcript_id,exon_rank,start0,end0,strand,phase) "
                        "VALUES(?,?,?,?,?,?)",
                        (transcript_base, exon_rank, start0, end0, strand, _phase(phase_text)),
                    )
                if feature_type == "CDS":
                    protein_base, protein_version, protein_versioned = split_versioned_id(
                        first(attributes, "protein_id")
                    )
                    if protein_base and protein_versioned:
                        protein_updates[transcript_base] = (
                            protein_base,
                            protein_version,
                            protein_versioned,
                        )

        connection.executemany(
            "UPDATE transcript SET protein_id=?, protein_version=?, protein_id_versioned=? "
            "WHERE transcript_id=?",
            [(*values, transcript_id) for transcript_id, values in protein_updates.items()],
        )
        finalize_gtf_geometry(connection)

    gene_count = connection.execute("SELECT COUNT(*) FROM gene").fetchone()[0]
    transcript_count = connection.execute("SELECT COUNT(*) FROM transcript").fetchone()[0]
    if scope == "sp1" and (gene_count != 1 or transcript_count != 4):
        raise BuildError(
            f"SP1 source-of-truth failure: expected 1 gene/4 transcripts, got "
            f"{gene_count}/{transcript_count}"
        )
    if scope == "full" and seen_contigs != set(PRIMARY_CONTIG_LENGTHS):
        raise BuildError("Full GTF did not contain the expected 25 primary contigs")
    if scope == "full":
        actual_feature_rows = dict(selected_counts)
        expected_feature_rows = dict(EXPECTED_GTF_FEATURE_ROWS)
        if actual_feature_rows != expected_feature_rows:
            raise BuildError(
                "Full GTF feature-row audit mismatch: expected "
                f"{expected_feature_rows}, got {actual_feature_rows}"
            )
        if sum(selected_counts.values()) != EXPECTED_GTF_TOTAL_ROWS:
            raise BuildError(
                f"Full GTF row audit mismatch: expected {EXPECTED_GTF_TOTAL_ROWS}, "
                f"got {sum(selected_counts.values())}"
            )
        header_text = "\n".join(header)
        for required_header_value in ("version 45", "Ensembl 111", "GRCh38"):
            if required_header_value not in header_text:
                raise BuildError(
                    f"GENCODE release header is missing {required_header_value!r}"
                )
    distinct_ids = {
        "gene": connection.execute("SELECT COUNT(DISTINCT gene_id) FROM gene").fetchone()[0],
        "transcript": connection.execute(
            "SELECT COUNT(DISTINCT transcript_id) FROM transcript"
        ).fetchone()[0],
        "exon": connection.execute(
            "SELECT COUNT(DISTINCT exon_id) FROM exon WHERE exon_id IS NOT NULL"
        ).fetchone()[0],
    }
    return {
        "header": header,
        "total_feature_rows": sum(selected_counts.values()),
        "selected_feature_rows": dict(sorted(selected_counts.items())),
        "distinct_stable_ids": distinct_ids,
        "selected_contigs": sorted(seen_contigs),
    }


def _store_sequence(
    connection: sqlite3.Connection, transcript_id: str, kind: str, sequence: str
) -> None:
    connection.execute(
        "INSERT OR REPLACE INTO sequence(transcript_id,kind,sequence,length,sha256) VALUES(?,?,?,?,?)",
        (
            transcript_id,
            kind,
            sequence,
            len(sequence),
            hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        ),
    )


def ingest_fastas(
    connection: sqlite3.Connection, source: Path
) -> tuple[dict[str, tuple[int, int]], dict[str, Any]]:
    targets = {
        row[0]
        for row in connection.execute("SELECT transcript_id FROM transcript")
    }
    cds_intervals: dict[str, tuple[int, int]] = {}
    transcript_records = 0
    protein_records = 0
    declared_length_errors: list[str] = []

    with connection:
        for record in stream_fasta(source / "gencode.v45.pc_transcripts.fa.gz"):
            metadata = parse_transcript_fasta_header(record.header)
            transcript_id = metadata["transcript_id"]
            if transcript_id not in targets:
                continue
            transcript_records += 1
            declared = metadata.get("declared_length")
            if declared is not None and int(declared) != len(record.sequence):
                declared_length_errors.append(f"{transcript_id}: transcript FASTA length")
            _store_sequence(connection, str(transcript_id), "transcript_full", record.sequence)
            cds_start0 = metadata.get("cds_start0")
            cds_end0 = metadata.get("cds_end0")
            if cds_start0 is not None and cds_end0 is not None:
                start0 = int(cds_start0)
                end0 = int(cds_end0)
                if start0 < 0 or end0 <= start0 or end0 > len(record.sequence):
                    raise BuildError(f"Invalid CDS header interval for {transcript_id}")
                cds_intervals[str(transcript_id)] = (start0, end0)
                _store_sequence(
                    connection,
                    str(transcript_id),
                    "cds",
                    record.sequence[start0:end0],
                )

        for record in stream_fasta(source / "gencode.v45.pc_translations.fa.gz"):
            metadata = parse_protein_fasta_header(record.header)
            transcript_id = metadata["transcript_id"]
            if transcript_id not in targets:
                continue
            protein_records += 1
            declared = metadata.get("declared_length")
            if declared is not None and int(declared) != len(record.sequence):
                declared_length_errors.append(f"{transcript_id}: protein FASTA length")
            _store_sequence(connection, str(transcript_id), "protein", record.sequence)
            connection.execute(
                "UPDATE transcript SET protein_id=?,protein_id_versioned=?,protein_version=?,"
                "protein_length=? WHERE transcript_id=?",
                (
                    metadata["protein_id"],
                    metadata["protein_id_versioned"],
                    metadata["protein_version"],
                    len(record.sequence),
                    transcript_id,
                ),
            )
    if declared_length_errors:
        raise BuildError("; ".join(declared_length_errors))
    return cds_intervals, {
        "transcript_records_selected": transcript_records,
        "protein_records_selected": protein_records,
    }


def _segments_are_contiguous(rows: list[sqlite3.Row], start0: int, allowed_ends: set[int]) -> bool:
    if not rows or rows[0]["transcript_start0"] != start0:
        return False
    cursor = start0
    for row in rows:
        if row["transcript_start0"] != cursor:
            return False
        cursor = row["transcript_end0"]
    return cursor in allowed_ends


def classify_translation_mappings(
    connection: sqlite3.Connection, cds_intervals: dict[str, tuple[int, int]]
) -> dict[str, int]:
    statuses: Counter[str] = Counter()
    translated_ids = [
        row[0]
        for row in connection.execute(
            "SELECT transcript_id FROM transcript WHERE protein_id IS NOT NULL "
            "OR EXISTS(SELECT 1 FROM cds_segment WHERE cds_segment.transcript_id=transcript.transcript_id) "
            "ORDER BY transcript_id"
        )
    ]
    with connection:
        for transcript_id in translated_ids:
            interval = cds_intervals.get(transcript_id)
            sequences = {
                row["kind"]: row["sequence"]
                for row in connection.execute(
                    "SELECT kind,sequence FROM sequence WHERE transcript_id=?",
                    (transcript_id,),
                )
            }
            protein = sequences.get("protein")
            cds = sequences.get("cds")
            transcript_full = sequences.get("transcript_full")
            rows = connection.execute(
                "SELECT segment_rank,transcript_start0,transcript_end0 FROM cds_segment "
                "WHERE transcript_id=? ORDER BY segment_rank",
                (transcript_id,),
            ).fetchall()

            status = "unresolved"
            reason = "missing authoritative transcript/CDS/protein sequence"
            cds_start0 = interval[0] if interval else None
            cds_end0 = interval[1] if interval else None
            if interval and cds is not None and protein is not None:
                raw_allowed_ends = {cds_end0, cds_end0 - 3}
                geometry_ok = _segments_are_contiguous(rows, cds_start0, raw_allowed_ends)
                frame_ok = len(cds) % 3 == 0
                translation_ok = proteins_equivalent(translate_dna(cds), protein)
                if geometry_ok and frame_ok and translation_ok:
                    status = "exact"
                    reason = "authoritative FASTA translation and GTF CDS geometry agree"
                else:
                    status = "partial"
                    failures = []
                    if not geometry_ok:
                        failures.append("GTF CDS geometry differs from FASTA CDS interval")
                    if not frame_ok:
                        failures.append("FASTA CDS length is not divisible by three")
                    if not translation_ok:
                        failures.append("translated FASTA CDS differs from supplied protein")
                    reason = "; ".join(failures)

            connection.execute(
                "INSERT INTO translation_mapping(transcript_id,cds_start0,cds_end0,status,reason,"
                "validated_nt_length,protein_length) VALUES(?,?,?,?,?,?,?)",
                (
                    transcript_id,
                    cds_start0,
                    cds_end0,
                    status,
                    reason,
                    len(cds) if cds is not None else None,
                    len(protein) if protein is not None else None,
                ),
            )
            statuses[status] += 1
            if status == "exact":
                # GENCODE transcript FASTA CDS headers may include a terminal stop
                # triplet, while GTF CDS rows deliberately exclude it. Runtime
                # `kind=cds` is the translated GTF coding slice; the original
                # header bounds remain recorded on translation_mapping.
                gtf_cds_end0 = rows[-1]["transcript_end0"]
                gtf_cds = transcript_full[cds_start0:gtf_cds_end0]
                _store_sequence(connection, transcript_id, "cds", gtf_cds)
                connection.execute(
                    "UPDATE cds_segment SET coding_start0=transcript_start0-?,"
                    "coding_end0=transcript_end0-? WHERE transcript_id=?",
                    (cds_start0, cds_start0, transcript_id),
                )
    return dict(sorted(statuses.items()))


def run_feature_export(
    project_root: Path,
    source: Path,
    export_directory: Path,
    transcript_ids: list[str],
    rscript: str,
) -> dict[str, Any]:
    transcript_file = export_directory.parent / "selected_transcripts.txt"
    transcript_file.write_text("".join(f"{item}\n" for item in sorted(transcript_ids)), encoding="ascii")
    command = [
        rscript,
        str(project_root / "r" / "export_features.R"),
        "--input",
        str(source),
        "--output",
        str(export_directory),
        "--transcripts",
        str(transcript_file),
    ]
    try:
        subprocess.run(command, check=True, cwd=project_root)
    except (OSError, subprocess.CalledProcessError) as error:
        raise BuildError(f"R feature export failed: {error}") from error
    return json.loads((export_directory / "feature_export_manifest.json").read_text())


def _canonical_feature_key(source: str, row: dict[str, str]) -> str:
    columns = (
        "ensembl_transcript_id",
        "start",
        "stop",
        "chr",
        "strand",
        "feature_id",
        "clean_name",
        "alt_name",
        "database",
        "ensembl_peptide_id",
        "method",
        "name",
    )
    return "\x1f".join([source, *(row.get(column, "") or "" for column in columns)])


def _normalise_chromosome(value: str | None) -> str | None:
    if not value:
        return None
    if value in {"M", "MT", "chrMT"}:
        return "chrM"
    return value if value.startswith("chr") else f"chr{value}"


def _strict_integer(value: str | None) -> int:
    """Parse a coordinate without silently truncating a fractional value."""

    if value is None or not value.strip():
        raise ValueError("missing coordinate")
    try:
        parsed = Decimal(value.strip())
    except InvalidOperation as error:
        raise ValueError(f"invalid coordinate {value!r}") from error
    if not parsed.is_finite() or parsed != parsed.to_integral_value():
        raise ValueError(f"fractional coordinate {value!r}")
    return int(parsed)


def import_features(
    connection: sqlite3.Connection, export_directory: Path
) -> dict[str, Any]:
    transcript_metadata = {
        row["transcript_id"]: row
        for row in connection.execute(
            "SELECT transcript_id,contig,strand,protein_id,protein_id_versioned,"
            "protein_version,protein_length FROM transcript"
        )
    }
    mapping_status = {
        row["transcript_id"]: row["status"]
        for row in connection.execute("SELECT transcript_id,status FROM translation_mapping")
    }
    coding_pieces: dict[str, list[CodingPiece]] = defaultdict(list)
    for row in connection.execute(
        "SELECT transcript_id,exon_rank,start0,end0,coding_start0,coding_end0,strand "
        "FROM cds_segment WHERE coding_start0 IS NOT NULL ORDER BY transcript_id,segment_rank"
    ):
        coding_pieces[row["transcript_id"]].append(
            CodingPiece(
                row["exon_rank"],
                row["start0"],
                row["end0"],
                row["coding_start0"],
                row["coding_end0"],
                row["strand"],
            )
        )

    counts: Counter[str] = Counter()
    segment_counts: Counter[str] = Counter()
    orphan_rows: list[str] = []
    invalid_rows: list[str] = []
    duplicate_ordinals: Counter[str] = Counter()

    with connection:
        for source in FEATURE_SOURCES:
            path = export_directory / f"{source}.tsv"
            with path.open("rt", encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle, delimiter="\t"):
                    transcript_id, _version, _versioned = split_versioned_id(
                        row.get("ensembl_transcript_id")
                    )
                    if transcript_id not in transcript_metadata:
                        orphan_rows.append(f"{source}:{row.get('ensembl_transcript_id')}")
                        continue
                    metadata = transcript_metadata[str(transcript_id)]
                    try:
                        aa_start1 = _strict_integer(row.get("start"))
                        aa_end1 = _strict_integer(row.get("stop"))
                    except (TypeError, ValueError):
                        invalid_rows.append(f"{source}:{transcript_id}:non-integer coordinates")
                        continue
                    protein_length = metadata["protein_length"]
                    if (
                        protein_length is None
                        or aa_start1 < 1
                        or aa_end1 < aa_start1
                        or aa_end1 > protein_length
                    ):
                        invalid_rows.append(
                            f"{source}:{transcript_id}:{aa_start1}-{aa_end1}/{protein_length}"
                        )
                        continue

                    raw_chrom = _normalise_chromosome(row.get("chr"))
                    raw_strand = row.get("strand") or None
                    if raw_chrom and raw_chrom != metadata["contig"]:
                        invalid_rows.append(f"{source}:{transcript_id}:chromosome mismatch")
                        continue
                    if raw_strand and raw_strand != metadata["strand"]:
                        invalid_rows.append(f"{source}:{transcript_id}:strand mismatch")
                        continue

                    canonical_key = _canonical_feature_key(source, row)
                    source_record_hash = hashlib.sha256(canonical_key.encode("utf-8")).hexdigest()
                    duplicate_ordinals[source_record_hash] += 1
                    duplicate_ordinal = duplicate_ordinals[source_record_hash]
                    feature_id = "pf_" + hashlib.sha256(
                        f"{source_record_hash}\x1f{duplicate_ordinal}".encode("ascii")
                    ).hexdigest()[:24]
                    span_chr, span_start1, span_end1 = parse_raw_bounding_span(row.get("name", ""))
                    protein_base, protein_version, protein_versioned = split_versioned_id(
                        row.get("ensembl_peptide_id")
                    )
                    connection.execute(
                        "INSERT INTO protein_feature("
                        "feature_id,source_record_hash,duplicate_ordinal,transcript_id,"
                        "raw_transcript_id,protein_id,protein_id_versioned,protein_version,"
                        "raw_peptide_id,source,database_name,accession,display_name,alt_name,"
                        "method,aa_start1,aa_end1,raw_name,raw_chr,raw_start1,raw_end1,raw_strand"
                        ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            feature_id,
                            source_record_hash,
                            duplicate_ordinal,
                            transcript_id,
                            row.get("ensembl_transcript_id") or str(transcript_id),
                            protein_base or metadata["protein_id"],
                            protein_versioned or metadata["protein_id_versioned"],
                            protein_version
                            if protein_version is not None
                            else metadata["protein_version"],
                            row.get("ensembl_peptide_id") or None,
                            source,
                            row.get("database") or None,
                            row.get("feature_id") or None,
                            row.get("clean_name") or None,
                            row.get("alt_name") or None,
                            row.get("method") or None,
                            aa_start1,
                            aa_end1,
                            row.get("name") or None,
                            span_chr or raw_chrom,
                            span_start1,
                            span_end1,
                            raw_strand,
                        ),
                    )
                    counts[source] += 1
                    try:
                        projected = project_amino_acid_interval(
                            aa_start1,
                            aa_end1,
                            protein_length,
                            coding_pieces.get(str(transcript_id), []),
                            mapping_status.get(str(transcript_id), "unresolved"),
                        )
                    except ProjectionError as error:
                        invalid_rows.append(f"{feature_id}:{error}")
                        continue
                    connection.executemany(
                        "INSERT INTO protein_feature_segment("
                        "feature_id,segment_rank,exon_rank,start0,end0,nt_start0,nt_end0,bin"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        [
                            (
                                feature_id,
                                piece.segment_rank,
                                piece.exon_rank,
                                piece.start0,
                                piece.end0,
                                piece.nt_start0,
                                piece.nt_end0,
                                ucsc_bin(piece.start0, piece.end0),
                            )
                            for piece in projected
                        ],
                    )
                    segment_counts[source] += len(projected)

    return {
        "feature_counts": {source: counts.get(source, 0) for source in FEATURE_SOURCES},
        "projected_segment_counts": {
            source: segment_counts.get(source, 0) for source in FEATURE_SOURCES
        },
        "orphan_rows": orphan_rows,
        "orphan_row_count": len(orphan_rows),
        "invalid_rows": invalid_rows,
        "invalid_row_count": len(invalid_rows),
    }


def table_counts(connection: sqlite3.Connection) -> dict[str, int]:
    tables = (
        "gene",
        "gene_tag",
        "transcript",
        "transcript_tag",
        "exon",
        "cds_segment",
        "utr_segment",
        "codon_segment",
        "selenocysteine_segment",
        "translation_mapping",
        "sequence",
        "protein_feature",
        "protein_feature_segment",
        "density_tile",
        "search_entity",
    )
    return {
        table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in tables
    }


def translation_mapping_summary(connection: sqlite3.Connection) -> dict[str, Any]:
    statuses = dict(
        connection.execute(
            "SELECT status,COUNT(*) FROM translation_mapping GROUP BY status ORDER BY status"
        ).fetchall()
    )
    reasons = [
        {"status": row[0], "reason": row[1], "transcripts": row[2]}
        for row in connection.execute(
            "SELECT status,reason,COUNT(*) FROM translation_mapping "
            "GROUP BY status,reason ORDER BY status,reason"
        )
    ]
    by_biotype = [
        {"biotype": row[0], "status": row[1], "transcripts": row[2]}
        for row in connection.execute(
            "SELECT transcript.biotype,mapping.status,COUNT(*) "
            "FROM translation_mapping AS mapping "
            "JOIN transcript USING(transcript_id) "
            "GROUP BY transcript.biotype,mapping.status "
            "ORDER BY transcript.biotype,mapping.status"
        )
    ]
    return {"statuses": statuses, "reasons": reasons, "by_biotype": by_biotype}


def feature_projection_summary(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [
        {
            "source": row[0],
            "mapping_status": row[1],
            "features": row[2],
            "features_with_projection": row[3],
            "projected_segments": row[4],
        }
        for row in connection.execute(
            "WITH per_feature AS ("
            " SELECT feature.source,mapping.status,feature.feature_id,"
            " COUNT(segment.segment_rank) AS segment_count"
            " FROM protein_feature AS feature"
            " JOIN translation_mapping AS mapping USING(transcript_id)"
            " LEFT JOIN protein_feature_segment AS segment USING(feature_id)"
            " GROUP BY feature.feature_id"
            ") SELECT source,status,COUNT(*),"
            " SUM(CASE WHEN segment_count>0 THEN 1 ELSE 0 END),SUM(segment_count)"
            " FROM per_feature GROUP BY source,status ORDER BY source,status"
        )
    ]


def validate_projection_integrity(connection: sqlite3.Connection) -> list[str]:
    errors: list[str] = []
    wrong_coverage = connection.execute(
        "SELECT feature.feature_id,3*(feature.aa_end1-feature.aa_start1+1) AS expected,"
        "COALESCE(SUM(segment.nt_end0-segment.nt_start0),0) AS actual "
        "FROM protein_feature AS feature "
        "JOIN translation_mapping AS mapping USING(transcript_id) "
        "LEFT JOIN protein_feature_segment AS segment USING(feature_id) "
        "WHERE mapping.status='exact' GROUP BY feature.feature_id "
        "HAVING actual<>expected LIMIT 10"
    ).fetchall()
    if wrong_coverage:
        errors.append(f"exact feature projection coverage mismatch: {[tuple(row) for row in wrong_coverage]}")

    non_exact_segments = connection.execute(
        "SELECT COUNT(*) FROM protein_feature_segment AS segment "
        "JOIN protein_feature AS feature USING(feature_id) "
        "JOIN translation_mapping AS mapping USING(transcript_id) "
        "WHERE mapping.status<>'exact'"
    ).fetchone()[0]
    if non_exact_segments:
        errors.append(f"non-exact mappings have {non_exact_segments} drawable segments")

    outside_cds = connection.execute(
        "SELECT segment.feature_id,segment.segment_rank FROM protein_feature_segment AS segment "
        "JOIN protein_feature AS feature USING(feature_id) "
        "LEFT JOIN cds_segment AS cds ON cds.transcript_id=feature.transcript_id "
        "AND cds.exon_rank=segment.exon_rank AND segment.start0>=cds.start0 "
        "AND segment.end0<=cds.end0 "
        "WHERE cds.transcript_id IS NULL LIMIT 10"
    ).fetchall()
    if outside_cds:
        errors.append(f"feature segments outside CDS: {[tuple(row) for row in outside_cds]}")

    discontinuities = connection.execute(
        "WITH ordered AS ("
        " SELECT feature_id,segment_rank,nt_start0,"
        " LAG(nt_end0) OVER (PARTITION BY feature_id ORDER BY segment_rank) AS previous_end0,"
        " ROW_NUMBER() OVER (PARTITION BY feature_id ORDER BY segment_rank) AS expected_rank"
        " FROM protein_feature_segment"
        ") SELECT feature_id,segment_rank,nt_start0,previous_end0 FROM ordered "
        "WHERE segment_rank<>expected_rank OR "
        "(previous_end0 IS NOT NULL AND previous_end0<>nt_start0) LIMIT 10"
    ).fetchall()
    if discontinuities:
        errors.append(
            f"feature segment protein-order discontinuity: {[tuple(row) for row in discontinuities]}"
        )
    return errors


def validate_density_tiles(connection: sqlite3.Connection) -> list[str]:
    errors: list[str] = []
    expected_rows = sum(
        (length + tile_size - 1) // tile_size
        for length in PRIMARY_CONTIG_LENGTHS.values()
        for tile_size in DENSITY_TILE_SIZES
    )
    actual_rows = connection.execute("SELECT COUNT(*) FROM density_tile").fetchone()[0]
    if actual_rows != expected_rows:
        errors.append(f"density tile count: expected {expected_rows}, got {actual_rows}")
    invalid_boundaries = connection.execute(
        "SELECT COUNT(*) FROM density_tile AS tile JOIN contig ON contig.name=tile.contig "
        "WHERE tile.tile_start0%tile.tile_size<>0 OR tile.tile_end0>contig.length "
        "OR tile.tile_end0<>MIN(tile.tile_start0+tile.tile_size,contig.length)"
    ).fetchone()[0]
    if invalid_boundaries:
        errors.append(f"density tiles with invalid boundaries: {invalid_boundaries}")
    return errors


def validate_full_acceptance(
    connection: sqlite3.Connection,
    gtf_summary: dict[str, Any],
    fasta_summary: dict[str, Any],
    export_manifest: dict[str, Any],
    feature_summary: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    if gtf_summary["total_feature_rows"] != EXPECTED_GTF_TOTAL_ROWS:
        errors.append(
            f"GTF rows: expected {EXPECTED_GTF_TOTAL_ROWS}, "
            f"got {gtf_summary['total_feature_rows']}"
        )
    expected_fasta = {
        "transcript_records_selected": EXPECTED_PC_TRANSCRIPT_FASTA_RECORDS,
        "protein_records_selected": EXPECTED_PC_TRANSLATION_FASTA_RECORDS,
    }
    if fasta_summary != expected_fasta:
        errors.append(f"FASTA audit: expected {expected_fasta}, got {fasta_summary}")

    for source, (rows, distinct_transcripts, distinct_features) in EXPECTED_FEATURE_AUDIT.items():
        exported = export_manifest["sources"].get(source, {})
        actual = (
            exported.get("rows"),
            exported.get("distinct_transcripts"),
            exported.get("distinct_feature_ids"),
        )
        expected = (rows, distinct_transcripts, distinct_features)
        if actual != expected:
            errors.append(f"{source} RDS audit: expected {expected}, got {actual}")
        if feature_summary["feature_counts"].get(source) != rows:
            errors.append(
                f"{source} imported rows: expected {rows}, "
                f"got {feature_summary['feature_counts'].get(source)}"
            )

    errors.extend(validate_density_tiles(connection))
    return errors


def validate_sp1_acceptance(
    connection: sqlite3.Connection, feature_counts: dict[str, int]
) -> list[str]:
    errors: list[str] = []
    expected_lengths = {
        "SP1-201": 785,
        "SP1-202": 778,
        "SP1-203": 230,
        "SP1-204": 162,
    }
    actual_lengths = dict(
        connection.execute(
            "SELECT transcript_name,protein_length FROM transcript ORDER BY transcript_name"
        ).fetchall()
    )
    if actual_lengths != expected_lengths:
        errors.append(f"SP1 protein lengths: expected {expected_lengths}, got {actual_lengths}")
    expected_features = {
        "interpro": 20,
        "pfam": 6,
        "cdd": 0,
        "tmhmm": 0,
        "signalp": 0,
        "mobidblite": 14,
        "elm": 2,
    }
    if feature_counts != expected_features:
        errors.append(f"SP1 feature counts: expected {expected_features}, got {feature_counts}")
    sp1_203_features = connection.execute(
        "SELECT COUNT(*) FROM protein_feature WHERE transcript_id='ENST00000548560'"
    ).fetchone()[0]
    sp1_203_protein = connection.execute(
        "SELECT length FROM sequence WHERE transcript_id='ENST00000548560' AND kind='protein'"
    ).fetchone()
    if sp1_203_features != 0 or not sp1_203_protein or sp1_203_protein[0] != 230:
        errors.append("SP1-203 must retain its 230-aa protein and have zero local features")
    return errors


def insert_database_manifest(connection: sqlite3.Connection, manifest: dict[str, Any]) -> None:
    required = {
        "schema_version": manifest["schema_version"],
        "build_hash": manifest["build_hash"],
        "release": manifest["release"],
        "ensembl_release": manifest["ensembl_release"],
        "assembly": manifest["assembly"],
        "technical_preview": manifest["technical_preview"],
        "scope": manifest["scope"],
        "reference_available": manifest["reference"]["available"],
        "reference_verified": manifest["reference"]["verified"],
    }
    def scalar(value: Any) -> str:
        if isinstance(value, bool):
            return "true" if value else "false"
        return str(value)

    connection.executemany(
        "INSERT INTO build_manifest(key,value) VALUES(?,?)",
        [(key, scalar(value)) for key, value in required.items()],
    )


def toolchain_hashes(project_root: Path) -> dict[str, str]:
    relative_paths = (
        "backend/builder/build.py",
        "backend/builder/constants.py",
        "backend/builder/parsers.py",
        "backend/builder/projection.py",
        "backend/builder/schema.py",
        "r/export_features.R",
        "r/preflight.R",
        "r/dependencies.lock.tsv",
        "r/renv.lock",
    )
    return {
        relative_path: file_digest(project_root / relative_path, "sha256")
        for relative_path in relative_paths
    }


def _peak_rss_bytes(usage: resource.struct_rusage) -> int:
    # Darwin reports bytes while Linux and most BSDs report KiB.
    value = int(usage.ru_maxrss)
    return value if platform.system() == "Darwin" else value * 1024


def package_apparent_size(path: Path) -> int:
    """Return package bytes without following the multi-gigabyte FASTA links."""

    return sum(
        item.lstat().st_size
        for item in path.rglob("*")
        if not item.is_dir()
    )


def write_build_metrics(
    staging: Path,
    *,
    build_hash: str,
    started: float,
    stage_seconds: dict[str, float],
    database_path: Path,
    invocation: dict[str, Any],
) -> None:
    stage_seconds["total"] = time.perf_counter() - started
    usage_self = resource.getrusage(resource.RUSAGE_SELF)
    usage_children = resource.getrusage(resource.RUSAGE_CHILDREN)
    disk = shutil.disk_usage(staging)
    payload = {
        "canonical": False,
        "note": (
            "Operational measurements are intentionally excluded from the deterministic "
            "build hash and canonical validation report. Reference symlink targets are "
            "excluded from package size."
        ),
        "build_hash": build_hash,
        "result": "success",
        "invocation": invocation,
        "recorded_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "sqlite": sqlite3.sqlite_version,
        },
        "stages_seconds": {
            name: round(seconds, 3) for name, seconds in stage_seconds.items()
        },
        "resources": {
            "builder_peak_rss_bytes": _peak_rss_bytes(usage_self),
            "child_process_peak_rss_bytes": _peak_rss_bytes(usage_children),
            "database_bytes": database_path.stat().st_size,
            "package_apparent_bytes_before_metrics": package_apparent_size(staging),
            "filesystem_free_bytes_at_completion": disk.free,
        },
    }
    write_json(staging / "build_metrics.json", payload)


def atomic_publish(staging: Path, target: Path) -> None:
    previous = target.parent / f".{target.name}.previous"
    if previous.exists() or previous.is_symlink():
        if previous.is_dir() and not previous.is_symlink():
            shutil.rmtree(previous)
        else:
            previous.unlink()
    if target.exists() or target.is_symlink():
        os.replace(target, previous)
    try:
        os.replace(staging, target)
    except Exception:
        if previous.exists() and not target.exists():
            os.replace(previous, target)
        raise
    if previous.exists() or previous.is_symlink():
        if previous.is_dir() and not previous.is_symlink():
            shutil.rmtree(previous)
        else:
            previous.unlink()


def build(args: argparse.Namespace) -> Path:
    build_started = time.perf_counter()
    stage_seconds: dict[str, float] = {}

    def finish_stage(name: str, stage_started: float) -> None:
        stage_seconds[name] = time.perf_counter() - stage_started

    source = args.source.resolve()
    project_root = Path(__file__).resolve().parents[2]
    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    target_name = "sp1_fixture" if args.scope == "sp1" else "gencode_v45"
    target = output_root / target_name

    with build_lock(output_root):
        stage_started = time.perf_counter()
        progress(f"validating {args.scope} inputs, R environment, and local reference")
        build_timestamp = deterministic_timestamp(
            source / "gencode.v45.annotation.gtf.gz"
        )
        input_manifest = validate_source_inputs(source)
        reference = validate_reference(args.reference_fasta)
        validate_r_environment(project_root, args.rscript)
        build_toolchain_hashes = toolchain_hashes(project_root)
        finish_stage("input_and_reference_validation", stage_started)
        staging = Path(tempfile.mkdtemp(prefix=f".{target_name}.tmp.", dir=output_root))
        try:
            stage_started = time.perf_counter()
            database_path = staging / "annotation.sqlite"
            connection = connect_database(database_path)
            create_schema(connection)
            with connection:
                insert_contigs(connection)
            gtf_summary = ingest_gtf(
                connection, source / "gencode.v45.annotation.gtf.gz", args.scope
            )
            finish_stage("gtf_ingestion_and_geometry", stage_started)
            progress(
                f"ingested {gtf_summary['total_feature_rows']:,} raw GTF rows and finalized geometry"
            )

            stage_started = time.perf_counter()
            cds_intervals, fasta_summary = ingest_fastas(connection, source)
            translation_statuses = classify_translation_mappings(connection, cds_intervals)
            finish_stage("fasta_ingestion_and_translation_validation", stage_started)
            progress(
                "ingested FASTAs and classified translation mappings: "
                + ", ".join(
                    f"{status}={count:,}" for status, count in translation_statuses.items()
                )
            )

            transcript_ids = [
                row[0]
                for row in connection.execute(
                    "SELECT transcript_id FROM transcript ORDER BY transcript_id"
                )
            ]
            export_directory = staging / "_feature_exports"
            export_directory.mkdir()
            stage_started = time.perf_counter()
            export_manifest = run_feature_export(
                project_root,
                source,
                export_directory,
                transcript_ids,
                args.rscript,
            )
            finish_stage("r_feature_export", stage_started)
            progress("exported and normalized all seven RDS feature sources")

            stage_started = time.perf_counter()
            feature_summary = import_features(connection, export_directory)
            finish_stage("feature_import_and_projection", stage_started)
            progress(
                f"imported {sum(feature_summary['feature_counts'].values()):,} protein features"
            )

            stage_started = time.perf_counter()
            with connection:
                populate_density_tiles(connection)
                populate_search(connection)
                create_indexes(connection)
            finish_stage("density_search_and_indexes", stage_started)
            progress("materialized density pyramid, search corpus, and interval indexes")

            stage_started = time.perf_counter()
            reference_manifest = write_reference_package(
                staging, reference, build_timestamp
            )
            content_hashes = canonical_table_hashes(connection)
            finish_stage("reference_package_and_content_hashes", stage_started)
            stable_inputs = {
                filename: {
                    key: value
                    for key, value in metadata.items()
                    if key in {"size", "md5", "sha256"}
                }
                for filename, metadata in input_manifest.items()
            }
            deterministic_payload = {
                "schema_version": SCHEMA_VERSION,
                "builder_version": BUILDER_VERSION,
                "scope": args.scope,
                "inputs": stable_inputs,
                "reference_sha256": reference["fasta_sha256"],
                "reference_fai_sha256": reference["fai_sha256"],
                "toolchain_hashes": build_toolchain_hashes,
                "content_hashes": content_hashes,
            }
            build_hash = hashlib.sha256(
                json.dumps(
                    deterministic_payload,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()

            stage_started = time.perf_counter()
            counts = table_counts(connection)
            validation_errors = [
                *feature_summary["orphan_rows"],
                *feature_summary["invalid_rows"],
            ]
            validation_errors.extend(validate_projection_integrity(connection))
            if args.scope == "sp1":
                validation_errors.extend(
                    validate_sp1_acceptance(
                        connection, feature_summary["feature_counts"]
                    )
                )
                validation_errors.extend(validate_density_tiles(connection))
            else:
                validation_errors.extend(
                    validate_full_acceptance(
                        connection,
                        gtf_summary,
                        fasta_summary,
                        export_manifest,
                        feature_summary,
                    )
                )
            foreign_key_errors = [tuple(row) for row in connection.execute("PRAGMA foreign_key_check")]
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if foreign_key_errors:
                validation_errors.append(f"foreign_key_check={foreign_key_errors[:10]}")
            if integrity != "ok":
                validation_errors.append(f"integrity_check={integrity}")
            translation_summary = translation_mapping_summary(connection)
            feature_summary["projection_by_mapping_status"] = feature_projection_summary(
                connection
            )

            manifest = {
                "schema_version": SCHEMA_VERSION,
                "builder_version": BUILDER_VERSION,
                "build_hash": build_hash,
                "release": GENCODE_RELEASE,
                "ensembl_release": ENSEMBL_RELEASE,
                "assembly": ASSEMBLY,
                "scope": args.scope,
                "technical_preview": args.scope == "sp1",
                "created_at": build_timestamp,
                "reference": {
                    "available": True,
                    "verified": True,
                    "directory": "reference",
                    "manifest": "reference_manifest.json",
                    "verification_receipt": "verification_receipt.json",
                    "fasta_public_path": "reference/genome.fa",
                    "fai_public_path": "reference/genome.fa.fai",
                    "resolved_fasta_target": str(reference["fasta_path"]),
                },
                "feature_sources": [
                    {
                        "name": source_name,
                        "records": feature_summary["feature_counts"][source_name],
                    }
                    for source_name in FEATURE_SOURCES
                ],
                "capabilities": {
                    "search": True,
                    "region": True,
                    "sequences": True,
                    "protein_features": True,
                    "genomic_feature_projection": True,
                    "reference_ranges": True,
                    "full_annotation": args.scope == "full",
                    "density_tiles": True,
                },
                "density_tile_sizes": list(DENSITY_TILE_SIZES),
                "counts": counts,
                "content_hashes": content_hashes,
                "toolchain_hashes": build_toolchain_hashes,
                "build_metrics": "build_metrics.json",
                "inputs": input_manifest,
            }
            with connection:
                insert_database_manifest(connection, manifest)
            connection.execute("PRAGMA optimize")
            connection.commit()
            connection.close()

            validation_report = {
                "build_hash": build_hash,
                "schema_version": SCHEMA_VERSION,
                "scope": args.scope,
                "passed": not validation_errors,
                "errors": validation_errors,
                "counts": counts,
                "gtf": gtf_summary,
                "fasta": fasta_summary,
                "translation_mapping_statuses": translation_statuses,
                "translation_mapping": translation_summary,
                "features": feature_summary,
                "feature_export": export_manifest,
                "reference": {
                    "verified": reference_manifest["verified"],
                    "fai_contig_count": reference_manifest["fai_contig_count"],
                    "primary_contig_count": len(PRIMARY_CONTIG_LENGTHS),
                },
                "foreign_key_check": foreign_key_errors,
                "integrity_check": integrity,
                "content_hashes": content_hashes,
                "toolchain_hashes": build_toolchain_hashes,
            }
            write_json(staging / "manifest.json", manifest)
            write_json(staging / "validation_report.json", validation_report)
            shutil.rmtree(export_directory)
            (staging / "selected_transcripts.txt").unlink(missing_ok=True)

            if validation_errors:
                raise BuildError(
                    "Validation failed: " + "; ".join(validation_errors[:10])
                )
            finish_stage("validation_and_finalize", stage_started)
            write_build_metrics(
                staging,
                build_hash=build_hash,
                started=build_started,
                stage_seconds=stage_seconds,
                database_path=database_path,
                invocation={
                    "command": [
                        sys.executable,
                        "-m",
                        "backend.builder.build",
                        "--source",
                        str(source),
                        "--output-root",
                        str(output_root),
                        "--scope",
                        args.scope,
                        "--reference-fasta",
                        str(args.reference_fasta.resolve()),
                        "--rscript",
                        args.rscript,
                    ],
                    "published_target": str(target),
                },
            )
            progress(f"all validation gates passed; publishing {target}")
            atomic_publish(staging, target)
        except BaseException:
            if staging.exists():
                shutil.rmtree(staging)
            raise
    return target


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="Directory containing the audited GENCODE v45 and feature cache",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("data/builds"),
        help="Parent directory for atomically published builds",
    )
    parser.add_argument("--scope", choices=("sp1", "full"), default="full")
    parser.add_argument(
        "--reference-fasta",
        type=Path,
        required=True,
        help=(
            "Path to the checksum-pinned Ensembl GRCh38.p14 reference FASTA; "
            "the adjacent .fai index must also exist"
        ),
    )
    parser.add_argument("--rscript", default=shutil.which("Rscript") or "Rscript")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        target = build(args)
    except (BuildError, OSError, sqlite3.Error, ValueError) as error:
        print(f"annotation build failed: {error}", file=sys.stderr)
        return 1
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
