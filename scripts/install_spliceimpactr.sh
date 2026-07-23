#!/usr/bin/env bash
set -euo pipefail

command -v R >/dev/null 2>&1 || { echo "R is required; install a Bioconductor-compatible R release first." >&2; exit 1; }

# SpliceImpactR is a Bioconductor dependency, not vendored application code.
# BiocManager selects the compatible Bioconductor repository for the installed
# R release and installs the package's declared imports as needed.
exec Rscript --vanilla -e '
if (!requireNamespace("BiocManager", quietly = TRUE)) {
  install.packages("BiocManager", repos = "https://cloud.r-project.org")
}
BiocManager::install("SpliceImpactR", ask = FALSE, update = FALSE)
if (!requireNamespace("SpliceImpactR", quietly = TRUE)) {
  stop("Bioconductor installation completed without an available SpliceImpactR package.")
}
cat("Installed SpliceImpactR", as.character(utils::packageVersion("SpliceImpactR")), "\\n")
'
