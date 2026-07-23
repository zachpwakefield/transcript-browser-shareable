# SpliceImpactR preparation dependency

The browser does not vendor SpliceImpactR. Install the Bioconductor package in
the R environment used for one-time data preparation:

```bash
./scripts/install_spliceimpactr.sh
```

This uses `BiocManager::install("SpliceImpactR")` and retains the upstream
GPL-3 attribution through [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
The installed package version and Bioconductor release are recorded in the
generated preparation manifest.

Then, from the repository root, run:

```bash
Rscript scripts/prepare_spliceimpactr_cache.R \
  --output data/cache \
  --base-dir data/spliceimpactr-cache
```

That adapter obtains GENCODE v45 annotation/sequences, queries Ensembl 111 and ELM through SpliceImpactR, writes the seven normalized source RDS files, and derives optional exon-level projections. The browser does not import SpliceImpactR at runtime; it consumes those prepared files after the Python builder validates them.
