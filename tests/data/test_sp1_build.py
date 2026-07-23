from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BUILD_DIR = PROJECT_ROOT / "data" / "builds" / "sp1_fixture"


class SP1BuildAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        database = BUILD_DIR / "annotation.sqlite"
        if not database.exists():
            raise unittest.SkipTest("SP1 fixture has not been built")
        cls.connection = sqlite3.connect(database)
        cls.connection.row_factory = sqlite3.Row

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "connection"):
            cls.connection.close()

    def test_four_authoritative_transcripts_and_lengths(self) -> None:
        rows = self.connection.execute(
            "SELECT transcript_name, transcript_id_versioned, protein_length "
            "FROM transcript ORDER BY transcript_name"
        ).fetchall()
        self.assertEqual(
            [(row["transcript_name"], row["protein_length"]) for row in rows],
            [("SP1-201", 785), ("SP1-202", 778), ("SP1-203", 230), ("SP1-204", 162)],
        )
        self.assertEqual(rows[2]["transcript_id_versioned"], "ENST00000548560.1")

    def test_feature_source_counts_and_sp1_203_empty_state(self) -> None:
        actual = dict(
            self.connection.execute(
                "SELECT source, COUNT(*) FROM protein_feature GROUP BY source"
            ).fetchall()
        )
        expected = {
            "interpro": 20,
            "pfam": 6,
            "cdd": 0,
            "tmhmm": 0,
            "signalp": 0,
            "mobidblite": 14,
            "elm": 2,
        }
        self.assertEqual({source: actual.get(source, 0) for source in expected}, expected)
        count = self.connection.execute(
            "SELECT COUNT(*) FROM protein_feature WHERE transcript_id='ENST00000548560'"
        ).fetchone()[0]
        self.assertEqual(count, 0)
        protein = self.connection.execute(
            "SELECT length FROM sequence WHERE transcript_id='ENST00000548560' AND kind='protein'"
        ).fetchone()
        self.assertEqual(protein[0], 230)

    def test_only_exact_mappings_have_projected_segments(self) -> None:
        invalid = self.connection.execute(
            "SELECT COUNT(*) FROM protein_feature_segment AS segment "
            "JOIN protein_feature AS feature USING(feature_id) "
            "JOIN translation_mapping AS mapping USING(transcript_id) "
            "WHERE mapping.status <> 'exact'"
        ).fetchone()[0]
        self.assertEqual(invalid, 0)

    def test_manifest_is_self_consistent_and_reference_is_optional(self) -> None:
        manifest = json.loads((BUILD_DIR / "manifest.json").read_text())
        report = json.loads((BUILD_DIR / "validation_report.json").read_text())
        self.assertEqual(manifest["build_hash"], report["build_hash"])
        self.assertTrue(manifest["technical_preview"])
        if manifest["reference"]["available"]:
            self.assertTrue(manifest["reference"]["verified"])
            self.assertEqual(manifest["reference"]["directory"], "reference")
            self.assertEqual(manifest["reference"]["manifest"], "reference_manifest.json")
            self.assertTrue((BUILD_DIR / "reference" / "verification_receipt.json").exists())
            receipt = json.loads(
                (BUILD_DIR / "reference" / "verification_receipt.json").read_text()
            )
            self.assertIn("files", receipt)
            self.assertNotIn("records", receipt)
        else:
            self.assertFalse((BUILD_DIR / "reference").exists())
            self.assertFalse(manifest["capabilities"]["reference_ranges"])

    def test_repeat_build_has_identical_manifest_and_no_backup(self) -> None:
        configured_cache = os.environ.get("TRANSCRIPT_BROWSER_TEST_CACHE")
        configured_reference = os.environ.get("TRANSCRIPT_BROWSER_TEST_REFERENCE")
        if not configured_cache or not configured_reference:
            self.skipTest(
                "Set TRANSCRIPT_BROWSER_TEST_CACHE and TRANSCRIPT_BROWSER_TEST_REFERENCE "
                "to run the local-input repeat-build test"
            )
        cache = Path(configured_cache).expanduser()
        reference = Path(configured_reference).expanduser()
        if not cache.is_dir() or not reference.is_file():
            self.skipTest("Audited local inputs are unavailable")
        before = (BUILD_DIR / "manifest.json").read_bytes()
        report_before = (BUILD_DIR / "validation_report.json").read_bytes()
        subprocess.run(
            [
                str(PROJECT_ROOT / "scripts" / "build_annotations.sh"),
                str(cache),
                "--reference-fasta",
                str(reference),
                "--scope",
                "sp1",
            ],
            cwd=PROJECT_ROOT,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        after = (BUILD_DIR / "manifest.json").read_bytes()
        report_after = (BUILD_DIR / "validation_report.json").read_bytes()
        self.assertEqual(before, after)
        self.assertEqual(report_before, report_after)
        self.assertFalse((BUILD_DIR.parent / ".sp1_fixture.previous").exists())

    def test_cds_sequence_uses_gtf_translated_slice(self) -> None:
        rows = self.connection.execute(
            "SELECT transcript.transcript_name, transcript.cds_length, sequence.length "
            "FROM transcript JOIN sequence USING(transcript_id) "
            "WHERE sequence.kind='cds' ORDER BY transcript.transcript_name"
        ).fetchall()
        self.assertEqual(
            [(row["transcript_name"], row["cds_length"], row["length"]) for row in rows],
            [
                ("SP1-201", 2355, 2355),
                ("SP1-202", 2334, 2334),
                ("SP1-203", 690, 690),
                ("SP1-204", 486, 486),
            ],
        )

    def test_database_manifest_values_are_unquoted_scalars(self) -> None:
        values = dict(
            self.connection.execute("SELECT key,value FROM build_manifest").fetchall()
        )
        self.assertEqual(values["schema_version"], "1.1.0")
        self.assertEqual(values["technical_preview"], "true")
        self.assertFalse(values["build_hash"].startswith('"'))

    def test_foreign_keys_and_integrity(self) -> None:
        self.assertEqual(self.connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(self.connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_complete_density_pyramid_and_sp1_overlap_counts(self) -> None:
        manifest = json.loads((BUILD_DIR / "manifest.json").read_text())
        self.assertEqual(manifest["density_tile_sizes"], [16384, 65536, 262144, 1048576])
        self.assertTrue(manifest["capabilities"]["density_tiles"])
        levels = [
            row[0]
            for row in self.connection.execute(
                "SELECT DISTINCT tile_size FROM density_tile ORDER BY tile_size"
            )
        ]
        self.assertEqual(levels, manifest["density_tile_sizes"])
        locus = self.connection.execute(
            "SELECT start0,end0 FROM gene WHERE symbol='SP1'"
        ).fetchone()
        overlapping = self.connection.execute(
            "SELECT gene_count,transcript_count FROM density_tile "
            "WHERE contig='chr12' AND tile_size=16384 "
            "AND tile_start0<? AND tile_end0>?",
            (locus["end0"], locus["start0"]),
        ).fetchall()
        self.assertTrue(overlapping)
        self.assertTrue(any(row["gene_count"] >= 1 for row in overlapping))
        self.assertTrue(any(row["transcript_count"] >= 4 for row in overlapping))

    def test_havana_and_lossless_feature_provenance_columns(self) -> None:
        transcript = self.connection.execute(
            "SELECT havana_transcript_id_versioned FROM transcript "
            "WHERE transcript_name='SP1-201'"
        ).fetchone()
        self.assertTrue(transcript[0].startswith("OTTHUMT"))
        feature = self.connection.execute(
            "SELECT raw_transcript_id,raw_peptide_id,database_name,source "
            "FROM protein_feature ORDER BY feature_id LIMIT 1"
        ).fetchone()
        self.assertTrue(feature["raw_transcript_id"].startswith("ENST"))
        self.assertTrue(feature["raw_peptide_id"].startswith("ENSP"))
        self.assertTrue(feature["database_name"])
        self.assertIn(feature["source"], {"interpro", "pfam", "mobidblite", "elm"})


if __name__ == "__main__":
    unittest.main()
