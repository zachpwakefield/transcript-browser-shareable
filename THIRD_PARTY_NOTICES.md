# Third-party notices and data attribution

Versions below are the installed, locked dependencies used to build and run this release. SPDX identifiers are used where available; upstream license files remain in the installed Python and pnpm package metadata.

## Scientific data

- The annotation and coding sequences are derived from [GENCODE Human Release 45](https://www.gencodegenes.org/human/release_45.html), identified by GENCODE as GRCh38.p14 / Ensembl 111. GENCODE describes its project data as [open access](https://www.gencodegenes.org/pages/data_access.html). Exact local input names, sizes, digests, row counts, and content hashes are recorded in the immutable build manifest and validation report.
- The whole-genome byte-range reference is the local Ensembl 115 `Homo_sapiens.GRCh38.dna.toplevel.fa`, assembly GRCh38.p14. Its FASTA/FAI checksums and its relationship to the GENCODE build are recorded in the reference manifest; the sequence file is linked, not redistributed as a second copy.
- Protein-feature rows retain their local source labels: InterPro, Pfam, CDD, TMHMM, SignalP, MobiDB-lite, and ELM. The application does not claim ownership of those annotations or infer evidence, score, release, or biological class metadata that the local files do not contain. Source-specific data terms continue to apply to the user-supplied RDS inputs.

## Python runtime

| License | Locked packages |
|---|---|
| MIT | annotated-types 0.7.0; anyio 4.9.0; charset-normalizer 3.4.7; eval-type-backport 0.2.2; exceptiongroup 1.2.2; FastAPI 0.115.12; h11 0.16.0; Pydantic 2.11.5; pydantic-core 2.33.2; typing-inspection 0.4.1 |
| BSD-3-Clause | Click 8.1.8; httpcore 1.0.9; HTTPX 0.28.1; idna 3.10; pypdf 6.14.2; ReportLab 4.4.9; Starlette 0.46.2; Uvicorn 0.34.3 |
| MIT-CMU | Pillow 11.3.0 |
| MPL-2.0 | certifi 2025.1.31 |
| MIT OR Apache-2.0 | sniffio 1.3.1 |
| PSF-2.0 | typing-extensions 4.12.2 |

## Frontend and build toolchain

| License | Installed locked packages |
|---|---|
| MIT | @esbuild/darwin-arm64 0.28.0; @jridgewell/gen-mapping 0.3.13; @jridgewell/resolve-uri 3.1.2; @jridgewell/source-map 0.3.11; @jridgewell/sourcemap-codec 1.5.5; @jridgewell/trace-mapping 0.3.31; @oxc-project/types 0.130.0; @rolldown/binding-darwin-arm64 1.0.1; @rolldown/pluginutils 1.0.1; @types/node 22.19.19; @types/react 19.2.14; @types/react-dom 19.2.3; @vitejs/plugin-react 6.0.2; acorn 8.16.0; buffer-from 1.1.2; commander 2.20.3; csstype 3.2.3; esbuild 0.28.0; fdir 6.5.0; fsevents 2.3.3; jiti 2.7.0; nanoid 3.3.12; picomatch 4.0.4; PostCSS 8.5.14; React 19.2.6; React DOM 19.2.6; Rolldown 1.0.1; scheduler 0.27.0; source-map-support 0.5.21; tinyglobby 0.2.16; tsx 4.22.1; undici-types 6.21.0; Vite 8.0.13 |
| Apache-2.0 | detect-libc 2.1.2; TypeScript 5.9.3 |
| MPL-2.0 | lightningcss 1.32.0; lightningcss-darwin-arm64 1.32.0 |
| ISC | picocolors 1.1.1 |
| BSD-3-Clause | source-map 0.6.1; source-map-js 1.2.1 |
| BSD-2-Clause | terser 5.47.1 |

## R build dependencies

| Package | Version | License |
|---|---:|---|
| data.table | 1.18.2.1 | MPL-2.0 |
| jsonlite | 2.0.0 | MIT |

The browser's small R build preflight/export layer uses only the pinned `data.table` and `jsonlite` versions above; its supported R release and dependency records are in `r/renv.lock`. Data preparation additionally installs SpliceImpactR and its declared imports from Bioconductor through `BiocManager`.

## SpliceImpactR Bioconductor dependency

- SpliceImpactR is installed from the [Bioconductor package page](https://bioconductor.org/packages/release/bioc/html/SpliceImpactR.html) for data preparation; the browser repository does not redistribute its source.
- The package is licensed `GPL-3`; users should retain its authorship, citation, and upstream notices in the installed R library.
- Upstream project: [Bioconductor SpliceImpactR](https://bioconductor.org/packages/release/bioc/html/SpliceImpactR.html) and [fiszbein-lab/SpliceImpactR](https://github.com/fiszbein-lab/SpliceImpactR).
- The browser does not import SpliceImpactR at runtime. It consumes the normalized GENCODE/protein-feature tables produced by `scripts/prepare_spliceimpactr_cache.R`.

## Renderer decision

The shipped browser uses the implementation plan’s custom Canvas2D fallback. It does **not** bundle igv.js, so no igv.js code is included in this release. If that optional adapter is added later, its pinned version and MIT notice must be added here before distribution.
