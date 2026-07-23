# Bundled SpliceImpactR source

This directory contains the SpliceImpactR 0.99.4 source used by the browser's data-preparation adapter. The package retains its upstream GPL-3 license metadata, authorship, and citation information. See `SpliceImpactR/README.md` and `SpliceImpactR/DESCRIPTION` for upstream details.

Install it from the repository root with:

```bash
R CMD INSTALL spliceimpactr/SpliceImpactR
```

Then, from the repository root, run:

```bash
Rscript scripts/prepare_spliceimpactr_cache.R \
  --output data/cache \
  --base-dir data/spliceimpactr-cache
```

That adapter obtains GENCODE v45 annotation/sequences, queries Ensembl 111 and ELM through SpliceImpactR, writes the seven normalized source RDS files, and derives optional exon-level projections. The browser does not import SpliceImpactR at runtime; it consumes those prepared files after the Python builder validates them.
