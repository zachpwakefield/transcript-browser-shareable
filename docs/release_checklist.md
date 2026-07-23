# Public release checklist

This checklist is intentionally a template for a fresh checkout. It does not claim that a generated database, a clean-environment install, cross-browser interaction, or biological interpretation has been completed on another machine.

## Source/privacy gate

- [ ] `scripts/verify_publication.sh` passes.
- [ ] No `data/cache`, `data/reference`, `data/spliceimpactr-cache`, `data/builds`, `output`, virtual environment, or frontend dependency directory is staged.
- [ ] The browser source has a repository-owner-selected license.
- [ ] SpliceImpactR's Bioconductor GPL-3 attribution and package citation are documented; no vendored package source is staged.

## Build gate

- [ ] SpliceImpactR installs from Bioconductor in the documented R/Bioconductor environment and its installed version is recorded in the preparation manifest.
- [ ] The GENCODE v45 cache manifest contains all seven feature sources and the required columns.
- [ ] The Ensembl release-115 reference FASTA and `.fai` match the pinned digests.
- [ ] `scripts/build_annotations.sh` publishes a full build and `scripts/verify_release.sh` passes.
- [ ] Backend and frontend tests pass from a clean environment.

## Manual review gate

- [ ] Search, pan, zoom, transcript expansion, exon-aware protein projection, comparison, export, and PDF workflows are checked in a supported browser.
- [ ] At least one dense gene and one multi-exon protein-domain example are reviewed by a domain scientist.
- [ ] Browser console and network panels show no unexpected external resources.
- [ ] A fresh user can prepare data and start the browser by following the README without relying on a workstation-specific path.

Record date, software versions, data-build hash, and reviewer initials in a separate release note. Do not put home-directory paths, usernames, local logs, or generated receipts in this repository.
