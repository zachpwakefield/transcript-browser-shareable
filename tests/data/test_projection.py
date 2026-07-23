from __future__ import annotations

import unittest

from backend.builder.build import _strict_integer
from backend.builder.projection import (
    CodingPiece,
    ProjectionError,
    project_amino_acid_interval,
)


class ProjectionTests(unittest.TestCase):
    def test_feature_coordinate_parser_rejects_fractional_values(self) -> None:
        self.assertEqual(_strict_integer("7"), 7)
        self.assertEqual(_strict_integer("7.0"), 7)
        for value in ("7.5", "NaN", "Inf", ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                _strict_integer(value)

    def test_positive_strand_junction_split(self) -> None:
        pieces = [
            CodingPiece(1, 100, 106, 0, 6, "+"),
            CodingPiece(2, 200, 206, 6, 12, "+"),
        ]
        projected = project_amino_acid_interval(2, 3, 4, pieces)
        self.assertEqual(
            [(piece.exon_rank, piece.start0, piece.end0) for piece in projected],
            [(1, 103, 106), (2, 200, 203)],
        )
        self.assertEqual(sum(piece.end0 - piece.start0 for piece in projected), 6)

    def test_negative_strand_junction_split_preserves_protein_order(self) -> None:
        pieces = [
            CodingPiece(1, 300, 306, 0, 6, "-"),
            CodingPiece(2, 200, 206, 6, 12, "-"),
        ]
        projected = project_amino_acid_interval(2, 3, 4, pieces)
        self.assertEqual(
            [(piece.exon_rank, piece.start0, piece.end0) for piece in projected],
            [(1, 300, 303), (2, 203, 206)],
        )
        self.assertGreater(projected[0].start0, projected[1].start0)

    def test_non_exact_mapping_is_never_drawn(self) -> None:
        pieces = [CodingPiece(1, 100, 106, 0, 6, "+")]
        self.assertEqual(
            project_amino_acid_interval(1, 2, 2, pieces, mapping_status="unresolved"),
            [],
        )
        self.assertEqual(
            project_amino_acid_interval(1, 2, 2, pieces, mapping_status="partial"),
            [],
        )

    def test_out_of_range_feature_is_rejected(self) -> None:
        pieces = [CodingPiece(1, 100, 106, 0, 6, "+")]
        with self.assertRaises(ProjectionError):
            project_amino_acid_interval(1, 3, 2, pieces)

    def test_gap_in_exact_coding_map_is_rejected(self) -> None:
        pieces = [
            CodingPiece(1, 100, 103, 0, 3, "+"),
            CodingPiece(2, 200, 203, 6, 9, "+"),
        ]
        with self.assertRaises(ProjectionError):
            project_amino_acid_interval(1, 3, 3, pieces)


if __name__ == "__main__":
    unittest.main()
