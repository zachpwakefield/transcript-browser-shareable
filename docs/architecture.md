# Architecture

The application is split into three deliberately replaceable layers.

1. The schema-1.1 annotation builder streams authoritative GENCODE v45 GTF and FASTA records, normalizes the seven local protein-feature tables, projects amino-acid intervals through transcript-ordered CDS segments, materializes exact/prefix search plus four complete density pyramids, validates the result, and atomically publishes an immutable SQLite package.
2. The FastAPI service opens that package read-only, exposes bounded versioned JSON endpoints plus a bounded `POST /api/v1/report/pdf` generator, serves an optional indexed reference with HTTP byte ranges when one is supplied, and serves the built single-page application. Region queries over-fetch one viewport for smooth panning but preserve requested-interval flags, pagination, semantic detail, and export boundaries.
3. The React workspace owns URL state and explicit user-directed vertical scrolling. A gene-scoped visual-order layer is applied to immutable transcript summaries before filtering and layout. A shared row-layout model then drives the sticky DOM label rail, Canvas2D track, and dense-gene minimap, including hit bounds and complete logical height. A viewport window selects the DOM rows and Canvas slice to mount/draw, while the outer scroller preserves the complete layout. Up to 25 translated transcripts can remain additively expanded. Expanded height is reserved from the active feature-source selection before asynchronous records arrive, so completion fills stable geometry rather than moving the viewport. Transcript detail demand follows the window plus explicit selected, comparison, pinned, bounded-expanded, and selected-neighbor context. Feature-table and sequence rows are separately virtualized, and stale search, region, detail, feature, sequence, and PDF-report work is aborted. Pure helper layers validate submitted-search resolution, the build-scoped local workspace, current-gene navigation, comparison metrics/export, shortcut gating, PDF presets, diagnostics, and minimap geometry. The renderer is the custom-Canvas fallback explicitly allowed by the implementation plan, so no remote genome registry or igv.js runtime is present.

Runtime data flow:

```text
raw GTF + transcript/protein FASTA + feature RDS + optional reference
                              |
                              v
                 deterministic annotation build
                              |
                              v
 SQLite + manifest + validation report + density/search indexes + optional reference
                              |
                              v
               read-only localhost FastAPI service
                              |
                              v
          React DOM controls + shared-layout Canvas workspace
```

The normal server binds only to `127.0.0.1`. It does not enable permissive CORS, telemetry, remote fonts, hosted genomes, remote search, BLAT, analytics, or CDN assets.

Normal startup accepts only a full package whose manifest, SQLite metadata, validation report, schema, release/assembly identifiers, counts, canonical hashes, density levels, and database digest agree. An optional reference receipt is checked when a reference is present. The SP1 acceptance package is reachable only through `--dev-fixture`. Slow full SQLite and optional-reference rehashes are available as explicit release gates without making ordinary startup unbounded.

## Desktop launcher boundary

The optional native AppKit launcher is a process owner and status window, not a second web implementation. A one-time local installer builds and ad-hoc signs the app, embeds the pinned backend/site-packages/frontend runtime as one archive, and materializes a versioned workspace under `~/Library/Application Support/Transcript Browser`. The immutable SQLite and reference FASTA/FAI are APFS copy-on-write clones, initially sharing source storage blocks. The private reference manifest, external symlinks, and identity receipt are repointed to those clones while preserving the verified byte sizes and SHA-256 declarations.

This private workspace prevents Finder-launched Python from blocking on Desktop/FileProvider privacy mediation. The child receives a minimal environment, imports only from Application Support, and still validates the exact immutable build before binding to `127.0.0.1:8765`. If a server with the exact expected build hash and PDF capability already answers there, the launcher reuses it and does not claim ownership; otherwise, closing the launcher terminates only the server child it started.

## State boundaries

- URL state: build hash, locus, selected gene/transcript/comparison/feature, an optional complete transcript-ID permutation for custom visual order, up to 25 independently expanded transcripts, pinned transcripts, source filters, typed prediction classes, transcript biotype/flag filters, row density, Canvas-keyboard preference, display mode, and inspector tab.
- Local workspace state: schema version, annotation build hash, restore preference, last validated view, 25 recents, 100 ordered favorites, up to 500 bounded user-annotation records, and one last-PDF preset. It is stored under `transcript-browser:workspace:v1`, capped at 512 KiB, and rejected wholesale for corrupt top-level/schema/build state while invalid nested entries are discarded.
- Server state: immutable build-scoped manifest/search/region/entity queries, lazily loaded transcript detail/features, and lazily loaded sequences.
- Ephemeral state: hover, temporary hit chooser, command-palette focus/timers, navigator query, scroll/minimap gesture windows, resize measurements, dialogs, and in-progress export/report status.

Live pan and passive UI changes replace the current history entry. Completed searches, submitted coordinates, and explicit fit/jump actions create history entries.

### Startup restoration and persistence

The manifest is validated before local workspace state is trusted. The workspace build hash must match that manifest, and its last view must independently satisfy the same bounded view-state contract. A ready view is persisted after a 400 ms debounce; normal scrolling is ephemeral and does not generate continuous storage writes. Data is scoped to the browser profile and loopback origin and contains no absolute paths, sequence payloads, PDFs, or scientific annotation payloads; the only annotation-like values are the explicitly separate bounded local user notes/tags described below.

Startup precedence is deterministic:

```text
validated manifest
       |
       +--> explicit URL/deep-link state exists --> validated URL state
       |
       +--> no explicit view + restore enabled + valid last view --> last view
       |
       +--> otherwise --> current-build default view
```

Corrupt, unsupported, oversized, or mismatched workspace data falls back to an empty current-build workspace. Clearing the workspace is explicit. Recents are recorded only after successful navigation and deduplicated by build plus stable base entity ID; favorites keep insertion/user order.

### User-annotation boundary

`UserAnnotation` is a separate browser-local record keyed as `gene:<base-id>` or `transcript:<base-id>`. A note is limited to 5,000 Unicode characters; an entity has at most 10 unique tags of 40 characters each. Each record carries a validated timestamp. These values never enter SQLite, API scientific facts, source tags, feature evidence, or PDF reports.

Portable sessions can carry bounded local annotations, but parsing and merging are separate operations. The UI requires an explicit merge action. Missing values may be added and a strictly newer import may replace an older local value; an equal-time or newer conflicting local value is retained and reported. This keeps user-authored interpretation distinct from both immutable annotation and silent last-writer-wins behavior.

### Current-gene navigation and keyboard boundary

The navigator searches the already-loaded, visually ordered transcript summaries by transcript name, base/versioned ENST, protein ID, and biotype. Active filters determine its ordinary candidates while selected, comparison, and pinned context remain retained. Previous/Next and global `J`/`K` do not wrap. `/`, `P`, `C`, and `Shift+C` are handled by one pure shortcut gate that rejects text editing, contenteditable, menus, dialogs, modifier chords, and any other blocked context.

All transcript navigation issues one gene-scoped reveal token. The token is consumed when the row is first present, including when already visible. No effect coupled to layout identity, detail completion, comparison demand, or minimap geometry owns `scrollTop` afterward.

A fresh gene search or explicit gene choice records a one-time default-protein-navigation intent. After the owning gene loads, the first translated transcript is selected and force-opened in Protein features mode; if the gene has no translation, the first transcript remains the fallback without inventing a protein product. This intent is not inferred during ordinary reconciliation. Explicit URL state, Back/Forward restoration, portable-session state, and validated last-view restoration therefore retain their declared display mode and expansion set. Disclosure toggles are additive, de-duplicated, and bounded at 25; reaching the bound rejects a new expansion with a status message rather than evicting an existing row.

### Submitted-search resolution boundary

Search payloads deliberately attach the owning gene symbol to transcript and protein results so the palette can show context. That contextual symbol is not the searched entity's own identity. The client therefore resolves a submitted query through a pure, kind-aware classifier: exactly one `gene` result whose own symbol equals the query takes precedence; two or more distinct gene records with that symbol remain ambiguous; otherwise exact base/versioned entity identifiers and the bounded single-result fallback retain their established behavior. Prefix-only result sets still require an explicit choice. This 1.1.2 change is client-side resolution only and requires no search-index, SQLite, API-schema, or annotation-build change.

## Transcript comparison and machine export boundary

Comparison state is a second transcript ID, distinct from selection and restricted to the current gene. It participates in URL/session round trips, filtering retention, bounded render/detail demand, and minimap markers. Opening comparison does not reorder rows or scroll. Pair placement delegates to the same normalized gene-scoped visual-order helpers used by ordinary reordering.

Comparison metrics are derived from immutable loaded transcript facts and keep four semantically different states: a genuine numeric zero, missing source value, not applicable (for example protein metrics on a noncoding transcript), and not yet loaded. Shared/unique tag partitions are deterministic and do not alter source tags.

CSV/TSV comparison export accepts selected plus comparison and optionally pinned transcripts from one gene, refuses stale/cross-gene IDs, and caps the request at 20 rows without truncation. Rows follow current visual order and use stable columns for build/gene/transcript identities, structural/support facts, flags, per-source feature counts, role markers, and separately labeled local notes/tags. Delimiter quoting is deterministic. Formula-like prefixes are neutralized only in user-authored cells so scientific identifiers remain exact.

## PDF report boundary

The PDF dialog builds an explicit request from the current immutable build, gene, chosen transcript IDs, section selection, active feature sources, structure scope, and optional sequence excerpt. The chosen IDs are emitted in the current filtered/custom visual order, and the service preserves that order. The report generator then re-resolves every transcript from the read-only package, verifies gene ownership and declared feature sources, and returns a no-store `application/pdf` response from `POST /api/v1/report/pdf`. No Canvas bitmap, remote asset, or browser print path participates.

Available report sections are transcript summary, exon/CDS structure, protein annotations, and exact sequence excerpt. Structure drawings use one vector genomic scale across either the union of the selected transcript spans or the submitted current locus. Human-facing genomic labels and excerpt start/end values are exact 1-based inclusive ranges; the current-locus request retains the API's normal integer 0-based half-open machine representation until formatting.

Generation fails explicitly beyond 20 transcripts, 2,000 feature rows, 20,000 aggregate sequence characters, 10,000 characters in one excerpt, 100 pages, or 25 MiB. The PDF is a human-oriented, text-extractable report; JSON/TSV remain the machine-oriented exports. ReportLab standard fonts keep generation offline and portable, but unsupported glyphs may be replaced. The document is not structurally tagged and makes no PDF/UA claim.

Quick PDF is a client shortcut over this same endpoint, not a second generator. Only the last successful build-scoped scope/section/source/structure/range preset is persisted. At invocation, current selected/comparison/pinned IDs are resolved in visual order and the preset is revalidated. A stale build, transcript, section, source, or sequence range opens the normal bounded dialog; requested content is never silently omitted.

## Minimap and scroll ownership

The transcript minimap is a compact projection of `layout.rows`, `layout.totalHeight`, current `scrollTop`, and viewport height. Its DOM contains one viewport indicator plus bounded selected/comparison/pinned markers, not one interactive transcript subtree per row. It hides when content does not overflow. Click, pointer drag, Arrow, Page, Home, and End callbacks are explicit scroll intents; background detail or feature updates are data changes only and cannot write scroll position. Expanded layout reserves every active-source lane before feature completion, so asynchronous annotation arrival also leaves `layout.totalHeight`, later row positions, and the minimap viewport geometry stable.

The minimap exposes scrollbar semantics, visible-row text, and keyboard navigation. Its geometry is pure and tested independently of browser rendering, while the shared layout remains the only label/Canvas/minimap row-position source.

## Application identity and support diagnostics

Application version `1.1.2` identifies UI, persistence schema integration, protein-expansion behavior, submitted-search resolution, and launcher behavior. The annotation build hash identifies immutable scientific content. They are displayed and released independently; changing `CFBundleShortVersionString` or frontend application code must not modify the annotation manifest/build hash.

The patch release is `1.1.1` build 3. Its packaged production assets are `index-DX_Ybgkz.js` (SHA-256 `8f260b9d517511b2bcf4b5723d893a4cd293bc983a8518bd329e1606213210c5`) and `index-C4hHE25D.css` (SHA-256 `528657043ce74b5a80d6174a4a97dd92fc82c5f34e6b2df10b53ac42242bfbdb`). These runtime identities are deployment evidence, not replacements for the immutable annotation build hash.

The 1.1.2 source patch carries build number 4. Its production assets are `index-Bvswjowy.js` (SHA-256 `9676f29d7c0c89f6b851f410cce7b3078a5f816e9b50058f51a72e9587b7bdf9`) and the unchanged `index-C4hHE25D.css` (SHA-256 `528657043ce74b5a80d6174a4a97dd92fc82c5f34e6b2df10b53ac42242bfbdb`). Native packaging/smoke and active-tree synchronization are separate deployment evidence and are not inferred from this source build.

The About/Diagnostics receipt is derived from a bounded allow-list: application version, build/release/assembly/schema identities, enabled capabilities, PDF availability, current stable entity IDs, viewport/DPR, loopback origin, and external-resource count. Formatting redacts home-directory usernames, collapses line breaks, and never reads notes, tags, search history, sequences, or arbitrary URLs. A non-loopback service is reported only as unexpected, without reproducing its address.

## Semantic detail and bounds

- More than 5 Mb resolves to overview density/packed genes.
- 250 kb to 5 Mb resolves to compact gene context.
- Less than 250 kb resolves to labeled transcript models; a fresh gene navigation explicitly defaults to Protein features, while an explicit or restored display mode remains authoritative.
- Selected and pinned entities are explicit bounded overrides.
- The comparison transcript is one additional explicit bounded override and never an implicit pin or scroll invariant.
- Custom transcript order is presentation state only. An empty permutation means the API’s original order; a non-empty permutation is deduplicated, restricted to the active gene, completed with missing canonical IDs, and applied before transcript filters. Changing genes clears it.
- Server limits cap coordinate span, search, genes, transcripts, features, exports, density bins, and override identifiers. The client separately caps Canvas transcript rows and table/sequence rendering.
- The shared transcript layout remains complete, but the rail and Canvas render only the visible variable-height rows plus 264 px of overscan within a 4,096-CSS-pixel window. Canvas allocation is additionally limited to 16,000,000 bitmap pixels and 16,384 pixels per dimension; backing scale is reduced only when a requested DPR would exceed a bound.
- Transcript-detail demand consists of the visible/overscan window plus selected, comparison, pinned, at most 25 explicitly expanded, and custom-order selected-neighbor rows. Expanded identifiers outside the 120-row prefix are retained as bounded explicit context in canonical visual order. Table and sequence views use fixed-row windows with six overscan rows while retaining complete logical/ARIA counts.

Complete density tiles contain zero-count bins as well as occupied bins, so an overview is a deterministic representation rather than an annotation-derived chromosome bound. Canonical chromosome lengths always come from the verified reference contract.

## Reference boundary

Reference sequence is an optional build input, never fetched at runtime. When supplied, the manifest pins its checksum, assembly, contig aliases, and FAI checksum; startup fails before serving reference ranges if those values do not match. The multi-gigabyte FASTA/FAI remain checksum-declared external symlink targets; the portable manifests, aliases, sizes, and receipts are copied with the package. Without that input, a full annotation package still serves transcript models, transcript/protein sequences, and protein features; only reference-range capability is absent.

## Build publication and reproducibility

R 4.5.2 plus the committed `renv.lock` are checked before annotation ingestion. The builder holds a kernel file lock outside Desktop/FileProvider synchronization, builds in a private temporary directory, validates before rename, and never exposes a partial target. Operational time/RSS/disk metrics are stored outside the canonical manifest hash. Identical builder version and inputs must produce identical row counts, table hashes, and build hash even though SQLite page layout and metrics timestamps are not compared byte-for-byte.
