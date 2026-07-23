# User guide

## Start the full local browser

From the project directory:

```bash
./run_local.sh
```

Open the printed `http://127.0.0.1:<port>` URL. Normal startup accepts only the validated full GENCODE v45 package. The smaller SP1 acceptance package is available only through the explicitly labeled command `./run_local.sh --dev-fixture`.

The launcher does not open a browser unless `--open` is supplied, does not bind beyond loopback, and does not fetch annotation, reference, fonts, scripts, search results, or telemetry from the internet.

## Find and navigate annotations

The shareable source distribution does not include the generated SP1 fixture or full SQLite package. Build a local package first; the command bar accepts:

- gene symbols and transcript names, such as `SP1` and `SP1-201`;
- versioned or unversioned ENSG, ENST, ENSP, and ENSE identifiers; and
- coordinates such as `chr12:53,380,176-53,416,446`.

Exact matches rank first. Submitting a gene symbol with exactly one matching gene record navigates directly to that gene, even when the bounded result palette also contains its transcripts or other genes that share the prefix. When distinct gene records carry the same exact symbol, choose one by stable ID, chromosome, biotype, and locus; the application does not guess. A direct transcript, protein, or exon result resolves its owning transcript/gene before navigation.

After choosing a result, the command field closes and relinquishes focus. Click it again to begin another search immediately; delayed result-palette cleanup cannot close a newly focused search.

The **Recents / Favorites** control beside search records a gene or transcript only after navigation succeeds. Recents are deduplicated by stable base identifier and retain the latest 25 entries. Favorites are explicit, preserve their user order, and are limited to 100. Both are local to this browser profile, origin, and immutable annotation build. A stale entry is reported without changing the current view, and an ambiguous symbol is never guessed.

After a gene loads, **Find current transcript** searches every current-gene transcript in the current custom visual order by transcript name, base or versioned ENST, available protein ID, and biotype. Its result includes the position and compact identity metadata. **Previous** and **Next** move through filter-matched transcripts without wrapping. Selecting a result requests one reveal, updates the inspector, then releases the scroll viewport; lazy detail or feature loading cannot pull the row back into view.

Global transcript shortcuts are available when focus is not in a text control, menu, or modal:

- `/` focuses global search.
- `J` and `K` select the next or previous filter-matched transcript.
- `P` toggles the selected transcript’s pin.
- `C` opens/focuses comparison mode.
- `Shift+C` assigns the current selection as comparison context and selects a second row when available.

Page Up, Page Down, Home, and End navigate the transcript viewport. A shortcut prevents browser default behavior only when the application actually handles it.

Use **Fit gene** or **Fit transcript** for an explicit jump. Drag the genomic Canvas to pan, drag the ruler to select an interval, double-click to zoom, or use the zoom buttons. A vertical wheel continues to scroll the page. A horizontal trackpad gesture pans; Ctrl/Cmd-wheel zooms around the pointer. When the Canvas has keyboard focus, Left/Right pans and Plus/Minus zooms.

Broad loci use precomputed density and packed genes. Below the detail thresholds, individual transcript models appear. Selected and pinned entities remain available when automatic level-of-detail would otherwise suppress transcript rows.

## Inspect transcripts and proteins

Fresh gene navigation defaults to **Protein features**, selects the first available translated transcript, and opens its protein-feature row. This default applies to a new gene search or explicit gene choice; an explicit URL, imported session, Back/Forward state, or restored last view remains authoritative and keeps its requested track-content mode and expansion set.

Transcript disclosure and pin controls are native buttons in every transcript-content mode. Opening a translated transcript switches to **Protein features**, loads that transcript’s feature rows locally, and renders two deliberately separate coordinate systems:

- exon-confined genomic projections on the shared genomic scale; and
- a continuous N-to-C amino-acid inset with its own scale.

Disclosures are additive rather than accordion-like. Up to 25 translated transcripts may remain expanded simultaneously; opening another does not collapse earlier rows, and collapsing one leaves the others open. At the bound, the browser asks you to collapse a row before opening another instead of silently replacing or omitting one. The expansion set is preserved in URL, portable-session, and validated last-view state.

Expanded rows reserve their geometry from the active feature-source selection before asynchronous records arrive. Loading, success, an empty valid result, or a retry therefore fills the same reserved row without moving later transcripts or changing the user’s scroll position.

A feature crossing a splice junction is drawn as multiple CDS pieces, never as an intron-spanning rectangle. Hover cross-highlights the continuous feature and its genomic pieces; click pins it in the inspector. If several features share the pointer location, choose one from the overlap menu. The inspector’s table remains a keyboard-accessible alternative.

Source filters preserve the seven independent local sources. InterPro, Pfam, and CDD remain source annotations; the interface does not invent domain/family/site classes absent from the local files. `biomaRt` is shown as a retrieval method, not evidence.

The **Prediction class** menu is intentionally narrower than source filtering. It derives four typed classes only from their single-purpose inputs: TM helix from TMHMM, signal peptide from SignalP, disorder from MobiDB-lite, and linear motif from ELM. It never reclassifies InterPro, Pfam, or CDD rows.

The **Transcripts** menu filters biotypes and can require any selected annotation flag: MANE Select, MANE Plus Clinical, Ensembl canonical, APPRIS principal, GENCODE Basic, or CCDS. With no flag selected, all flag states qualify. The selected transcript and pinned transcripts remain visible even when an ordinary filter would exclude them, and the menu reports that retained context.

To compare two isoforms more closely, select one transcript as the anchor and open the **↕ Reorder** control on the other row. Move it one visible row at a time, or place it directly above or below the selected transcript. This changes only the visual order shared by the label rail and Canvas; transcript identity, genomic coordinates, features, filtering, and the immutable annotation package do not change. The **Order** menu reports whether a custom order is active and restores the original order in one action. Keyboard users can Tab to every reorder control, and focus follows a row after it moves.

For an explicit two-column comparison, select the anchor and then set the second transcript with the current-gene navigator’s **Comparison transcript** selector, a row’s **Compare** control, or a pinned row’s **Compare** control. The selected and comparison transcripts must be different members of the current gene. The **Compare** inspector distinguishes genuine zero from missing, not applicable, and not-yet-loaded values while showing IDs, biotype, support and annotation level, structural lengths, exon count, CCDS/APPRIS, scientific flags, per-source feature counts, and shared/unique tags. Actions can swap selected/comparison, clear or pin comparison, and place comparison immediately above or below selection. Merely opening comparison never changes transcript order or scroll position.

Custom order is gene-scoped. Hidden filtered rows retain their relative place, selected/pinned context remains visible, and the selected transcript’s immediate neighbors remain in the bounded display even when a large gene exceeds the initial 120-row logical limit. Choosing a different gene starts from that gene’s original order.

The command bar’s **Track content** selector separates biological content from row density: **Automatic by zoom**, **Gene overview**, **Transcript spans**, **Exon structures**, and **Protein features**. Choosing **Protein features** opens the selected translated transcript without closing any other expanded row. The **View** menu independently switches between compact and comfortable row density. It also enables or disables Canvas arrow-key pan and Plus/Minus zoom; pointer gestures remain available when keyboard shortcuts are disabled. **Restore last view** controls automatic startup restoration, and **Clear saved workspace** removes build-scoped recents, favorites, notes/tags, PDF preset, and last view from this browser profile after explicit activation.

The Sequence inspector lazily loads the full coding-transcript record, GTF-derived CDS, or protein record. It never synthesizes missing sequence. Copy controls use versioned identifiers by default.

Large collections are viewport-windowed. The transcript label rail and Canvas share the same complete layout while mounting/drawing only visible rows plus overscan. The feature table and sequence viewer likewise mount a scrolling window while preserving their total row/line counts, keyboard-accessible positions, and full-sequence copy behavior. Scrolling, not a reduced biological result, reveals the remaining records.

When transcript rows overflow, a slim vertical minimap summarizes that same shared layout. Its viewport indicator tracks the visible row interval, and separate non-color-only markers identify selected, comparison, and pinned rows. Click or drag the minimap for an explicit scroll; focus it and use Arrow Up/Down, Page Up/Down, Home, or End for the keyboard equivalent. It is hidden when the transcript workspace does not overflow and never mounts a second full transcript list.

## Add private local notes and tags

The Gene and Transcript inspector tabs provide fields labeled **Local user note** and **Local user tags**. These are personal annotations, not GENCODE, Ensembl, HGNC, or protein-feature evidence. They are stored only in the browser’s build-scoped workspace and never mutate the read-only annotation database.

Notes autosave after a short debounce and report saved or validation status. One note may contain at most 5,000 characters; an entity may have at most 10 tags, each no longer than 40 characters. Delete removes that entity’s local annotation explicitly. Notes and tags may appear in comparison CSV/TSV exports and portable sessions, but are excluded from scientific PDF reports.

Importing a portable session validates its schema and annotation build before presenting an annotation merge. The merge is an explicit action: missing annotations are added, a strictly newer imported annotation may replace an older local value, and a newer or same-time conflicting local annotation is preserved and reported. Import never silently overwrites newer local work.

## Understand empty and off-screen states

The interface distinguishes:

- no annotated gene in the requested interval;
- a noncoding transcript with no translated product;
- a translated product with no features in the active local sources;
- a transcript/sequence kind absent from the cache;
- a partial or unresolved translation that can show a continuous amino-acid annotation but no genomic projection; and
- a pinned transcript or selected gene outside the current genomic view.

The last case preserves context and offers **Return to transcript/gene**. Package, checksum, schema, or build-lineage failures stop normal startup with remediation rather than producing a half-functional browser. An optional whole-genome reference may be absent; in that case only reference-range capability is unavailable.

## Preserve and export a view

The URL stores the build hash, locus, selected gene/transcript/comparison/feature, custom transcript order, expanded and pinned rows, source filters, typed prediction classes, excluded transcript biotypes, required transcript flags, row density, Canvas-keyboard preference, display mode, and inspector tab. Search/coordinate/fit actions create history entries; live pan, zoom, filters, ordering, view settings, and disclosure changes update the current entry. Browser Back/Forward restores the complete research state.

The schema-1 local workspace uses the key `transcript-browser:workspace:v1`, is capped at 512 KiB, and is accepted only when its build hash matches the verified manifest. It persists a ready, validated last view after a 400 ms debounce; scrolling alone is not stored continuously. On startup, automatic restoration runs only when **Restore last view** is enabled and the page has no explicit view parameters. Any explicit deep link wins. Corrupt, unsupported, oversized, or build-mismatched workspace data is safely ignored rather than partially trusted.

**Copy view** is reusable on the same installation and immutable build. For another installation, export a bounded session JSON containing view state and optionally local annotations. Import refuses an oversized file, malformed state, unsupported schema, or mismatched build hash. Imported annotation changes require the explicit merge described above.

### Export a transcript comparison

Comparison export writes selected plus comparison transcripts and can optionally add pinned rows. The export is restricted to one gene and no more than 20 transcripts, preserves the current custom visual order, and refuses stale or cross-gene transcript IDs rather than silently dropping them.

CSV and TSV use stable columns for immutable build/gene/transcript identities, structural and support metrics, scientific flags, per-source feature counts, selected/comparison/pinned roles, and clearly labeled local note/tag fields. Empty, unavailable, and not-applicable values remain distinguishable. Correct delimiter quoting is applied, and user-authored fields beginning like spreadsheet formulas are neutralized. The deterministic filename contains a safe gene symbol, annotation-build identity, and export format.

## Start without Terminal on macOS

Double-click **Transcript Browser.app** on the Desktop. Its small native status window starts the verified server only on `127.0.0.1`, waits for the immutable manifest, and opens the workspace in the default browser. Use **Open Browser** to reopen the page. Use **Stop & Quit**, close the launcher window, or choose Quit to stop the server process owned by the launcher.

Application version `1.1.2` identifies these interface and launcher capabilities. The annotation build hash identifies scientific content. Updating the application does not change the GENCODE/Ensembl/assembly data unless a separately verified annotation build is installed.

The 2026-07-14 search-resolution source patch is `1.1.2` build 4. It makes a unique exact gene symbol navigate to the gene instead of treating same-gene transcript suggestions as ambiguity; genuine duplicate gene symbols still require an explicit choice. It changes no annotation database, schema, or build identity. Native installation and smoke evidence for this patch are recorded only after those steps run; see `docs/release_checklist.md`.

The preceding 2026-07-14 installed release was `1.1.1` build 3 and retained the same exact immutable annotation manifest. Its completed gate, native smoke, and production asset identities remain historical release evidence in `docs/release_checklist.md`.

The launcher expects the `transcript_browser` project beside it on the Desktop. Its one-time installer prepares a versioned private runtime under `~/Library/Application Support/Transcript Browser`; ordinary launches do not open Terminal. If the app is rebuilt or that private runtime is removed, run `./desktop_app/install_macos_app.sh` once from the project, then return to double-click use. If startup fails, keep the app and project together and inspect `~/Library/Logs/Transcript Browser/server.log`. The normal Terminal command remains available for development and release verification.

### Save a PDF report

Choose **Save PDF** in the status bar to create a structured report from the verified local package. The resulting PDF uses selectable text and vector transcript models; it is not a screenshot of the Canvas.

The dialog initially selects the current transcript and offers shortcuts for the selected transcript, selected plus pinned transcripts, or all filter-matched transcripts. You can also choose rows individually. The chooser uses the current filtered transcript list and preserves its custom visual order in the report, regardless of the order in which checkboxes were selected. One report may contain at most 20 transcripts.

Choose any combination of these sections:

- **Transcript summary:** versioned IDs, coordinates, lengths, biotype, flags, tags, and support facts.
- **Exon and CDS structure:** a shared-scale vector model and exon/CDS table.
- **Protein annotations:** rows from the currently active local feature sources, including amino-acid coordinates and projection status.
- **Sequence excerpt:** an exact interval from the full transcript, CDS, or protein sequence. Start and end are 1-based inclusive, and the same requested range is applied to each chosen transcript with an available sequence. An unavailable sequence is labeled rather than synthesized or silently omitted.

For exon/CDS structure, **Selected-transcript union** uses the minimum start through maximum end of all chosen transcripts on one shared scale. **Current locus** uses the visible genomic interval; only overlapping exon rows are listed, while each listed row retains its complete exon coordinate. All displayed genomic loci and sequence excerpts use exact 1-based inclusive ranges.

The local browser sends the bounded specification to `POST /api/v1/report/pdf`, verifies the immutable build and transcript ownership, and downloads the generated file. The hard limits are 20 transcripts, 2,000 feature rows, 20,000 total sequence characters, 10,000 characters in any one excerpt, 100 pages, and 25 MiB. Nothing is silently truncated: narrow the transcript/source/sequence selection or save additional batches when a limit is reached.

After a successful report, **Quick PDF** stores only the validated scope and section configuration for this annotation build. It can request selected only, selected plus comparison, or selected plus pinned in the current visual order. Before reuse, the browser validates the build, gene ownership, transcript availability, section choices, feature sources, structure scope, and any sequence range. A stale transcript, mismatched build, or invalid range opens the normal dialog with safe values; Quick PDF never silently omits a requested transcript or section.

PDF reports are designed for reading and sharing, while bounded JSON/TSV exports remain the machine-oriented formats for downstream analysis. PDFs are not tagged and do not claim PDF/UA accessibility conformance. They use portable standard PDF fonts; unsupported glyphs may be replaced. The custom Canvas release still does not promise screenshot/SVG export, so use operating-system capture when an image of the live workspace is specifically required.

## Copy support diagnostics

Open **About & diagnostics** from the status bar to see application version, immutable annotation build, GENCODE/Ensembl/assembly/schema declarations, runtime capabilities, PDF availability, current gene/transcript, viewport/DPR, loopback service origin, and observed external-resource count. **Copy diagnostics** produces bounded plain text suitable for a colleague or support report.

The copied receipt deliberately excludes notes, tags, search and recent history, sequences, absolute home-directory paths, usernames, and non-loopback URL details. Application version and annotation build remain separate lines so an interface upgrade cannot be mistaken for changed scientific content.

## Coordinate conventions

Displayed loci and copied prose are 1-based inclusive. SQLite, the JSON API, cache keys, and Canvas transforms use integer 0-based half-open `start0`/`end0` fields. Amino-acid annotations retain 1-based inclusive start/end positions. See `docs/coordinate_contract.md` before interpreting or extending projection data.

## Troubleshooting

- **Normal startup refuses the package:** rebuild with `./scripts/build_annotations.sh data/cache --scope full`, then rerun. Add `--full-database-verify` to the launcher for the slow database integrity gate; use `--full-reference-verify` only when the optional reference is present.
- **An optional reference receipt/checksum fails:** follow `docs/reference_setup.md`, or omit the reference and rebuild the transcript/protein-only package; do not edit the active manifest by hand.
- **A search is missing an alias:** v1 indexes local GTF names and stable IDs. It does not claim a complete HGNC synonym catalog or typo-tolerant search.
- **The previous view did not restore:** an explicit URL takes priority, restoration may be disabled, or the saved workspace may belong to another annotation build/browser profile. Open the View settings before assuming data loss.
- **A 26th protein row will not open:** simultaneous protein-feature expansion is intentionally bounded to 25 rows. Collapse any open protein row, then expand the additional transcript.
- **Recents, favorites, or notes differ in another browser:** these are intentionally browser-profile-local and are not synchronized. Use a portable session and its explicit annotation merge when transfer is intended.
- **Quick PDF opens the full dialog:** its saved preset was absent, stale, build-mismatched, or unsafe for the current transcripts/range. Review the prefilled bounded options rather than expecting silent truncation.
- **The interval is dense or truncated:** zoom in. API and render bounds deliberately prevent full-chromosome transcript payloads.
- **A large gene shows only part of its transcript list at once:** use **Show more** to raise the bounded logical display limit, then use the current-gene navigator, minimap, or transcript workspace scroll. The live DOM/Canvas window remains small even when all summaries are available.
- **Keyboard/gesture reminder:** open **Keyboard & gestures** in the status bar.
