# Local Transcript Browser

An offline-first genome/transcript browser for GENCODE v45 transcript structure and exon-aware protein features. It is designed for fast local inspection of genes and isoforms without depending on a hosted Ensembl session.

This repository contains the browser source, deterministic SQLite builder, tests, documentation, and the adapter that prepares inputs with the Bioconductor SpliceImpactR package. It does **not** contain scientific data products or third-party package source: the GTF, FASTA files, RDS feature tables, SQLite database, reference index, virtual environments, frontend dependencies, desktop bundles, local notes, logs, credentials, or machine-specific receipts are generated or supplied locally.

## Contents

- [What it does](#what-it-does)
- [Example screenshots](#example-screenshots)
- [Quick start](#quick-start)
- [How SpliceImpactR feeds the browser](#how-spliceimpactr-feeds-the-browser)
- [Data contract](#data-contract)
- [Run and use the browser](#run-and-use-the-browser)
- [Verification and publication](#verification-and-publication)
- [Testing guide](docs/testing.md)
- [Contributing](#contributing)
- [Repository map](#repository-map)
- [Licensing and attribution](#licensing-and-attribution)

## What it does

The browser combines a genome-browser-style locus view with transcript and protein interpretation:

| Area | Functionality |
| --- | --- |
| Search | Exact or prefix search for gene symbols, Ensembl gene/transcript/protein IDs, transcript names, exon identifiers, and genomic coordinates. Ambiguous symbols are presented for explicit selection rather than guessed. |
| Locus navigation | Zoom, pan, ruler selection, fit-to-gene/transcript, chromosome labels, packed broad-locus overview, transcript detail thresholds, and a dense-gene minimap. Pointer, keyboard, trackpad, and keyboard-focus interactions are supported. |
| Transcript models | GENCODE gene/transcript/exon/CDS/UTR/start-codon/stop-codon geometry, strand and phase, versioned identifiers, transcript biotypes, canonical/MANE/APPRIS/Basic/CCDS flags, and stable transcript labels. |
| Protein features | Expand a transcript to reveal protein-domain and motif lanes. InterPro, Pfam, CDD, TMHMM, SignalP, MobiDB-lite, and ELM remain separately filterable and are never silently reclassified. |
| Exon-aware projection | Amino-acid intervals are mapped through CDS pieces. A domain crossing an intron appears as separate exon-confined genomic segments plus an independent continuous N-to-C protein lane. |
| Comparison | Keep up to 25 protein rows expanded, reorder visible transcripts with accessible controls, compare two isoforms, pin context, and preserve the visual order in bounded exports. |
| Inspection/export | Cross-highlight feature segments, inspect tables and sequences, export JSON/TSV/CSV, and create bounded selectable-text/vector PDF reports with exact coordinate and sequence labels. |
| Local workspace | Build-scoped recents, favorites, notes, tags, URL state, session export/import, keyboard shortcuts, and diagnostic receipts are stored locally and remain separate from scientific annotation evidence. |
| Runtime | A read-only FastAPI service and React/TypeScript frontend run on loopback. After the data build, normal use is offline: no CDN, remote font, hosted registry, telemetry, permissive CORS, or runtime annotation fallback. |

The interface intentionally follows the useful genome-browser ideas users expect from Ensembl, IGV, and UCSC, but uses one shared local layout model for accessible controls, Canvas rendering, hit testing, scrolling, and protein-row geometry. This avoids the synchronization problems that can arise when several independent renderers own the same transcript rows.

## Example screenshots

These examples are captured from the small SP1 acceptance fixture used during development. They demonstrate the interface and interaction model only; the fixture is not a substitute for a prepared GENCODE v45 build and is not included as scientific data in this source-only repository.

### Expanded protein-feature track

Expanding a transcript adds exon-confined genomic feature segments and an independent continuous N-to-C protein axis. Source badges and the inspector stay synchronized with the visible row.

![SP1-201 expanded with exon-aware protein feature projections and a transcript inspector](docs/assets/sp1-expanded-protein-features.jpg)

### Transcript comparison

The comparison inspector makes isoform differences explicit, including transcript/CDS/protein lengths, annotation flags, and per-source feature counts. “Different” is written in the table rather than communicated by color alone.

![SP1-201 versus SP1-202 transcript comparison inspector](docs/assets/sp1-transcript-comparison.jpg)

### Protein sequence inspection

The sequence inspector provides the versioned protein identifier, copy/export affordances, exon overlays, and a readable amino-acid sequence that mirrors the selected transcript.

![SP1-201 protein sequence inspector with exon overlays](docs/assets/sp1-sequence-inspector.jpg)

## Quick start

The following commands create a complete local build. Run them from a fresh clone; the paths are examples, not required locations.

### Requirements

- Python 3.9+ for the API and builder (the lock file is tested across the supported Python range).
- Node.js 22.13+ and pnpm 11.7+ for the production frontend.
- R and Bioconductor for the [SpliceImpactR package](https://bioconductor.org/packages/release/bioc/html/SpliceImpactR.html); the current Bioconductor release is designed for R 4.6, and the package is needed only during data preparation.
- Network access during preparation only. Runtime browsing is local/offline.

```bash
git clone <your-repository-url> transcript-browser
cd transcript-browser

# Python runtime for the local API and builder helpers.
python3 -m venv .venv
.venv/bin/python -m pip install --requirement requirements.lock

# Production frontend assets.
cd frontend
pnpm install --frozen-lockfile
pnpm run build
cd ..

# Install SpliceImpactR from Bioconductor into the active R library.
./scripts/install_spliceimpactr.sh

# Download/process GENCODE v45 and obtain the seven protein-feature sources.
Rscript scripts/prepare_spliceimpactr_cache.R \
  --output data/cache \
  --base-dir data/spliceimpactr-cache

# Build and validate the immutable SQLite package. A whole-genome reference
# is optional; transcript, sequence, and protein-feature browsing works without
# it. See docs/reference_setup.md only if byte-range reference serving is wanted.
./scripts/build_annotations.sh data/cache --scope full

# Start the local browser.
./run_local.sh
```

Open the printed `http://127.0.0.1:<port>` URL. The server binds to loopback only. The optional macOS launcher is documented in [`desktop_app/README.md`](desktop_app/README.md).

The preparation step is the only normal step that contacts GENCODE, Ensembl BioMart, or ELM. It can be repeated safely: existing feature outputs are reused unless `--force` is supplied. The browser itself does not download annotation data at runtime.

## How SpliceImpactR feeds the browser

The data flow is deliberately explicit:

```text
SpliceImpactR (Bioconductor release)
  ├─ GENCODE v45 GTF + transcript FASTA + protein FASTA
  ├─ Ensembl 111 BioMart features
  └─ ELM linear motifs
          │
          ▼
data/cache/*.rds + raw GENCODE .gz files
          │
          ▼
streaming Python builder + optional GRCh38.p14 reference
          │
          ▼
validated immutable data/builds/gencode_v45/annotation.sqlite
          │
          ▼
loopback API + React/Canvas browser
```

`scripts/prepare_spliceimpactr_cache.R` calls SpliceImpactR's public `get_annotation()` and `get_protein_features()` APIs and uses BiocFileCache's public path lookup to locate downloaded raw assets. It writes one normalized RDS table per source, derives an optional `exon_features.rds` audit table with `get_exon_features()`, and writes a relative-path-only `spliceimpactr_manifest.json` containing the installed package and Bioconductor versions. The adapter does not call SpliceImpactR private functions.

### Release pairing

| Input | Release | Why it matters |
| --- | --- | --- |
| Gene/transcript/protein assets | GENCODE human v45 | Defines the transcript models and sequence records shown by the browser. |
| BioMart protein features | Ensembl release 111 | Release paired with GENCODE v45 in this browser contract. |
| Optional reference FASTA | Ensembl release 115, GRCh38.p14 | Enables verified byte-range reference serving when supplied; it is not required for transcript/protein browsing. |

Do not mix releases casually. If a new annotation release is desired, treat it as a new scientific build: update the release contract, expected counts/checksums, tests, and review notes together.

### Preparation commands

Install SpliceImpactR from Bioconductor:

```bash
./scripts/install_spliceimpactr.sh
```

Prepare all browser inputs, including exon-level provenance:

```bash
Rscript scripts/prepare_spliceimpactr_cache.R \
  --output data/cache \
  --base-dir data/spliceimpactr-cache
```

Refresh the cached remote results deliberately:

```bash
Rscript scripts/prepare_spliceimpactr_cache.R \
  --output data/cache \
  --base-dir data/spliceimpactr-cache \
  --force
```

Use all transcript-support-level values only when intentionally re-auditing feature counts:

```bash
Rscript scripts/prepare_spliceimpactr_cache.R \
  --output data/cache \
  --filter-tsl 1,2,3,4,5
```

If GENCODE assets already exist, provide all three raw files to avoid another download:

```bash
Rscript scripts/prepare_spliceimpactr_cache.R \
  --output data/cache \
  --base-dir data/spliceimpactr-cache \
  --gtf /path/to/gencode.v45.annotation.gtf.gz \
  --transcript-fa /path/to/gencode.v45.pc_transcripts.fa.gz \
  --protein-fa /path/to/gencode.v45.pc_translations.fa.gz
```

Use `--skip-exon` when only the seven builder inputs are needed and memory is constrained. The seven source tables are written as `interpro.rds`, `pfam.rds`, `cdd.rds`, `tmhmm.rds`, `signalp.rds`, `mobidblite.rds`, and `elm.rds`.

For full preparation details, explicit input behavior, reference checksums, and the distinction between derived exon provenance and builder geometry, see [`docs/data_preparation.md`](docs/data_preparation.md).

## Data contract

The builder expects this local cache:

```text
data/cache/
├── gencode.v45.annotation.gtf.gz
├── gencode.v45.pc_transcripts.fa.gz
├── gencode.v45.pc_translations.fa.gz
├── interpro.rds
├── pfam.rds
├── cdd.rds
├── tmhmm.rds
├── signalp.rds
├── mobidblite.rds
├── elm.rds
├── exon_features.rds              # optional provenance output
└── spliceimpactr_manifest.json    # preparation provenance
```

Each source feature RDS must contain:

```text
ensembl_transcript_id  start  stop  chr  strand  feature_id
clean_name  alt_name  database  ensembl_peptide_id  method  name
```

Protein coordinates are 1-based inclusive amino-acid intervals. The browser's SQLite and API geometry uses 0-based half-open genomic intervals; visible labels and copied prose use 1-based inclusive coordinates. Read [`docs/coordinate_contract.md`](docs/coordinate_contract.md) before changing projection code.

The Python builder validates required filenames, feature columns, release lineage, row/count audits, checksums, translation mappings, and primary-contig lengths before atomically publishing a build. If an optional whole-genome reference is supplied, its FASTA/index integrity is validated as well. A failed validation is a stop condition, not a warning to ignore.

The generated database and optional reference are intentionally ignored by Git. Do not commit them unless a separate data-release, licensing, and redistribution decision explicitly authorizes it.

## Run and use the browser

### Start modes

```bash
./run_local.sh                         # normal full validated package
./run_local.sh --dev-fixture            # explicitly labeled SP1 development fixture
./run_local.sh --port 8765 --open      # choose a port and open the browser
./run_local.sh --full-database-verify
```

Normal startup refuses a missing, stale, technical-preview, checksum-invalid, or lineage-inconsistent package. The development fixture is never silently substituted for a full build.

The SP1 fixture is a development/acceptance aid and is not included in this source-only distribution. Use `--dev-fixture` only after a downstream workflow has created the corresponding local fixture package.

### Main workflows

1. **Find a locus.** Search by symbol, stable ID, transcript name, protein ID, exon ID, or `chr:start-end`. Exact stable identifiers resolve directly; genuinely ambiguous gene symbols remain explicit choices.
2. **Navigate the locus.** Use Fit gene/transcript, zoom controls, drag-pan, ruler selection, keyboard focus, or trackpad gestures. Broad regions show packed/density summaries; narrower regions reveal individual transcript models.
3. **Choose a transcript.** Open the current-gene navigator, filter by biotype or annotation flags, pin rows, reorder visible transcripts, or use `J`/`K` to move through filter-matched rows.
4. **Inspect protein features.** Select **Protein features** and expand a translated transcript. The genomic lane shows exon-confined projections; the protein inset shows the continuous amino-acid interval. Filter source databases or typed prediction classes, hover for cross-highlighting, and inspect the table/sequence mirror.
5. **Compare isoforms.** Set a comparison transcript, keep selected/comparison/pinned context visible, and use the comparison panel to distinguish zero, missing, not-applicable, and not-yet-loaded values.
6. **Save or share locally.** Export bounded JSON/TSV/CSV data, create a selectable-text/vector PDF, or export/import a build-scoped session. Notes and tags are explicitly local user content and are excluded from scientific PDF evidence.

### Full feature surface

- **Search and resolution:** bounded result palettes, coordinate search, gene/transcript/protein ownership resolution, stable ambiguity handling, recents, favorites, and current-gene transcript search.
- **Genome view:** shared row layout, Canvas rendering, accessible label rail, density levels, packed genes, transcript detail thresholds, minimap, ruler selection, pan/zoom gestures, and device-pixel-ratio safeguards.
- **Transcript detail:** exon, CDS, UTR, codon, phase, strand, translation status, sequence excerpts, versioned identifiers, and annotation flags.
- **Protein lanes:** seven independent local sources, source filters, prediction classes (TMHMM, SignalP, MobiDB-lite, ELM), continuous protein scale, genomic projection segments, overlap menus, and inspector cross-highlighting.
- **Expansion/comparison:** additive independent expansion up to 25 rows, stable reserved row geometry while features load, accessible reorder controls, pins, comparison context, and bounded visual-order export.
- **Persistence:** URL/deep-link state, validated last-view restore, browser-local notes/tags, portable session merge with conflict reporting, and private diagnostics that redact home-directory paths and non-loopback origins.
- **Keyboard/interaction:** `/` focuses global search, `J`/`K` move through current-gene transcripts, `P` toggles a pin, `C` opens comparison, `Shift+C` assigns comparison context, and Page/Home/End operate the transcript viewport when focus is outside editing controls.
- **Output:** JSON/TSV machine exports, one-gene CSV/TSV comparison exports, exact sequence excerpts, and bounded PDF reports. Requests exceeding safety limits are refused instead of silently truncated.
- **Runtime/API:** read-only manifest, search, region, gene, transcript, feature, sequence, export, health, and PDF endpoints served from the same loopback origin as the production frontend. Reference-range endpoints are available only when an optional verified reference is supplied.

The main API surface is intentionally small and read-only: `GET /api/v1/health`, `/manifest`, `/search`, `/region`, `/genes/{identifier}`, `/transcripts/{identifier}`, `/transcripts/{identifier}/features`, `/transcripts/{identifier}/sequence`, `/features/{feature_id}`, and `/export`; `POST /api/v1/report/pdf` creates a bounded local report. The frontend is the reference client, but these endpoints make the built package useful for scripts and reproducible local analysis as well.

The operational limits and remaining cross-browser/scientific review gates are documented in [`docs/limitations.md`](docs/limitations.md) and [`docs/release_checklist.md`](docs/release_checklist.md).

The complete product and engineering blueprint is retained as design
provenance in [`docs/LOCAL_TRANSCRIPT_BROWSER_IMPLEMENTATION_PLAN.md`](docs/LOCAL_TRANSCRIPT_BROWSER_IMPLEMENTATION_PLAN.md).

## Verification and publication

Run the source/privacy audit before every commit:

```bash
./scripts/verify_publication.sh
```

Recommended checks after dependencies are installed:

```bash
./scripts/test_source.sh
python3 -m unittest discover -s tests/data -p 'test_*.py' -v
.venv/bin/python -m unittest discover -s backend/tests -p 'test_*.py' -v
cd frontend
pnpm test
pnpm run typecheck
pnpm run build
cd ..
```

The included [GitHub Actions workflow](.github/workflows/ci.yml) repeats the publication audit, backend tests, frontend tests, and production build on pushes and pull requests. The full release gate additionally requires a prepared full database, deterministic rebuild receipt, offline audit, cross-browser interaction review, fresh-environment replay, and domain-scientist interpretation review.

For the staged SP1 build, live API smoke test, manual genome-browser checklist,
and full release gate, see [`docs/testing.md`](docs/testing.md).

After each module or larger section, review both success and failure paths: missing inputs, stale builds, coordinate mismatches, empty versus failed feature results, ambiguous identifiers, oversized requests, focus/scroll ownership, external-resource leaks, and accidental local-path disclosure. Keep automated, manual browser, and biological interpretation evidence separate. See [`docs/critical_review_addendum.md`](docs/critical_review_addendum.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the source-only contribution policy, required checks, and review expectations. Pull requests should explain the user-visible behavior or scientific contract they change and include focused tests where practical.

## Repository map

```text
backend/app/                 read-only API, validation, PDF/report endpoints
backend/builder/             streaming GTF/FASTA/RDS → SQLite builder
frontend/src/                React controls, Canvas genome view, inspectors
frontend/tests/              frontend behavior and interaction contracts
r/                           locked R preflight/export helpers
scripts/                     data preparation, build, audit, benchmark helpers
spliceimpactr/README.md       Bioconductor dependency notes
docs/                        data, architecture, coordinate, review, and release docs
docs/assets/                 static README screenshots from the SP1 UI acceptance fixture
desktop_app/                 optional macOS launcher and installer
data/builds/                 generated local builds only; ignored by Git
```

## Troubleshooting

- **SpliceImpactR will not install:** use the R/Bioconductor release listed on its [Bioconductor package page](https://bioconductor.org/packages/release/bioc/html/SpliceImpactR.html), then rerun `./scripts/install_spliceimpactr.sh`. The browser does not need SpliceImpactR at runtime.
- **The adapter says a source is missing:** provide all three raw GENCODE paths together, or remove a partially prepared output and rerun without `--skip-exon`.
- **A feature checksum or count fails:** keep the GENCODE/Ensembl pairing and `--filter-tsl` setting consistent. Do not edit the builder manifest by hand.
- **Optional reference verification fails:** follow [`docs/reference_setup.md`](docs/reference_setup.md) and regenerate the index with the same FASTA bytes, or omit the optional reference for transcript/protein-only browsing.
- **Normal startup refuses the package:** rebuild with `scripts/build_annotations.sh data/cache --scope full`; normal mode requires a full validated annotation build, but not a whole-genome reference.
- **A 26th protein row will not open:** simultaneous expansion is intentionally capped at 25. Collapse a row before opening another.
- **Notes or recents differ between browsers:** they are profile-local by design. Use explicit session export/import when transferring local workspace state.
- **Frontend installation fails in CI or a restricted network:** run `pnpm install --frozen-lockfile` in a networked environment; no frontend dependency tree is checked in.

## Licensing and attribution

SpliceImpactR is installed from Bioconductor during data preparation and remains under its upstream GPL-3 license, authorship, citation, and source notices. The browser source still needs an explicit license selected by the repository owner before public redistribution; until then, GitHub download does not grant a new license to the browser code. Third-party notices are collected in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Reference and annotation files remain subject to their respective GENCODE, Ensembl, BioMart, ELM, and database terms. Review those terms before redistributing generated data. For the critical review and release boundary, see [`docs/release_checklist.md`](docs/release_checklist.md).
