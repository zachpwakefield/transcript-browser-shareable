"""Pure protein-feature to CDS-exon projection primitives."""

from __future__ import annotations

from dataclasses import dataclass


class ProjectionError(ValueError):
    """A protein interval cannot be projected without violating invariants."""


@dataclass(frozen=True)
class CodingPiece:
    exon_rank: int
    start0: int
    end0: int
    coding_start0: int
    coding_end0: int
    strand: str

    def __post_init__(self) -> None:
        if self.strand not in {"+", "-"}:
            raise ProjectionError(f"Invalid strand {self.strand!r}")
        if self.start0 < 0 or self.end0 <= self.start0:
            raise ProjectionError("Invalid genomic coding piece")
        if self.coding_start0 < 0 or self.coding_end0 <= self.coding_start0:
            raise ProjectionError("Invalid translation-relative coding piece")
        if self.end0 - self.start0 != self.coding_end0 - self.coding_start0:
            raise ProjectionError("Coding and genomic piece lengths differ")


@dataclass(frozen=True)
class ProjectedPiece:
    segment_rank: int
    exon_rank: int
    start0: int
    end0: int
    nt_start0: int
    nt_end0: int


def project_amino_acid_interval(
    aa_start1: int,
    aa_end1: int,
    protein_length: int,
    coding_pieces: list[CodingPiece],
    mapping_status: str = "exact",
) -> list[ProjectedPiece]:
    """Project a 1-based inclusive AA interval into exon-split genomic pieces."""

    if mapping_status != "exact":
        return []
    if aa_start1 < 1 or aa_end1 < aa_start1:
        raise ProjectionError(f"Invalid amino-acid interval {aa_start1}-{aa_end1}")
    if aa_end1 > protein_length:
        raise ProjectionError(
            f"Amino-acid interval ends at {aa_end1}, protein length is {protein_length}"
        )
    if not coding_pieces:
        raise ProjectionError("Exact mapping has no coding pieces")

    nt_start0 = (aa_start1 - 1) * 3
    nt_end0 = aa_end1 * 3
    projected: list[ProjectedPiece] = []
    covered = 0
    for piece in sorted(coding_pieces, key=lambda item: item.coding_start0):
        overlap_start = max(nt_start0, piece.coding_start0)
        overlap_end = min(nt_end0, piece.coding_end0)
        if overlap_start >= overlap_end:
            continue
        relative_start = overlap_start - piece.coding_start0
        relative_end = overlap_end - piece.coding_start0
        if piece.strand == "+":
            genomic_start = piece.start0 + relative_start
            genomic_end = piece.start0 + relative_end
        else:
            genomic_start = piece.end0 - relative_end
            genomic_end = piece.end0 - relative_start
        covered += overlap_end - overlap_start
        projected.append(
            ProjectedPiece(
                segment_rank=len(projected) + 1,
                exon_rank=piece.exon_rank,
                start0=genomic_start,
                end0=genomic_end,
                nt_start0=overlap_start,
                nt_end0=overlap_end,
            )
        )

    expected = nt_end0 - nt_start0
    if covered != expected:
        raise ProjectionError(
            f"Projected {covered} nt but expected {expected} nt for AA "
            f"{aa_start1}-{aa_end1}"
        )
    return projected

