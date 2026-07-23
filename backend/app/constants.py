"""Runtime limits and immutable API contracts."""

from __future__ import annotations

EXPECTED_SCHEMA_VERSION = "1.1.0"

# Region responses must remain bounded even when a client bypasses the UI.
MAX_REGION_SPAN_BP = 25_000_000
MAX_REGION_GENES = 1_000
MAX_REGION_TRANSCRIPTS = 5_000
MAX_REGION_OVERRIDES = 50
MAX_SEARCH_LIMIT = 100
DEFAULT_SEARCH_LIMIT = 20
MAX_FEATURES_PER_RESPONSE = 10_000
MAX_EXPORT_ROWS = 10_000

# The deterministic builder materializes these exact broad-scale levels.  The
# runtime chooses the smallest level that keeps an overview response compact.
DENSITY_TILE_LEVELS = (16_384, 65_536, 262_144, 1_048_576)
MAX_DENSITY_BINS = 256

ALLOWED_DETAIL_LEVELS = frozenset(
    {"auto", "overview", "compact", "labeled", "expanded"}
)
ALLOWED_SEQUENCE_KINDS = frozenset({"transcript_full", "cds", "protein"})

REQUIRED_TABLE_COLUMNS: dict[str, frozenset[str]] = {
    "build_manifest": frozenset({"key", "value"}),
    "contig": frozenset({"name", "length", "display_order", "is_primary"}),
    "contig_alias": frozenset({"alias", "contig_name"}),
    "gene": frozenset(
        {
            "gene_id",
            "gene_id_versioned",
            "gene_version",
            "havana_gene_id",
            "havana_gene_id_versioned",
            "havana_gene_version",
            "symbol",
            "hgnc_id",
            "biotype",
            "contig",
            "start0",
            "end0",
            "strand",
            "bin",
        }
    ),
    "gene_tag": frozenset({"gene_id", "tag", "ordinal"}),
    "transcript": frozenset(
        {
            "transcript_id",
            "transcript_id_versioned",
            "transcript_version",
            "havana_transcript_id",
            "havana_transcript_id_versioned",
            "havana_transcript_version",
            "gene_id",
            "transcript_name",
            "biotype",
            "protein_id",
            "protein_id_versioned",
            "start0",
            "end0",
            "strand",
            "bin",
            "transcript_length",
            "cds_length",
            "protein_length",
            "level",
            "tsl",
            "contig",
            "ccds_id",
            "appris",
            "is_basic",
            "is_mane_select",
            "is_mane_plus_clinical",
            "is_ensembl_canonical",
        }
    ),
    "transcript_tag": frozenset({"transcript_id", "tag"}),
    "exon": frozenset(
        {
            "transcript_id",
            "exon_rank",
            "exon_id",
            "exon_id_versioned",
            "start0",
            "end0",
        }
    ),
    "cds_segment": frozenset(
        {
            "transcript_id",
            "segment_rank",
            "exon_rank",
            "start0",
            "end0",
            "transcript_start0",
            "transcript_end0",
            "phase",
        }
    ),
    "utr_segment": frozenset(
        {"transcript_id", "segment_rank", "exon_rank", "start0", "end0"}
    ),
    "translation_mapping": frozenset(
        {"transcript_id", "cds_start0", "cds_end0", "status", "reason"}
    ),
    "sequence": frozenset({"transcript_id", "kind", "sequence"}),
    "protein_feature": frozenset(
        {
            "feature_id",
            "transcript_id",
            "protein_id",
            "source",
            "accession",
            "display_name",
            "alt_name",
            "method",
            "aa_start1",
            "aa_end1",
            "raw_name",
            "raw_chr",
            "raw_start1",
            "raw_end1",
            "raw_strand",
        }
    ),
    "protein_feature_segment": frozenset(
        {
            "feature_id",
            "segment_rank",
            "exon_rank",
            "start0",
            "end0",
            "nt_start0",
            "nt_end0",
        }
    ),
    "search_entity": frozenset(
        {"term_norm", "entity_type", "entity_id", "label", "priority"}
    ),
}
