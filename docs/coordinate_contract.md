# Coordinate contract

This project has one machine-coordinate convention:

- Genomic intervals in SQLite, Python, TypeScript, JSON, cache keys, and Canvas transforms are integer **0-based half-open** intervals named `start0` and `end0`.
- Amino-acid feature input is retained as **1-based inclusive** `aa_start` and `aa_end`, matching the local RDS files.
- Locus strings, copied human-readable coordinates, and prose are **1-based inclusive**.

Conversions are explicit:

```text
display_start = start0 + 1
display_end   = end0

start0 = display_start - 1
end0   = display_end
```

For a 1-based inclusive amino-acid feature:

```text
translation_nt_start0 = (aa_start - 1) * 3
translation_nt_end0   = aa_end * 3
```

The translation-relative nucleotide interval is intersected with CDS segments ordered in transcript 5-prime to 3-prime direction. Within a plus-strand segment, offsets increase with genomic position. Within a minus-strand segment, offsets are inverted from the segment end. A junction-spanning feature produces one stored projection row per CDS/exon piece; an intron is never covered by a single drawn block.

Canonical genomic coordinates remain integers. Interval overlap uses integer bins plus B-tree predicates, not SQLite's default floating-point R*Tree representation.

## Required invariants

- `0 <= start0 < end0 <= contig_length`
- `1 <= aa_start <= aa_end <= protein_length`
- Every projected piece is contained by one CDS segment.
- Projection pieces remain in protein order on both strands.
- Exact mappings cover `(aa_end - aa_start + 1) * 3` nucleotides.
- Partial and unresolved mappings carry an explicit reason; unresolved mappings can render on the continuous protein lane only.

