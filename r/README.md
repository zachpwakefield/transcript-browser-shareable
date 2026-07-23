# Annotation-build R environment

R is used only during data preparation and to read/normalize the seven local
feature RDS files. It is not required by the browser at runtime.

SpliceImpactR is installed from Bioconductor with:

```bash
./scripts/install_spliceimpactr.sh
```

The current Bioconductor release lists SpliceImpactR for R 4.6. Bioconductor
selects the compatible package repository for the R version in use. The
adapter records the installed SpliceImpactR and Bioconductor versions in its
relative-path preparation manifest.

The small standalone R export/preflight helper remains pinned to R 4.5.2 with
the exact package versions in both `renv.lock` and `dependencies.lock.tsv`:

- data.table 1.18.2.1
- jsonlite 2.0.0

`preflight.R` fails before GTF ingestion if the R release, installed package
versions, TSV lock, and renv lock disagree. On a machine that needs the pinned
packages installed, restore them once with:

```r
if (!requireNamespace("renv", quietly = TRUE)) install.packages("renv")
renv::restore(lockfile = "r/renv.lock", prompt = FALSE)
```

Dependency acquisition may require a network connection. Once those packages
and the audited local inputs exist, annotation building and browser runtime do
not fetch remote data.
