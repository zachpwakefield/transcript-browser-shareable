# Testing the local browser

The source distribution intentionally does not contain a database, FASTA, or
frontend `node_modules` tree. Test it in layers so a source failure is not
confused with a missing local data package:

| Layer | What it proves | Needs generated data? |
| --- | --- | --- |
| Source/privacy | No workstation paths or generated artifacts leaked; Python/R source parses | No |
| Unit/contract | Builder, API, PDF, coordinate, and frontend behavior | No |
| SP1 acceptance build | GTF/FASTA/RDS inputs produce the expected four-transcript fixture | Yes |
| API smoke | Search, region, gene, transcript, protein features, and sequence work together | Yes |
| Browser acceptance | Pan/zoom, labels, expansion, filters, comparison, exports, and keyboard behavior | Yes |
| Full release gate | Full-build counts, checksums, deterministic rebuild, offline bundle, and startup | Yes |

## 1. Run the source checks

From the repository root:

```bash
./scripts/test_source.sh
```

This runs the publication audit, syntax compilation into a temporary directory,
data-contract tests, backend tests when `.venv` has the locked dependencies, and
the R parser checks when R is installed. Frontend tests are run automatically
when `frontend/node_modules` is present; otherwise the script reports a skip.
To make a missing frontend install an error (for CI or a release candidate):

```bash
./scripts/test_source.sh --require-frontend
```

Install the frontend separately in a networked environment when needed:

```bash
cd frontend
pnpm install --frozen-lockfile
cd ..
```

The GitHub Actions workflow repeats these checks on a clean runner.

## 2. Build the small SP1 acceptance fixture

Use a local, audited GENCODE v45/Ensembl 111 cache. A whole-genome reference is
optional and is only needed to exercise the reference-range endpoint; keep all
generated inputs outside Git (the paths below are placeholders):

```bash
./scripts/build_annotations.sh /path/to/annotation-cache \
  --scope sp1
```

To include the optional reference capability, add
`--reference-fasta /path/to/Homo_sapiens.GRCh38.dna.toplevel.fa`.

The builder filters the authoritative GTF to the `SP1` locus and writes the
ignored package at `data/builds/sp1_fixture/`. It then runs the acceptance
checks in `tests/data/test_sp1_build.py`, which require:

- exactly `SP1-201`, `SP1-202`, `SP1-203`, and `SP1-204`;
- protein lengths 785, 778, 230, and 162 amino acids, respectively;
- feature-source totals of InterPro 20, Pfam 6, MobiDB-lite 14, ELM 2, and zero
  rows for CDD, TMHMM, and SignalP in this fixture; and
- an exact 230-aa protein sequence with an explicit empty-feature state for
  `SP1-203`.

If the cache has not been prepared yet, run
`scripts/prepare_spliceimpactr_cache.R` as described in
[`data_preparation.md`](data_preparation.md), or supply the three raw GENCODE
paths explicitly. Do not copy the resulting cache into the repository.

## 3. Run the API smoke test

Build the frontend once if a browser UI is desired, then start the explicitly
labeled fixture server:

```bash
cd frontend
pnpm run build
cd ..
./run_local.sh --dev-fixture --no-open
```

In a second terminal, run:

```bash
python3 scripts/smoke_test_api.py
```

The smoke test checks the health/read-only flag and manifest, resolves `SP1`
through search, verifies the gene and region endpoints, opens the default
feature-rich `ENST00000327443` transcript, requests InterPro/Pfam/MobiDB-lite/
ELM features, and verifies that a non-empty protein sequence is returned. A
different data package can be tested with, for example:

```bash
python3 scripts/smoke_test_api.py \
  --base-url http://127.0.0.1:8010 \
  --gene-query MYGENE \
  --transcript ENST00000000000 \
  --expect-scope full
```

The server must remain bound to `127.0.0.1`; the smoke script should fail
clearly if it is pointed at a remote/non-running service.

## 4. Manually verify the browser behavior

Open `http://127.0.0.1:8000` after building `frontend/dist`. If using the Vite
development server instead, keep the API running and use:

```bash
cd frontend
pnpm dev
```

Then check the following on the SP1 fixture:

1. Search `SP1`, choose the gene result, and confirm the locus and four
   transcripts appear.
2. Zoom in and out, drag-pan, use the ruler/fit controls, and verify that the
   coordinate readout remains 0-based internally and 1-based for display.
3. Expand `SP1-201`; choose **Protein features**; toggle source databases and
   prediction filters; hover a feature and confirm genomic/protein
   cross-highlighting.
4. Open `SP1-203` and confirm its 230-aa sequence is available while the
   feature panel says no local features, rather than showing an error.
5. Pin and compare transcripts, reorder/keyboard-navigate rows, and reload a
   deep link. Verify that stale build state is rejected rather than silently
   applied.
6. Export a bounded JSON/TSV/CSV record and a PDF report; inspect that the
   identifiers, intervals, and feature counts match the selected rows.
7. Use browser developer tools' Network panel and confirm that the production
   bundle makes no request to a CDN, analytics service, or non-loopback API.
   Repeat the core flow at a narrow and wide viewport and in at least two
   browser engines before treating the UI as release-ready.

Record failures with the build hash, request URL, selected transcript/source,
viewport, browser/version, and a screenshot. Do not attach local cache paths or
private diagnostics to a public issue.

## 5. Full-build and release checks

After a complete `gencode_v45` package and deterministic rebuild receipt have
been produced, run:

```bash
./scripts/verify_release.sh
```

That gate checks the full manifest, two-build determinism, all Python/backend
and frontend tests, the offline bundle audit, full database startup, and
FileProvider-conflict filenames. If an optional reference is present, run
`./run_local.sh --full-reference-verify` separately to exercise its slow
checksum path. The separate human gates—fresh-machine
replay, cross-browser interaction review, performance review, and biological
interpretation review—are listed in [`release_checklist.md`](release_checklist.md).

## Interpreting failures

- A publication-audit failure is a privacy/release blocker.
- A missing dependency is an environment/setup issue; install from the lock
  files and rerun rather than weakening the test.
- A builder count/checksum/translation failure is a data-contract failure; do
  not edit the manifest by hand.
- A 404 from an endpoint usually means the requested stable ID is not in the
  selected scope. Repeat with the ID returned by `/api/v1/search`.
- An empty feature response can be biologically valid (for example SP1-203);
  distinguish it from an HTTP or build-validation error.
