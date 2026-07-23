from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.builder.build import classify_translation_mappings
from backend.builder.parsers import proteins_equivalent, ucsc_bin
from backend.builder.projection import CodingPiece, project_amino_acid_interval
from backend.builder.schema import connect_database, create_schema, populate_density_tiles


class BiologicalEdgeFixtureTests(unittest.TestCase):
    def test_single_exon_projection(self) -> None:
        pieces = [CodingPiece(1, 1_000, 1_030, 0, 30, "+")]
        projected = project_amino_acid_interval(3, 5, 10, pieces)
        self.assertEqual(
            [(piece.exon_rank, piece.start0, piece.end0) for piece in projected],
            [(1, 1_006, 1_015)],
        )

    def test_phase_one_and_two_split_codons_on_both_strands(self) -> None:
        fixtures = (
            (
                "positive_1_plus_2",
                [CodingPiece(1, 100, 104, 0, 4, "+"), CodingPiece(2, 200, 205, 4, 9, "+")],
                [(1, 103, 104, 1), (2, 200, 202, 2)],
            ),
            (
                "positive_2_plus_1",
                [CodingPiece(1, 100, 105, 0, 5, "+"), CodingPiece(2, 200, 204, 5, 9, "+")],
                [(1, 103, 105, 2), (2, 200, 201, 1)],
            ),
            (
                "negative_1_plus_2",
                [CodingPiece(1, 300, 304, 0, 4, "-"), CodingPiece(2, 200, 205, 4, 9, "-")],
                [(1, 300, 301, 1), (2, 203, 205, 2)],
            ),
            (
                "negative_2_plus_1",
                [CodingPiece(1, 300, 305, 0, 5, "-"), CodingPiece(2, 200, 204, 5, 9, "-")],
                [(1, 300, 302, 2), (2, 203, 204, 1)],
            ),
        )
        for name, pieces, expected in fixtures:
            with self.subTest(name=name):
                projected = project_amino_acid_interval(2, 2, 3, pieces)
                self.assertEqual(
                    [
                        (piece.exon_rank, piece.start0, piece.end0, piece.end0 - piece.start0)
                        for piece in projected
                    ],
                    expected,
                )

    def test_selenocysteine_translation_equivalence(self) -> None:
        self.assertTrue(proteins_equivalent("*", "U"))
        self.assertTrue(proteins_equivalent("MA*Q", "MAUQ"))
        self.assertFalse(proteins_equivalent("MAA", "MAU"))

    def test_noncoding_no_sequence_no_feature_and_partial_mapping_states(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            connection = connect_database(Path(directory) / "fixture.sqlite")
            create_schema(connection)
            connection.execute(
                "INSERT INTO contig(name,length,display_order,is_primary,fasta_name) "
                "VALUES('chr1',10000000,1,1,'1')"
            )
            connection.execute(
                "INSERT INTO gene(gene_id,gene_id_versioned,symbol,biotype,contig,"
                "start0,end0,strand,bin) VALUES(?,?,?,?,?,?,?,?,?)",
                ("ENSG_FIX", "ENSG_FIX.1", "FIX", "protein_coding", "chr1", 100, 1_000, "+", ucsc_bin(100, 1_000)),
            )

            def add_transcript(transcript_id: str, name: str, start0: int) -> None:
                connection.execute(
                    "INSERT INTO transcript(transcript_id,transcript_id_versioned,gene_id,"
                    "transcript_name,biotype,contig,start0,end0,strand,bin) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        transcript_id,
                        f"{transcript_id}.1",
                        "ENSG_FIX",
                        name,
                        "protein_coding" if name != "NONCODING" else "lncRNA",
                        "chr1",
                        start0,
                        start0 + 9,
                        "+",
                        ucsc_bin(start0, start0 + 9),
                    ),
                )
                connection.execute(
                    "INSERT INTO exon(transcript_id,exon_rank,start0,end0,strand,"
                    "transcript_start0,transcript_end0,bin) VALUES(?,?,?,?,?,?,?,?)",
                    (
                        transcript_id,
                        1,
                        start0,
                        start0 + 9,
                        "+",
                        0,
                        9,
                        ucsc_bin(start0, start0 + 9),
                    ),
                )

            add_transcript("ENST_NONCODING", "NONCODING", 100)
            add_transcript("ENST_NOSEQ", "NOSEQ", 200)
            add_transcript("ENST_PARTIAL", "PARTIAL", 300)

            for transcript_id, start0, transcript_end0 in (
                ("ENST_NOSEQ", 200, 9),
                ("ENST_PARTIAL", 300, 8),
            ):
                connection.execute(
                    "INSERT INTO cds_segment(transcript_id,segment_rank,exon_rank,start0,end0,"
                    "strand,transcript_start0,transcript_end0,bin) VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        transcript_id,
                        1,
                        1,
                        start0,
                        start0 + transcript_end0,
                        "+",
                        0,
                        transcript_end0,
                        ucsc_bin(start0, start0 + transcript_end0),
                    ),
                )
            for kind, sequence in (
                ("transcript_full", "ATGAAATAA"),
                ("cds", "ATGAAATAA"),
                ("protein", "MK"),
            ):
                connection.execute(
                    "INSERT INTO sequence(transcript_id,kind,sequence,length,sha256) "
                    "VALUES(?,?,?,?,?)",
                    ("ENST_PARTIAL", kind, sequence, len(sequence), "fixture"),
                )
            connection.commit()

            statuses = classify_translation_mappings(connection, {"ENST_PARTIAL": (0, 9)})
            self.assertEqual(statuses, {"partial": 1, "unresolved": 1})
            mapping = dict(
                connection.execute(
                    "SELECT transcript_id,status FROM translation_mapping ORDER BY transcript_id"
                ).fetchall()
            )
            self.assertNotIn("ENST_NONCODING", mapping)
            self.assertEqual(mapping["ENST_NOSEQ"], "unresolved")
            self.assertEqual(mapping["ENST_PARTIAL"], "partial")
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM protein_feature").fetchone()[0], 0)
            connection.close()

    def test_huge_locus_density_fixture_is_precomputed_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            connection = connect_database(Path(directory) / "huge.sqlite")
            create_schema(connection)
            connection.execute(
                "INSERT INTO contig(name,length,display_order,is_primary,fasta_name) "
                "VALUES('chr1',10000000,1,1,'1')"
            )
            connection.execute(
                "INSERT INTO gene(gene_id,gene_id_versioned,symbol,biotype,contig,"
                "start0,end0,strand,bin) VALUES(?,?,?,?,?,?,?,?,?)",
                ("ENSG_HUGE", "ENSG_HUGE.1", "HUGE", "protein_coding", "chr1", 1_000, 9_000_000, "+", ucsc_bin(1_000, 9_000_000)),
            )
            for index in range(48):
                transcript_id = f"ENST_HUGE_{index:02d}"
                connection.execute(
                    "INSERT INTO transcript(transcript_id,transcript_id_versioned,gene_id,"
                    "transcript_name,biotype,contig,start0,end0,strand,bin) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        transcript_id,
                        f"{transcript_id}.1",
                        "ENSG_HUGE",
                        f"HUGE-{index + 1}",
                        "protein_coding",
                        "chr1",
                        1_000,
                        9_000_000,
                        "+",
                        ucsc_bin(1_000, 9_000_000),
                    ),
                )
            populate_density_tiles(connection)
            broad = connection.execute(
                "SELECT COUNT(*),MIN(gene_count),MAX(transcript_count) FROM density_tile "
                "WHERE tile_size=1048576 AND tile_start0<9000000 AND tile_end0>1000"
            ).fetchone()
            self.assertLessEqual(broad[0], 9)
            self.assertEqual(broad[1], 1)
            self.assertEqual(broad[2], 48)
            connection.close()


if __name__ == "__main__":
    unittest.main()
