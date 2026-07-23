"""Bounded, read-only domain queries for API v1."""

from __future__ import annotations

from collections import defaultdict
from functools import lru_cache
import math
import re
from typing import Any, Iterable, Sequence

from .constants import (
    DENSITY_TILE_LEVELS,
    MAX_DENSITY_BINS,
    MAX_FEATURES_PER_RESPONSE,
    MAX_REGION_GENES,
    MAX_REGION_OVERRIDES,
    MAX_REGION_TRANSCRIPTS,
)
from .database import AnnotationDatabase
from .errors import QueryContractError


STABLE_ID_RE = re.compile(r"^(ENS(?:G|T|P|E)\d+)(?:\.(\d+))?$", re.IGNORECASE)
LOCUS_RE = re.compile(
    r"^\s*([^\s:]+)\s*:\s*([\d,]+)\s*(?:-|\.\.)\s*([\d,]+)\s*$"
)
SEQUENCE_KINDS = ("transcript_full", "cds", "protein")


def _ucsc_overlap_bin_ranges(start0: int, end0: int) -> list[tuple[int, int]]:
    """All hierarchical bin ranges that can contain an overlapping feature."""

    last = end0 - 1
    return [
        (4_681 + (start0 >> 17), 4_681 + (last >> 17)),
        (585 + (start0 >> 20), 585 + (last >> 20)),
        (73 + (start0 >> 23), 73 + (last >> 23)),
        (9 + (start0 >> 26), 9 + (last >> 26)),
        (1 + (start0 >> 29), 1 + (last >> 29)),
        (0, 0),
    ]


def _bin_predicate(alias: str, ranges: Sequence[tuple[int, int]]) -> tuple[str, list[int]]:
    clauses: list[str] = []
    parameters: list[int] = []
    for lower, upper in ranges:
        clauses.append(f"{alias}.bin BETWEEN ? AND ?")
        parameters.extend((lower, upper))
    return "(" + " OR ".join(clauses) + ")", parameters


def normalize_term(value: str) -> str:
    # The builder stores exact terms with ``casefold``.  Match that contract so
    # future non-ASCII aliases do not become unreachable at runtime.
    return " ".join(value.strip().casefold().split())


def base_stable_id(value: str) -> str:
    candidate = value.strip().upper()
    match = STABLE_ID_RE.fullmatch(candidate)
    return match.group(1) if match else candidate


def _display_locus(contig: str, start0: int, end0: int) -> str:
    return f"{contig}:{start0 + 1:,}-{end0:,}"


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _gene_json(row: dict[str, Any], *, transcript_count: int | None = None) -> dict[str, Any]:
    versioned_id = row.get("gene_id_versioned") or row["gene_id"]
    result: dict[str, Any] = {
        "id": row["gene_id"],
        "versionedId": versioned_id,
        "resolvedVersion": versioned_id,
        "version": row.get("gene_version"),
        "havanaId": row.get("havana_gene_id"),
        "havanaVersionedId": row.get("havana_gene_id_versioned"),
        "havanaVersion": row.get("havana_gene_version"),
        "symbol": row.get("symbol"),
        "hgncId": row.get("hgnc_id"),
        "biotype": row.get("biotype"),
        "chr": row.get("contig"),
        "start0": row.get("start0"),
        "end0": row.get("end0"),
        "strand": row.get("strand"),
    }
    if row.get("contig") is not None:
        result["locus"] = _display_locus(
            str(row["contig"]), int(row["start0"]), int(row["end0"])
        )
    if transcript_count is not None:
        result["transcriptCount"] = transcript_count
    return result


def _transcript_json(row: dict[str, Any]) -> dict[str, Any]:
    versioned_id = row.get("transcript_id_versioned") or row["transcript_id"]
    result = {
        "id": row["transcript_id"],
        "versionedId": versioned_id,
        "resolvedVersion": versioned_id,
        "version": row.get("transcript_version"),
        "havanaId": row.get("havana_transcript_id"),
        "havanaVersionedId": row.get("havana_transcript_id_versioned"),
        "havanaVersion": row.get("havana_transcript_version"),
        "geneId": row.get("gene_id"),
        "name": row.get("transcript_name"),
        "biotype": row.get("biotype"),
        "proteinId": row.get("protein_id"),
        "proteinVersionedId": row.get("protein_id_versioned"),
        "chr": row.get("contig"),
        "start0": row.get("start0"),
        "end0": row.get("end0"),
        "strand": row.get("strand"),
        "transcriptLength": row.get("transcript_length"),
        "cdsLength": row.get("cds_length"),
        "proteinLength": row.get("protein_length"),
        "annotationLevel": row.get("level"),
        "tsl": row.get("tsl"),
        "ccdsId": row.get("ccds_id"),
        "appris": row.get("appris"),
        "isBasic": bool(row.get("is_basic")),
        "isManeSelect": bool(row.get("is_mane_select")),
        "isManePlusClinical": bool(row.get("is_mane_plus_clinical")),
        "isEnsemblCanonical": bool(row.get("is_ensembl_canonical")),
    }
    # Region and search queries join this context under collision-free aliases.
    # It is deliberately additive so older clients can continue to use geneId.
    if row.get("gene_symbol") is not None:
        result["geneSymbol"] = row.get("gene_symbol")
    if row.get("gene_versioned_id") is not None:
        result["geneVersionedId"] = row.get("gene_versioned_id")
    return result


def _overlaps(start0: int, end0: int, item: dict[str, Any]) -> bool:
    item_start = item.get("start0")
    item_end = item.get("end0")
    return (
        item_start is not None
        and item_end is not None
        and int(item_start) < end0
        and int(item_end) > start0
    )


def _normalized_bp_per_pixel(value: float | None) -> float | None:
    """Bucket scale for stable region cache identities.

    Powers of two avoid a distinct cache key for every fractional wheel-zoom
    position while retaining enough scale information to keep LOD tiers apart.
    """

    if value is None:
        return None
    exponent = round(math.log2(value))
    return float(2.0**exponent)


def _transcript_priority(item: dict[str, Any]) -> tuple[Any, ...]:
    tags = set(item.get("tags") or [])
    return (
        0 if "MANE_Select" in tags else 1,
        0 if "Ensembl_canonical" in tags else 1,
        0 if any(tag.startswith("appris_principal") for tag in tags) else 1,
        int(item.get("start0") or 0),
        str(item.get("name") or item.get("id") or ""),
    )


def _segment_json(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "rank": row.get("segment_rank"),
        "exonRank": row.get("exon_rank"),
        "start0": row.get("start0"),
        "end0": row.get("end0"),
        "ntStart0": row.get("nt_start0"),
        "ntEnd0": row.get("nt_end0"),
    }


def _feature_json(
    row: dict[str, Any],
    segments: Sequence[dict[str, Any]],
    mapping_status: str,
) -> dict[str, Any]:
    # Only exact translation mappings are safe to project genomically. Partial
    # and unresolved records remain useful in the continuous amino-acid lane.
    drawable_segments = (
        [_segment_json(segment) for segment in segments]
        if mapping_status == "exact"
        else []
    )
    return {
        "id": row["feature_id"],
        "transcriptId": row.get("transcript_id"),
        "proteinId": row.get("protein_id"),
        "source": row.get("source"),
        "accession": row.get("accession"),
        "name": row.get("display_name"),
        "altName": row.get("alt_name"),
        "method": row.get("method"),
        "aaStart1": row.get("aa_start1"),
        "aaEnd1": row.get("aa_end1"),
        "projectionStatus": mapping_status,
        "segments": drawable_segments,
        "rawAudit": {
            "name": row.get("raw_name"),
            "chr": row.get("raw_chr"),
            "start1": row.get("raw_start1"),
            "end1": row.get("raw_end1"),
            "strand": row.get("raw_strand", row.get("strand")),
            "notDrawable": True,
        },
    }


class AnnotationRepository:
    def __init__(self, database: AnnotationDatabase):
        self.database = database

    def resolve_contig(self, name: str) -> dict[str, Any] | None:
        row = self.database.fetch_one(
            "SELECT name, length, display_order, is_primary FROM contig WHERE name = ?",
            (name,),
        )
        if row is not None:
            return row
        return self.database.fetch_one(
            "SELECT c.name, c.length, c.display_order, c.is_primary "
            "FROM contig_alias a JOIN contig c ON c.name = a.contig_name "
            "WHERE a.alias = ? LIMIT 1",
            (name,),
        )

    def _gene_row(self, identifier: str) -> dict[str, Any] | None:
        base = base_stable_id(identifier)
        return self.database.fetch_one(
            "SELECT * FROM gene WHERE gene_id = ? OR gene_id_versioned = ? "
            "ORDER BY CASE WHEN gene_id_versioned = ? THEN 0 ELSE 1 END LIMIT 1",
            (base, identifier, identifier),
        )

    def _transcript_row(self, identifier: str) -> dict[str, Any] | None:
        base = base_stable_id(identifier)
        return self.database.fetch_one(
            "SELECT * FROM transcript WHERE transcript_id = ? OR transcript_id_versioned = ? "
            "ORDER BY CASE WHEN transcript_id_versioned = ? THEN 0 ELSE 1 END LIMIT 1",
            (base, identifier, identifier),
        )

    def _transcript_for_protein(self, identifier: str) -> dict[str, Any] | None:
        base = base_stable_id(identifier)
        return self.database.fetch_one(
            "SELECT * FROM transcript WHERE protein_id = ? OR protein_id_versioned = ? "
            "ORDER BY CASE WHEN protein_id_versioned = ? THEN 0 ELSE 1 END LIMIT 1",
            (base, identifier, identifier),
        )

    def _tags_by_transcript(self, transcript_ids: Sequence[str]) -> dict[str, list[str]]:
        if not transcript_ids:
            return {}
        placeholders = ",".join("?" for _ in transcript_ids)
        rows = self.database.fetch_all(
            "SELECT transcript_id, tag FROM transcript_tag "
            f"WHERE transcript_id IN ({placeholders}) ORDER BY transcript_id, tag",
            transcript_ids,
        )
        result: dict[str, list[str]] = defaultdict(list)
        for row in rows:
            result[str(row["transcript_id"])].append(str(row["tag"]))
        return dict(result)

    def get_gene(self, identifier: str) -> dict[str, Any] | None:
        row = self._gene_row(identifier)
        if row is None:
            return None
        transcript_rows = self.database.fetch_all(
            "SELECT * FROM transcript WHERE gene_id = ? "
            "ORDER BY start0, end0, transcript_id",
            (row["gene_id"],),
        )
        tags = self._tags_by_transcript(
            [str(item["transcript_id"]) for item in transcript_rows]
        )
        counts = self.database.fetch_all(
            "SELECT transcript_id, COUNT(*) AS feature_count FROM protein_feature "
            "WHERE transcript_id IN (SELECT transcript_id FROM transcript WHERE gene_id = ?) "
            "GROUP BY transcript_id",
            (row["gene_id"],),
        )
        feature_counts = {
            str(item["transcript_id"]): int(item["feature_count"]) for item in counts
        }
        sequence_rows = self.database.fetch_all(
            "SELECT transcript_id, kind, length(sequence) AS length FROM sequence "
            "WHERE transcript_id IN (SELECT transcript_id FROM transcript WHERE gene_id = ?) "
            "ORDER BY transcript_id, kind",
            (row["gene_id"],),
        )
        sequence_lengths: dict[str, dict[str, int]] = defaultdict(dict)
        for sequence_row in sequence_rows:
            sequence_lengths[str(sequence_row["transcript_id"])][
                str(sequence_row["kind"])
            ] = int(sequence_row["length"])
        transcripts: list[dict[str, Any]] = []
        for item in transcript_rows:
            transcript = _transcript_json(item)
            transcript["geneSymbol"] = row.get("symbol")
            transcript["geneVersionedId"] = (
                row.get("gene_id_versioned") or row["gene_id"]
            )
            transcript["tags"] = tags.get(str(item["transcript_id"]), [])
            transcript["featureCount"] = feature_counts.get(str(item["transcript_id"]), 0)
            stored_lengths = sequence_lengths.get(str(item["transcript_id"]), {})
            transcript["sequences"] = {
                kind: {
                    "available": kind in stored_lengths,
                    "length": stored_lengths.get(kind, 0),
                }
                for kind in SEQUENCE_KINDS
            }
            transcripts.append(transcript)
        transcripts.sort(key=_transcript_priority)
        result = _gene_json(row, transcript_count=len(transcripts))
        gene_tags = self.database.fetch_all(
            "SELECT tag FROM gene_tag WHERE gene_id = ? ORDER BY ordinal, tag",
            (row["gene_id"],),
        )
        result["tags"] = [str(item["tag"]) for item in gene_tags]
        result["transcripts"] = transcripts
        return result

    def get_transcript(self, identifier: str) -> dict[str, Any] | None:
        row = self._transcript_row(identifier)
        if row is None:
            return None
        transcript_id = str(row["transcript_id"])
        result = _transcript_json(row)
        gene = self.database.fetch_one(
            "SELECT gene_id_versioned, symbol FROM gene WHERE gene_id = ?",
            (row["gene_id"],),
        ) or {}
        result["geneSymbol"] = gene.get("symbol")
        result["geneVersionedId"] = gene.get("gene_id_versioned") or row.get(
            "gene_id"
        )
        result["tags"] = self._tags_by_transcript([transcript_id]).get(
            transcript_id, []
        )
        exons = self.database.fetch_all(
            "SELECT * FROM exon WHERE transcript_id = ? ORDER BY exon_rank",
            (transcript_id,),
        )
        result["exons"] = [
            {
                "rank": exon.get("exon_rank"),
                "id": exon.get("exon_id"),
                "versionedId": exon.get("exon_id_versioned") or exon.get("exon_id"),
                "start0": exon.get("start0"),
                "end0": exon.get("end0"),
            }
            for exon in exons
        ]
        cds = self.database.fetch_all(
            "SELECT * FROM cds_segment WHERE transcript_id = ? ORDER BY segment_rank",
            (transcript_id,),
        )
        result["cdsSegments"] = [
            {
                "rank": item.get("segment_rank"),
                "exonRank": item.get("exon_rank"),
                "start0": item.get("start0"),
                "end0": item.get("end0"),
                "transcriptStart0": item.get("transcript_start0"),
                "transcriptEnd0": item.get("transcript_end0"),
                "phase": item.get("phase"),
            }
            for item in cds
        ]
        utrs = self.database.fetch_all(
            "SELECT * FROM utr_segment WHERE transcript_id = ? ORDER BY segment_rank",
            (transcript_id,),
        )
        result["utrSegments"] = [
            {
                "rank": item.get("segment_rank"),
                "exonRank": item.get("exon_rank"),
                "start0": item.get("start0"),
                "end0": item.get("end0"),
            }
            for item in utrs
        ]
        mapping = self.database.fetch_one(
            "SELECT cds_start0, cds_end0, status, reason FROM translation_mapping "
            "WHERE transcript_id = ?",
            (transcript_id,),
        )
        result["translationMapping"] = (
            {
                "cdsStart0": mapping.get("cds_start0"),
                "cdsEnd0": mapping.get("cds_end0"),
                "status": mapping.get("status"),
                "reason": mapping.get("reason"),
            }
            if mapping
            else None
        )
        sequence_rows = self.database.fetch_all(
            "SELECT kind, length(sequence) AS length FROM sequence "
            "WHERE transcript_id = ? ORDER BY kind",
            (transcript_id,),
        )
        stored_lengths = {
            str(item["kind"]): int(item["length"]) for item in sequence_rows
        }
        result["sequences"] = {
            kind: {
                "available": kind in stored_lengths,
                "length": stored_lengths.get(kind, 0),
            }
            for kind in SEQUENCE_KINDS
        }
        source_counts = self.database.fetch_all(
            "SELECT source, COUNT(*) AS count FROM protein_feature "
            "WHERE transcript_id = ? GROUP BY source ORDER BY source",
            (transcript_id,),
        )
        result["featureCounts"] = {
            str(item["source"]): int(item["count"]) for item in source_counts
        }
        result["featureCount"] = sum(result["featureCounts"].values())
        return result

    def get_sequence(self, identifier: str, kind: str) -> dict[str, Any] | None:
        transcript = self._transcript_row(identifier)
        if transcript is None:
            return None
        row = self.database.fetch_one(
            "SELECT sequence FROM sequence WHERE transcript_id = ? AND kind = ?",
            (transcript["transcript_id"], kind),
        )
        if row is None:
            return {
                "transcriptId": transcript["transcript_id"],
                "resolvedVersion": transcript.get("transcript_id_versioned"),
                "kind": kind,
                "available": False,
                "sequence": None,
                "length": 0,
            }
        sequence = str(row["sequence"])
        return {
            "transcriptId": transcript["transcript_id"],
            "resolvedVersion": transcript.get("transcript_id_versioned"),
            "kind": kind,
            "available": True,
            "sequence": sequence,
            "length": len(sequence),
        }

    def _mapping_for_transcript(self, transcript_id: str) -> dict[str, Any]:
        row = self.database.fetch_one(
            "SELECT status, reason, cds_start0, cds_end0 FROM translation_mapping "
            "WHERE transcript_id = ?",
            (transcript_id,),
        )
        if row is None:
            return {
                "status": "unresolved",
                "reason": "No translation mapping is stored for this transcript.",
                "cdsStart0": None,
                "cdsEnd0": None,
            }
        return {
            "status": row.get("status") or "unresolved",
            "reason": row.get("reason"),
            "cdsStart0": row.get("cds_start0"),
            "cdsEnd0": row.get("cds_end0"),
        }

    def get_features(
        self, identifier: str, sources: Sequence[str]
    ) -> dict[str, Any] | None:
        transcript = self._transcript_row(identifier)
        if transcript is None:
            return None
        transcript_id = str(transcript["transcript_id"])
        parameters: list[Any] = [transcript_id]
        source_clause = ""
        if sources:
            placeholders = ",".join("?" for _ in sources)
            source_clause = f" AND UPPER(source) IN ({placeholders})"
            parameters.extend(source.upper() for source in sources)
        feature_rows = self.database.fetch_all(
            "SELECT * FROM protein_feature WHERE transcript_id = ?"
            + source_clause
            + " ORDER BY aa_start1, aa_end1, source, feature_id LIMIT ?",
            (*parameters, MAX_FEATURES_PER_RESPONSE + 1),
        )
        if len(feature_rows) > MAX_FEATURES_PER_RESPONSE:
            raise QueryContractError(
                "Feature response exceeds the 10,000-row safety limit; select fewer sources."
            )
        segment_rows = self.database.fetch_all(
            "SELECT s.* FROM protein_feature_segment s "
            "JOIN protein_feature f ON f.feature_id = s.feature_id "
            "WHERE f.transcript_id = ?"
            + source_clause.replace("source", "f.source")
            + " ORDER BY s.feature_id, s.segment_rank",
            parameters,
        )
        segments: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for segment in segment_rows:
            segments[str(segment["feature_id"])].append(segment)
        mapping = self._mapping_for_transcript(transcript_id)
        status = str(mapping["status"])
        features = [
            _feature_json(row, segments.get(str(row["feature_id"]), []), status)
            for row in feature_rows
        ]
        empty_state = None
        if not features:
            empty_state = "No features in the selected local sources"
        return {
            "transcriptId": transcript_id,
            "resolvedVersion": transcript.get("transcript_id_versioned"),
            "proteinId": transcript.get("protein_id_versioned")
            or transcript.get("protein_id"),
            "mapping": mapping,
            "sources": list(sources),
            "features": features,
            "emptyState": empty_state,
        }

    def get_feature(self, feature_id: str) -> dict[str, Any] | None:
        row = self.database.fetch_one(
            "SELECT * FROM protein_feature WHERE feature_id = ?", (feature_id,)
        )
        if row is None:
            return None
        transcript_id = str(row["transcript_id"])
        mapping = self._mapping_for_transcript(transcript_id)
        segment_rows = self.database.fetch_all(
            "SELECT * FROM protein_feature_segment WHERE feature_id = ? "
            "ORDER BY segment_rank",
            (feature_id,),
        )
        result = _feature_json(row, segment_rows, str(mapping["status"]))
        result["mapping"] = mapping
        return result

    def _search_result(self, entity_type: str, entity_id: str, label: str) -> dict[str, Any] | None:
        kind = entity_type.lower().replace("_", "")
        if kind == "gene":
            row = self._gene_row(entity_id)
            if row is None:
                return None
            return {
                "kind": "gene",
                "id": row["gene_id"],
                "versionedId": row.get("gene_id_versioned"),
                "resolvedVersion": row.get("gene_id_versioned") or row["gene_id"],
                "geneId": row["gene_id"],
                "geneVersionedId": row.get("gene_id_versioned") or row["gene_id"],
                "label": label or row.get("symbol") or row["gene_id"],
                "symbol": row.get("symbol"),
                "chr": row.get("contig"),
                "start0": row.get("start0"),
                "end0": row.get("end0"),
                "strand": row.get("strand"),
                "biotype": row.get("biotype"),
            }
        if kind in {"transcript", "enst"}:
            row = self._transcript_row(entity_id)
            if row is None:
                return None
            gene = self.database.fetch_one(
                "SELECT gene_id_versioned, contig, symbol FROM gene WHERE gene_id = ?",
                (row["gene_id"],),
            ) or {}
            return {
                "kind": "transcript",
                "id": row["transcript_id"],
                "versionedId": row.get("transcript_id_versioned"),
                "resolvedVersion": row.get("transcript_id_versioned")
                or row["transcript_id"],
                "geneId": row.get("gene_id"),
                "geneVersionedId": gene.get("gene_id_versioned")
                or row.get("gene_id"),
                "transcriptId": row["transcript_id"],
                "transcriptVersionedId": row.get("transcript_id_versioned")
                or row["transcript_id"],
                "label": label or row.get("transcript_name") or row["transcript_id"],
                "symbol": gene.get("symbol"),
                "chr": gene.get("contig"),
                "start0": row.get("start0"),
                "end0": row.get("end0"),
                "strand": row.get("strand"),
                "biotype": row.get("biotype"),
            }
        if kind in {"protein", "ensp"}:
            # The search index stores the owning transcript ID for protein rows
            # so a result can navigate directly to the expandable transcript.
            row = self._transcript_for_protein(entity_id) or self._transcript_row(entity_id)
            if row is None:
                return None
            gene = self.database.fetch_one(
                "SELECT gene_id_versioned, contig, symbol FROM gene WHERE gene_id = ?",
                (row["gene_id"],),
            ) or {}
            return {
                "kind": "protein",
                "id": row.get("protein_id"),
                "versionedId": row.get("protein_id_versioned"),
                "resolvedVersion": row.get("protein_id_versioned")
                or row.get("protein_id"),
                "geneId": row.get("gene_id"),
                "geneVersionedId": gene.get("gene_id_versioned")
                or row.get("gene_id"),
                "transcriptId": row.get("transcript_id"),
                "transcriptVersionedId": row.get("transcript_id_versioned")
                or row.get("transcript_id"),
                "label": label or row.get("protein_id_versioned") or row.get("protein_id"),
                "symbol": gene.get("symbol"),
                "chr": gene.get("contig"),
                "start0": row.get("start0"),
                "end0": row.get("end0"),
                "strand": row.get("strand"),
                "biotype": row.get("biotype"),
            }
        if kind in {"exon", "ense"}:
            base = base_stable_id(entity_id)
            row = self.database.fetch_one(
                "SELECT e.*, t.gene_id, t.transcript_id_versioned, t.strand, "
                "g.gene_id_versioned, g.contig, g.symbol "
                "FROM exon e JOIN transcript t ON t.transcript_id = e.transcript_id "
                "JOIN gene g ON g.gene_id = t.gene_id "
                "WHERE e.exon_id = ? OR e.exon_id_versioned = ? "
                "ORDER BY e.transcript_id, e.exon_rank LIMIT 1",
                (base, entity_id),
            )
            if row is None:
                return None
            return {
                "kind": "exon",
                "id": row.get("exon_id"),
                "versionedId": row.get("exon_id_versioned"),
                "resolvedVersion": row.get("exon_id_versioned")
                or row.get("exon_id"),
                "geneId": row.get("gene_id"),
                "geneVersionedId": row.get("gene_id_versioned")
                or row.get("gene_id"),
                "transcriptId": row.get("transcript_id"),
                "transcriptVersionedId": row.get("transcript_id_versioned")
                or row.get("transcript_id"),
                "label": label or row.get("exon_id_versioned") or row.get("exon_id"),
                "symbol": row.get("symbol"),
                "chr": row.get("contig"),
                "start0": row.get("start0"),
                "end0": row.get("end0"),
                "strand": row.get("strand"),
                "biotype": None,
            }
        return None

    @lru_cache(maxsize=512)
    def search(self, query: str, limit: int) -> dict[str, Any]:
        locus_match = LOCUS_RE.fullmatch(query)
        if locus_match:
            contig = self.resolve_contig(locus_match.group(1))
            if contig is None:
                return {
                    "query": query,
                    "results": [],
                    "groups": {},
                    "limit": limit,
                    "truncated": False,
                }
            start1 = int(locus_match.group(2).replace(",", ""))
            end1 = int(locus_match.group(3).replace(",", ""))
            if start1 < 1 or end1 < start1 or end1 > int(contig["length"]):
                raise QueryContractError(
                    "Coordinate search must be a valid 1-based inclusive interval within the contig."
                )
            start0 = start1 - 1
            end0 = end1
            coordinate_result = {
                "kind": "coordinate",
                "id": f"{contig['name']}:{start1}-{end1}",
                "versionedId": None,
                "resolvedVersion": None,
                "label": _display_locus(str(contig["name"]), start0, end0),
                "chr": contig["name"],
                "start0": start0,
                "end0": end0,
            }
            return {
                "query": query,
                "results": [coordinate_result],
                "groups": {"coordinate": [coordinate_result]},
                "limit": limit,
                "truncated": False,
            }

        term = normalize_term(query)
        if not term:
            raise QueryContractError(
                "Search query must contain at least one non-whitespace character."
            )
        escaped = _escape_like(term)
        rows = self.database.fetch_all(
            "SELECT term_norm, entity_type, entity_id, label, priority, "
            "CASE WHEN term_norm = ? THEN 0 ELSE 1 END AS exact_rank "
            "FROM search_entity WHERE term_norm = ? OR term_norm LIKE ? ESCAPE '\\' "
            "ORDER BY exact_rank, priority DESC, label, entity_type, entity_id LIMIT ?",
            (term, term, escaped + "%", limit * 8),
        )
        # FTS receives only locally generated quoted tokens, never raw MATCH
        # grammar. It supplements exact/prefix results rather than outranking them.
        if len(rows) < limit and self.database.table_exists("search_fts"):
            tokens = re.findall(r"[a-z0-9]+", term)
            if tokens:
                fts_query = " AND ".join(f'"{token}"*' for token in tokens[:12])
                try:
                    fts_rows = self.database.fetch_all(
                        "SELECT entity_type, entity_id, label, 0 AS priority, "
                        "1 AS exact_rank, '' AS term_norm FROM search_fts "
                        "WHERE search_fts MATCH ? LIMIT ?",
                        (fts_query, limit * 8),
                    )
                    rows.extend(fts_rows)
                except Exception:
                    # A deliberately contentless FTS table may not expose stored
                    # columns. Exact/prefix search remains complete and deterministic.
                    pass
        # The exact index should contain stable IDs. Fall back explicitly so a
        # malformed/incomplete index cannot make a present stable ID unreachable.
        stable_term = term.upper()
        if not rows and STABLE_ID_RE.fullmatch(stable_term):
            prefix = stable_term[:4]
            kind = {"ENSG": "gene", "ENST": "transcript", "ENSP": "protein", "ENSE": "exon"}.get(prefix)
            if kind:
                rows = [
                    {
                        "term_norm": stable_term,
                        "entity_type": kind,
                        "entity_id": stable_term,
                        "label": stable_term,
                        "priority": 0,
                        "exact_rank": 0,
                    }
                ]
        results: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for row in rows:
            key = (str(row["entity_type"]), str(row["entity_id"]))
            if key in seen:
                continue
            result = self._search_result(key[0], key[1], str(row.get("label") or ""))
            if result is not None:
                seen.add(key)
                results.append(result)
            if len(results) >= limit:
                break
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for result in results:
            groups[str(result["kind"])].append(result)
        return {
            "query": query,
            "results": results,
            "groups": dict(groups),
            "limit": limit,
            # The exact/prefix stage intentionally fetches more candidates than
            # returned. Clients can communicate the bounded nature of the list
            # without treating it as an exhaustive alias search.
            "truncated": len(rows) > len(results) and len(results) >= limit,
        }

    @lru_cache(maxsize=256)
    def _resolve_region_overrides(
        self, identifiers: tuple[str, ...]
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        gene_ids: set[str] = set()
        transcript_ids: set[str] = set()
        for identifier in identifiers:
            stable = base_stable_id(identifier)
            if stable.startswith("ENSG"):
                gene = self._gene_row(identifier)
                if gene is not None:
                    gene_ids.add(str(gene["gene_id"]))
                continue
            transcript: dict[str, Any] | None = None
            if stable.startswith("ENST"):
                transcript = self._transcript_row(identifier)
            elif stable.startswith("ENSP"):
                transcript = self._transcript_for_protein(identifier)
            if transcript is not None:
                transcript_ids.add(str(transcript["transcript_id"]))
                gene_ids.add(str(transcript["gene_id"]))
        return tuple(sorted(gene_ids)), tuple(sorted(transcript_ids))

    @staticmethod
    def _density_level(span: int) -> int:
        for level in DENSITY_TILE_LEVELS:
            if math.ceil(span / level) <= MAX_DENSITY_BINS:
                return level
        return DENSITY_TILE_LEVELS[-1]

    @lru_cache(maxsize=512)
    def _has_gene_overlap(self, contig_name: str, start0: int, end0: int) -> bool:
        """Answer biological emptiness independently of the current page.

        Region rows are intentionally over-fetched and paginated.  A page can
        therefore contain only margin genes even when the requested viewport
        has an annotation on a later page.  Empty-state semantics must not be
        inferred from that bounded page.
        """

        ranges = _ucsc_overlap_bin_ranges(start0, end0)
        bin_sql, bin_parameters = _bin_predicate("g", ranges)
        row = self.database.fetch_one(
            "SELECT 1 AS present FROM gene g "
            f"WHERE g.contig = ? AND {bin_sql} "
            "AND g.start0 < ? AND g.end0 > ? LIMIT 1",
            (contig_name, *bin_parameters, end0, start0),
        )
        return row is not None

    @lru_cache(maxsize=256)
    def _region_rows(
        self,
        contig_name: str,
        query_start0: int,
        query_end0: int,
        resolved_detail: str,
        density_level: int,
        gene_offset: int,
        gene_limit: int,
        transcript_offset: int,
        transcript_limit: int,
        override_gene_ids: tuple[str, ...],
        override_transcript_ids: tuple[str, ...],
    ) -> dict[str, Any]:
        """Fetch one immutable, rounded regional cache entry.

        The cache is build-scoped because each repository is bound to one
        immutable AnnotationDatabase. Requested viewport coordinates are added
        by ``region`` and intentionally are not part of this database cache.
        """

        ranges = _ucsc_overlap_bin_ranges(query_start0, query_end0)
        gene_bin_sql, gene_bin_parameters = _bin_predicate("g", ranges)
        gene_rows = self.database.fetch_all(
            "SELECT g.*, COUNT(t.transcript_id) AS transcript_count "
            "FROM gene g LEFT JOIN transcript t ON t.gene_id = g.gene_id "
            f"WHERE g.contig = ? AND {gene_bin_sql} "
            "AND g.start0 < ? AND g.end0 > ? "
            "GROUP BY g.gene_id ORDER BY g.start0, g.end0, g.gene_id LIMIT ? OFFSET ?",
            (
                contig_name,
                *gene_bin_parameters,
                query_end0,
                query_start0,
                gene_limit + 1,
                gene_offset,
            ),
        )
        genes_has_more = len(gene_rows) > gene_limit
        regular_gene_rows = gene_rows[:gene_limit]
        regular_gene_ids = {str(row["gene_id"]) for row in regular_gene_rows}
        override_gene_rows: list[dict[str, Any]] = []
        missing_gene_overrides = [
            value for value in override_gene_ids if value not in regular_gene_ids
        ]
        if missing_gene_overrides:
            placeholders = ",".join("?" for _ in missing_gene_overrides)
            override_gene_rows = self.database.fetch_all(
                "SELECT g.*, (SELECT COUNT(*) FROM transcript t "
                "WHERE t.gene_id = g.gene_id) AS transcript_count FROM gene g "
                f"WHERE g.gene_id IN ({placeholders}) AND g.contig = ? "
                "AND g.start0 < ? AND g.end0 > ? "
                "ORDER BY g.start0, g.end0, g.gene_id",
                (*missing_gene_overrides, contig_name, query_end0, query_start0),
            )

        transcript_bin_sql, transcript_bin_parameters = _bin_predicate("t", ranges)
        regular_transcript_rows: list[dict[str, Any]] = []
        transcripts_has_more = False
        if resolved_detail in {"labeled", "expanded"}:
            transcript_rows = self.database.fetch_all(
                "SELECT t.*, g.symbol AS gene_symbol, "
                "g.gene_id_versioned AS gene_versioned_id FROM transcript t "
                "JOIN gene g ON g.gene_id = t.gene_id "
                f"WHERE g.contig = ? AND {transcript_bin_sql} "
                "AND t.start0 < ? AND t.end0 > ? "
                "ORDER BY t.start0, t.end0, t.transcript_id LIMIT ? OFFSET ?",
                (
                    contig_name,
                    *transcript_bin_parameters,
                    query_end0,
                    query_start0,
                    transcript_limit + 1,
                    transcript_offset,
                ),
            )
            transcripts_has_more = len(transcript_rows) > transcript_limit
            regular_transcript_rows = transcript_rows[:transcript_limit]

        regular_transcript_ids = {
            str(row["transcript_id"]) for row in regular_transcript_rows
        }
        missing_transcript_overrides = [
            value
            for value in override_transcript_ids
            if value not in regular_transcript_ids
        ]
        override_transcript_rows: list[dict[str, Any]] = []
        if missing_transcript_overrides:
            placeholders = ",".join("?" for _ in missing_transcript_overrides)
            override_transcript_rows = self.database.fetch_all(
                "SELECT t.*, g.symbol AS gene_symbol, "
                "g.gene_id_versioned AS gene_versioned_id FROM transcript t "
                "JOIN gene g ON g.gene_id = t.gene_id "
                f"WHERE t.transcript_id IN ({placeholders}) AND g.contig = ? "
                "AND t.start0 < ? AND t.end0 > ? "
                "ORDER BY t.start0, t.end0, t.transcript_id",
                (
                    *missing_transcript_overrides,
                    contig_name,
                    query_end0,
                    query_start0,
                ),
            )

        combined_transcript_rows = [
            *regular_transcript_rows,
            *override_transcript_rows,
        ]
        tags = self._tags_by_transcript(
            [str(row["transcript_id"]) for row in combined_transcript_rows]
        )

        density_available = self.database.table_exists("density_tile")
        density_rows: list[dict[str, Any]] = []
        if density_available and resolved_detail == "overview":
            density_rows = self.database.fetch_all(
                "SELECT tile_start0, tile_end0, gene_count, transcript_count "
                "FROM density_tile WHERE contig = ? AND tile_size = ? "
                "AND tile_start0 < ? AND tile_end0 > ? "
                "ORDER BY tile_start0 LIMIT ?",
                (
                    contig_name,
                    density_level,
                    query_end0,
                    query_start0,
                    MAX_DENSITY_BINS + 3,
                ),
            )

        return {
            "regularGeneRows": regular_gene_rows,
            "overrideGeneRows": override_gene_rows,
            "genesHasMore": genes_has_more,
            "regularTranscriptRows": regular_transcript_rows,
            "overrideTranscriptRows": override_transcript_rows,
            "transcriptsHasMore": transcripts_has_more,
            "tags": tags,
            "densityAvailable": density_available,
            "densityRows": density_rows,
        }

    def region(
        self,
        contig_name: str,
        start0: int,
        end0: int,
        detail: str,
        *,
        gene_offset: int = 0,
        gene_limit: int = MAX_REGION_GENES,
        transcript_offset: int = 0,
        transcript_limit: int = MAX_REGION_TRANSCRIPTS,
        overrides: Sequence[str] = (),
        bp_per_pixel: float | None = None,
    ) -> dict[str, Any]:
        contig = self.resolve_contig(contig_name)
        if contig is None:
            raise QueryContractError(f"Unknown contig or alias: {contig_name}")
        if start0 < 0 or end0 <= start0:
            raise QueryContractError("Region requires integers with 0 <= start0 < end0.")
        if end0 > int(contig["length"]):
            raise QueryContractError(
                f"end0 exceeds {contig['name']} length {contig['length']}."
            )
        if not 1 <= gene_limit <= MAX_REGION_GENES:
            raise QueryContractError(
                f"geneLimit must be between 1 and {MAX_REGION_GENES}."
            )
        if not 1 <= transcript_limit <= MAX_REGION_TRANSCRIPTS:
            raise QueryContractError(
                f"transcriptLimit must be between 1 and {MAX_REGION_TRANSCRIPTS}."
            )
        if gene_offset < 0 or transcript_offset < 0:
            raise QueryContractError("Region pagination offsets must be non-negative.")
        normalized_overrides = tuple(
            dict.fromkeys(value.strip() for value in overrides if value.strip())
        )
        if len(normalized_overrides) > MAX_REGION_OVERRIDES:
            raise QueryContractError(
                f"At most {MAX_REGION_OVERRIDES} selected/pinned overrides may be requested."
            )
        if any(len(value) > 128 for value in normalized_overrides):
            raise QueryContractError("A selected/pinned identifier exceeds 128 characters.")
        if bp_per_pixel is not None and (not math.isfinite(bp_per_pixel) or bp_per_pixel <= 0):
            raise QueryContractError("bpPerPixel must be a finite positive number.")
        span = end0 - start0
        resolved_detail = detail
        if detail == "auto":
            if span > 5_000_000:
                resolved_detail = "overview"
            elif span > 250_000:
                resolved_detail = "compact"
            else:
                resolved_detail = "labeled"

        contig_length = int(contig["length"])
        density_level = self._density_level(min(contig_length, span * 3))
        cache_tile_size = {
            "overview": density_level,
            "compact": 262_144,
            "labeled": 16_384,
            "expanded": 16_384,
        }[resolved_detail]
        # One requested viewport on each side, rounded to a semantic cache tile,
        # gives smooth local panning while preventing density/transcript cache
        # representations from ever sharing a key.
        raw_query_start0 = max(0, start0 - span)
        raw_query_end0 = min(contig_length, end0 + span)
        query_start0 = (raw_query_start0 // cache_tile_size) * cache_tile_size
        query_end0 = min(
            contig_length,
            math.ceil(raw_query_end0 / cache_tile_size) * cache_tile_size,
        )
        override_gene_ids, override_transcript_ids = self._resolve_region_overrides(
            normalized_overrides
        )
        rows = self._region_rows(
            str(contig["name"]),
            query_start0,
            query_end0,
            resolved_detail,
            density_level,
            gene_offset,
            gene_limit,
            transcript_offset,
            transcript_limit,
            override_gene_ids,
            override_transcript_ids,
        )

        genes: list[dict[str, Any]] = []
        for row in [*rows["regularGeneRows"], *rows["overrideGeneRows"]]:
            item = _gene_json(
                row, transcript_count=int(row.get("transcript_count") or 0)
            )
            item["inRequestedRegion"] = _overlaps(start0, end0, item)
            item["lodOverride"] = str(row["gene_id"]) in override_gene_ids
            genes.append(item)

        transcripts: list[dict[str, Any]] = []
        for row in [
            *rows["regularTranscriptRows"],
            *rows["overrideTranscriptRows"],
        ]:
            item = _transcript_json(row)
            transcript_id = str(row["transcript_id"])
            item["tags"] = rows["tags"].get(transcript_id, [])
            item["inRequestedRegion"] = _overlaps(start0, end0, item)
            item["lodOverride"] = transcript_id in override_transcript_ids
            transcripts.append(item)

        returned_gene_ids = {str(item["id"]) for item in genes}
        returned_transcript_ids = {str(item["id"]) for item in transcripts}
        missing_overrides = [
            *(
                value
                for value in override_gene_ids
                if value not in returned_gene_ids
            ),
            *(
                value
                for value in override_transcript_ids
                if value not in returned_transcript_ids
            ),
        ]
        density_bins = [
            {
                "start0": row.get("tile_start0"),
                "end0": row.get("tile_end0"),
                "geneCount": row.get("gene_count"),
                "transcriptCount": row.get("transcript_count"),
            }
            for row in rows["densityRows"]
        ]
        genes_has_more = bool(rows["genesHasMore"])
        transcripts_has_more = bool(rows["transcriptsHasMore"])
        requested_gene_count = sum(
            1 for item in genes if item["inRequestedRegion"]
        )
        requested_region_has_gene = requested_gene_count > 0
        if not requested_region_has_gene:
            requested_region_has_gene = self._has_gene_overlap(
                str(contig["name"]), start0, end0
            )
        return {
            "chr": contig["name"],
            "start0": start0,
            "end0": end0,
            "locus": _display_locus(str(contig["name"]), start0, end0),
            "requestedDetail": detail,
            "detail": resolved_detail,
            "genes": genes,
            "transcripts": transcripts,
            "density": {
                "available": bool(rows["densityAvailable"]),
                "tileSize": density_level,
                "levels": list(DENSITY_TILE_LEVELS),
                "bins": density_bins,
            },
            "transcriptPolicy": (
                "all"
                if resolved_detail in {"labeled", "expanded"}
                else "selected-and-pinned-only"
            ),
            "overfetch": {
                "start0": query_start0,
                "end0": query_end0,
                "viewportsEachSide": 1,
            },
            "cacheKey": {
                "detail": resolved_detail,
                "tileSize": cache_tile_size,
                "start0": query_start0,
                "end0": query_end0,
                "bpPerPixelBucket": _normalized_bp_per_pixel(bp_per_pixel),
            },
            "overrides": {
                "requested": list(normalized_overrides),
                "resolvedGeneIds": list(override_gene_ids),
                "resolvedTranscriptIds": list(override_transcript_ids),
                "notRendered": missing_overrides,
            },
            "emptyState": (
                "No annotated gene in the requested region"
                if not requested_region_has_gene
                else None
            ),
            "truncated": genes_has_more or transcripts_has_more,
            "limits": {
                "genes": gene_limit,
                "transcripts": transcript_limit,
                "maxGenes": MAX_REGION_GENES,
                "maxTranscripts": MAX_REGION_TRANSCRIPTS,
                "overrideEntities": MAX_REGION_OVERRIDES,
            },
            "pagination": {
                "genes": {
                    "offset": gene_offset,
                    "limit": gene_limit,
                    "returned": len(rows["regularGeneRows"]),
                    "hasMore": genes_has_more,
                    "nextOffset": gene_offset + gene_limit
                    if genes_has_more
                    else None,
                },
                "transcripts": {
                    "offset": transcript_offset,
                    "limit": transcript_limit,
                    "returned": len(rows["regularTranscriptRows"]),
                    "overrideCount": len(rows["overrideTranscriptRows"]),
                    "hasMore": transcripts_has_more,
                    "nextOffset": transcript_offset + transcript_limit
                    if transcripts_has_more
                    else None,
                },
            },
        }
