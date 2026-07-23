from __future__ import annotations

import json
import sqlite3
import unittest
from pathlib import Path

from backend.builder.constants import (
    DENSITY_TILE_SIZES,
    EXPECTED_FEATURE_AUDIT,
    EXPECTED_GTF_FEATURE_ROWS,
    EXPECTED_GTF_TOTAL_ROWS,
    EXPECTED_PC_TRANSCRIPT_FASTA_RECORDS,
    EXPECTED_PC_TRANSLATION_FASTA_RECORDS,
    PRIMARY_CONTIG_LENGTHS,
)
from backend.builder.schema import canonical_table_hashes


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BUILD_DIR = PROJECT_ROOT / "data" / "builds" / "gencode_v45"


class FullBuildAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        database = BUILD_DIR / "annotation.sqlite"
        if not database.exists():
            raise unittest.SkipTest("Full GENCODE v45 package has not been built")
        cls.connection = sqlite3.connect(database)
        cls.connection.row_factory = sqlite3.Row
        cls.manifest = json.loads((BUILD_DIR / "manifest.json").read_text())
        cls.report = json.loads((BUILD_DIR / "validation_report.json").read_text())

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "connection"):
            cls.connection.close()

    def test_release_scope_and_validation_gate(self) -> None:
        self.assertEqual(self.manifest["schema_version"], "1.1.0")
        self.assertEqual(self.manifest["scope"], "full")
        self.assertFalse(self.manifest["technical_preview"])
        self.assertTrue(self.manifest["capabilities"]["full_annotation"])
        self.assertTrue(self.report["passed"])
        self.assertEqual(self.report["errors"], [])
        self.assertEqual(self.manifest["build_hash"], self.report["build_hash"])

    def test_raw_gtf_fasta_and_feature_audits_match(self) -> None:
        self.assertEqual(self.report["gtf"]["total_feature_rows"], EXPECTED_GTF_TOTAL_ROWS)
        self.assertEqual(
            self.report["gtf"]["selected_feature_rows"],
            dict(EXPECTED_GTF_FEATURE_ROWS),
        )
        self.assertEqual(
            self.report["fasta"],
            {
                "transcript_records_selected": EXPECTED_PC_TRANSCRIPT_FASTA_RECORDS,
                "protein_records_selected": EXPECTED_PC_TRANSLATION_FASTA_RECORDS,
            },
        )
        self.assertEqual(self.report["features"]["orphan_row_count"], 0)
        self.assertEqual(self.report["features"]["invalid_row_count"], 0)
        for source, (rows, distinct_transcripts, distinct_features) in EXPECTED_FEATURE_AUDIT.items():
            exported = self.report["feature_export"]["sources"][source]
            self.assertEqual(
                (
                    exported["rows"],
                    exported["distinct_transcripts"],
                    exported["distinct_feature_ids"],
                ),
                (rows, distinct_transcripts, distinct_features),
            )

    def test_database_counts_and_density_are_complete(self) -> None:
        self.assertEqual(self.manifest["counts"]["gene"], EXPECTED_GTF_FEATURE_ROWS["gene"])
        self.assertEqual(
            self.manifest["counts"]["transcript"], EXPECTED_GTF_FEATURE_ROWS["transcript"]
        )
        self.assertEqual(self.manifest["counts"]["exon"], EXPECTED_GTF_FEATURE_ROWS["exon"])
        expected_tiles = sum(
            (length + size - 1) // size
            for length in PRIMARY_CONTIG_LENGTHS.values()
            for size in DENSITY_TILE_SIZES
        )
        self.assertEqual(self.manifest["counts"]["density_tile"], expected_tiles)
        self.assertEqual(self.manifest["density_tile_sizes"], list(DENSITY_TILE_SIZES))

    def test_translation_and_projection_integrity(self) -> None:
        status_total = sum(self.report["translation_mapping_statuses"].values())
        self.assertEqual(status_total, self.manifest["counts"]["translation_mapping"])
        self.assertGreater(self.report["translation_mapping_statuses"].get("exact", 0), 0)
        wrong = self.connection.execute(
            "SELECT COUNT(*) FROM ("
            " SELECT feature.feature_id "
            " FROM protein_feature AS feature "
            " JOIN translation_mapping AS mapping USING(transcript_id) "
            " LEFT JOIN protein_feature_segment AS segment USING(feature_id) "
            " WHERE mapping.status='exact' GROUP BY feature.feature_id "
            " HAVING COALESCE(SUM(segment.nt_end0-segment.nt_start0),0) "
            " <>3*(feature.aa_end1-feature.aa_start1+1)"
            ")"
        ).fetchone()[0]
        self.assertEqual(wrong, 0)
        projection_audit = self.report["features"]["projection_by_mapping_status"]
        exact_features = sum(
            row["features"]
            for row in projection_audit
            if row["mapping_status"] == "exact"
        )
        exact_projected = sum(
            row["features_with_projection"]
            for row in projection_audit
            if row["mapping_status"] == "exact"
        )
        partial_features = sum(
            row["features"]
            for row in projection_audit
            if row["mapping_status"] == "partial"
        )
        partial_projected = sum(
            row["features_with_projection"]
            for row in projection_audit
            if row["mapping_status"] == "partial"
        )
        self.assertEqual(exact_features, exact_projected)
        self.assertGreater(partial_features, 0)
        self.assertEqual(partial_projected, 0)

    def test_integrity_and_canonical_content_hashes(self) -> None:
        self.assertEqual(self.connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(self.connection.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(canonical_table_hashes(self.connection), self.manifest["content_hashes"])

    def test_reference_is_linked_not_copied(self) -> None:
        fasta = BUILD_DIR / self.manifest["reference"]["fasta_public_path"]
        index = BUILD_DIR / self.manifest["reference"]["fai_public_path"]
        self.assertTrue(fasta.is_symlink())
        self.assertTrue(index.is_symlink())
        self.assertLess(sum(path.lstat().st_size for path in BUILD_DIR.rglob("*")), 3_000_000_000)


if __name__ == "__main__":
    unittest.main()
