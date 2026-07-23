# Local Transcript and Protein-Feature Browser

Implementation-ready product and engineering plan

> This document is retained as design provenance for the browser. It has been
> sanitized for distribution: local workstation paths and generated annotation
> data are represented by placeholders and are not part of this repository.

Prepared from:

- A local, audited GENCODE v45 annotation cache (not included in this repository)
- The current Ensembl SP1 gene/transcript/protein views as an information reference
- IGV and igv.js as the reference for direct genome navigation
- UCSC Genome Browser as the reference for track density, exon semantics, and coordinate controls

The Ensembl interface is a reference for useful biological organization only. Its brittle loading, dense page hierarchy, and page-to-page state loss should not be reproduced.

## 1. Executive decision

Build a focused, offline-first local web application with:

- A **React + TypeScript** interface.
- A **pinned igv.js** genome viewport for proven panning, zooming, locus navigation, rulers, and browser events.
- One **custom Canvas2D transcript/protein track** for transcript rows and inline protein-feature expansion.
- A **FastAPI** local server that serves the built application and a read-only JSON API.
- A deterministic preprocessing pipeline that converts the raw GENCODE v45 GTF, FASTAs, and protein-feature RDS files into a versioned **SQLite** database with full-text and interval indexes.
- A one-command launcher bound only to **127.0.0.1**, with no telemetry, CDN, remote fonts, or runtime internet dependency.

The architecture must pass an early SP1 technical spike before the full product is built. The spike proves that an expanded transcript row can change height, remain aligned during pan/zoom, support accurate hit-testing, and restore its state from the URL. If the igv.js custom-track extension is unstable, retain the same React, API, and database design but replace only the genome viewport with a custom DOM + Canvas2D renderer.

The local cache is sufficient for the annotation and protein-feature layers, but it is **not by itself sufficient for the final igv.js application**, because it contains transcript/protein FASTAs but no whole-genome GRCh38 FASTA or 2bit file. A checksum-verified local GRCh38 reference sequence is therefore the one additional required data prerequisite for version 1. It may be supplied as a 2bit file or as BGZF FASTA plus FAI/GZI; it is acquired once during setup and is never fetched at runtime.

Accurate chromosome bounds are mandatory. The implementation should bundle a small provenance-stamped, checksum-pinned **GRCh38.p14 primary-contig chrom.sizes** manifest alongside the reference. It must never infer chromosome length from the last annotated feature.

System flow:

    Raw GTF + transcript/protein FASTAs + feature RDS + reference + chrom.sizes
                                   │
                                   ▼
                    Deterministic annotation builder
                  parse → normalize → project → validate
                                   │
                                   ▼
                 SQLite + manifest + local reference index
                                   │
                                   ▼
                      Local FastAPI read-only service
                                   │
                                   ▼
        React application shell + igv.js adapter + custom transcript track
                                   │
                                   ▼
           Search, pan/zoom, inline protein expansion, inspector, export

## 2. Product goal

Create a fast, aesthetically restrained browser in which a researcher can:

1. Find a gene, transcript, protein, exon, or genomic interval immediately.
2. Pan and zoom through GRCh38 without leaving the page.
3. Compare all GENCODE v45 transcript models for a locus.
4. Expand any translated transcript directly beneath its genomic model.
5. See protein features both:
   - projected correctly onto their coding exon segments in genomic coordinates; and
   - continuously on an N-to-C amino-acid ruler.
6. Cross-highlight protein features, coding segments, exons, and sequences.
7. Inspect identifiers, annotation flags, feature provenance, and sequences without opening Ensembl.
8. Reopen or share an exact local view through URL state.

The product should feel like a purpose-built scientific instrument, not a general database portal.

## 3. Scope

### 3.1 Version 1 scope

- Human GENCODE v45 on GRCh38.p14 / Ensembl 111, with the p14 label verified through a bundled release manifest and matching reference checksum.
- Comprehensive gene and transcript structures from the raw GTF.
- Protein-coding transcript and protein sequences from the two local FASTAs.
- Protein features from InterPro, Pfam, CDD, TMHMM, SignalP, MobiDB-lite, and ELM.
- Gene-, transcript-, protein-, exon-, and coordinate-based navigation.
- Canonical/MANE/APPRIS/Basic/CCDS/TSL flags preserved as separate concepts.
- Protein feature filtering, hover inspection, persistent details, and sequence views.
- Fully local operation after installation and preprocessing.
- Export of current locus metadata and selected transcript/feature data as JSON/TSV; screenshot/SVG export if supported reliably by the selected renderer.

### 3.2 Explicit non-goals for version 1

- Reimplementing the complete Ensembl or UCSC ecosystem.
- Read alignments, BAM/CRAM pileups, variants, expression, conservation, repeats, or regulatory tracks.
- Comparative genomics, orthologues, paralogues, phenotypes, or external database lookups.
- Editing the annotation.
- Multi-user authentication or a network-hosted service.
- Inferring that overlapping predictions from different feature sources are equivalent.
- Requiring an internet connection at runtime.

The architecture may leave clean extension points for later sample tracks, alternative splicing events, variants, and expression, but they should not complicate the first release.

## 4. What to borrow from the reference browsers

| Reference | Keep | Improve |
|---|---|---|
| Ensembl | Gene to transcript to protein hierarchy; stable IDs; transcript flags; protein domains aligned with alternating exon segments | Keep everything on one responsive workspace; eliminate page transitions, global loading spinners, and dense permanent navigation |
| IGV | One locus box; drag-to-pan; ruler sweep-to-zoom; double-click/controls to zoom; compact feature popups; locus history | Add domain-specific transcript labels, true per-transcript expansion, and a persistent inspector |
| UCSC | Thin UTR versus thick CDS; intron direction arrows; fixed label rail; semantic density modes; explicit coordinate controls; item details | Replace the legacy control grid with contextual controls and progressive disclosure |

Relevant primary references:

- [Ensembl Gene Summary help](https://www.ensembl.org/Help/View?id=143)
- [Ensembl genome/transcript training](https://training.ensembl.org/events/2024/2024-03-04-MSU_browser)
- [IGV-Web user guide](https://igv.org/doc/webapp/UserGuide/)
- [igv.js Browser API](https://igv.org/doc/igvjs/Browser-API/)
- [igv.js reference genome configuration](https://igv.org/doc/igvjs/Reference-Genome/)
- [igv.js data-server and HTTP range requirements](https://igv.org/doc/igvjs/Data-Server-Requirements/)
- [UCSC Genome Browser guide](https://genome.ucsc.edu/goldenPath/help/hgTracksHelp.html)
- [UCSC track decorators](https://genome.ucsc.edu/goldenPath/help/decorator.html)
- [GENCODE release history](https://www.gencodegenes.org/human/releases.html)
- [GENCODE GTF format](https://www.gencodegenes.org/pages/data_format.html)

## 5. Information architecture and layout

Use a four-part shell:

    ┌──────────────────────────────────────────────────────────────────────────┐
    │ Global command bar | locus | back/forward | zoom | v45 build badge      │
    ├────────────────┬───────────────────────────────────────┬─────────────────┤
    │ Sticky labels  │ Coordinate ruler and genomic canvas  │ Inspector       │
    │ Gene/transcript│ Gene and transcript rows             │ Selection facts │
    │ names + badges │ Expandable protein-feature panels    │ Sequences/table │
    │                │                                       │                 │
    ├────────────────┴───────────────────────────────────────┴─────────────────┤
    │ Compact status: build hash, loading/error state, keyboard help          │
    └──────────────────────────────────────────────────────────────────────────┘

### 5.1 Global command bar

The command bar remains visible while scrolling and accepts:

- Gene symbols, such as **SP1**
- Versioned or unversioned ENSG, ENST, ENSP, and ENSE identifiers
- Transcript names, such as **SP1-201**
- Protein identifiers
- Coordinates in **chr:start-end** form
- Optional future commands such as **aa 626-650**, **exon 4**, or **fit transcript**

Autocomplete is grouped by entity type. Exact ID and exact symbol matches rank above prefix matches. Every ambiguous symbol result includes chromosome, stable ID, biotype, and coordinate. This is required because the cache contains 96 symbols that map to more than one stable gene ID. Typo-tolerant search can be added later through a dedicated edit-distance index; it must not be implied by FTS5.

The right side of the bar shows:

- **GENCODE v45 · Ensembl 111 · GRCh38.p14**
- Current coordinate span
- Back/forward locus history
- Fit gene / fit transcript
- Zoom out, zoom in, and a compact scale control
- Display mode
- Settings/help

### 5.2 Sticky label rail

The label rail does not pan horizontally. Visible transcripts are grouped beneath gene headers. The selected gene is emphasized; neighboring genes can be muted or collapsed; transcripts are ordered deterministically by biological priority and then genomic/transcript order. This prevents a flat list from mixing isoforms from adjacent genes.

Each transcript row shows:

- Disclosure chevron
- Transcript name
- Stable transcript ID, with the version visible on hover or in the inspector
- Biotype
- Transcript, CDS, and protein lengths as applicable
- At most two or three highest-value badges inline, plus an overflow count; all MANE, Ensembl Canonical, APPRIS, GENCODE Basic, CCDS, annotation-level, and TSL facts remain visible in the inspector
- Pin/star and context menu on hover

The transcript row control must be a real keyboard-focusable DOM button. The shared layout engine publishes row geometry to both the DOM rail and Canvas track so they stay aligned.

The selected transcript’s complete versioned ENST remains visible in the rail or inspector header, and copy actions use the versioned ID by default.

### 5.3 Genomic canvas

Use familiar biological semantics:

- UTR: thin outlined exon block
- CDS: thick filled exon block
- Intron: muted connecting line
- Strand: repeated arrowheads on introns and a clear direction label
- Selected transcript: stronger outline and subtle background band
- Canonical/MANE transcript: sorted first by default, but never silently treated as the only transcript
- Noncoding transcript: visible with an explicit **No translated product** state

A searched, selected, or pinned gene/transcript must remain rendered even when automatic level-of-detail rules would normally hide that entity. A direct transcript jump automatically chooses a useful span and display mode rather than landing on a density-only view.

Canvas rendering is appropriate because visible transcript models number in the tens to low hundreds, while text and hit-testing remain important. WebGL should not be introduced unless future BAM-scale data makes it necessary.

### 5.4 Inspector

The right inspector is collapsible and changes with selection:

- Gene tab: symbol, stable ID/version, locus, strand, biotype, transcript count, tags, and quick actions
- Transcript tab: IDs, name, biotype, flags, exon/CDS structure, lengths, feature counts, and sequence actions
- Feature tab: source, accession, display name, amino-acid interval, CDS interval, genomic pieces, contributing exons, method, and local provenance
- Sequence tab: full protein-coding transcript and protein sequences where available, with exon/CDS overlays and copy/export controls
- Table tab: filterable protein-feature table for the selected transcript

The inspector replaces Ensembl-style navigation to separate transcript, domain, and sequence pages.

## 6. Core interaction specification

### 6.1 Navigation

Use an explicit gesture contract that does not hijack normal page scrolling:

- Drag the genomic canvas: pan genomic coordinates.
- Horizontal trackpad gesture: pan genomic coordinates.
- Pinch or Ctrl/Cmd-wheel over the canvas: pointer-centered zoom.
- Ordinary vertical wheel: scroll the page/transcript rows.
- Drag across the ruler: zoom to the selected interval.
- Double-click the canvas: zoom in.
- Plus/minus and scale controls: accessible non-gesture zoom.
- Click chromosome context to move at broad scale; show an ideogram only when optional cytobands are configured.
- Back and forward restore complete locus state, not just coordinates.
- Use history replaceState during live pan/zoom and passive changes. Push a new browser-history entry only for completed searches, coordinate submissions, and explicit fit/jump actions; back should not step through every hover, filter, inspector tab, or disclosure animation.
- The URL records build, locus, selected gene/transcript, expanded rows, feature-source filters, display mode, and inspector tab.
- A local URL is guaranteed reusable only on the same installation and build hash. Cross-machine sharing uses a small exported session JSON containing the required build hash; restoration against a mismatched build is rejected with a clear explanation.
- Loading is local to the affected track or panel; a slow feature request must not block navigation.
- Stale requests are aborted when the locus changes.

### 6.2 Semantic display modes

Use four understandable modes rather than UCSC’s legacy terminology:

- **Overview**: density bins and packed gene labels at broad genomic spans.
- **Compact**: genes and condensed transcript groups.
- **Labeled**: individual transcript models with names and badges.
- **Expanded**: individual models plus permitted open protein panels.

Automatic level of detail is the default, with a manual override. Initial thresholds should be benchmarked, with the following starting points:

- Greater than 5 Mb: density/genes only
- 250 kb to 5 Mb: packed genes and selected transcript summaries
- Less than 250 kb: individual transcripts
- Protein features: lazy-load only for expanded transcripts

Selected and pinned entities override these thresholds. The renderer may simplify neighbors, but it must keep the target entity and enough parent context visible.

### 6.3 Transcript expansion

Collapsed row:

- One genomic transcript model, badges, and feature count.

Expanded row:

1. **Genome projection lane**
   - Protein features are split across the coding exon pieces they actually occupy.
   - A domain spanning an intron is never drawn as one solid genomic rectangle.
   - Overlapping features stack into sublanes.
   - Source/class filters update without changing the locus.

2. **Continuous protein lane**
   - A visually bounded inset with a clearly separated N-to-C amino-acid ruler.
   - Fit the complete protein N-to-C by default.
   - Do not pan it with the genomic axis and do not draw shared vertical gridlines between the two coordinate systems.
   - Show a brush/window on the protein inset for the CDS portion currently visible in genomic coordinates.
   - Preserve a pinned expansion if its transcript moves outside the genomic viewport, while clearly labeling it **outside current view** and offering **Return to transcript**.
   - Alternating exon shading derived from CDS boundaries.
   - Represent phase-split codons at exon junctions with striped/split markers and phase-aware tooltips; do not assign a residue wholly to one exon when its codon crosses the junction.
   - Continuous domain/motif blocks using amino-acid coordinates.
   - Its independent amino-acid scale is labeled prominently so it cannot be confused with genomic coordinates.

3. **Cross-highlighting**
   - Hovering a continuous feature highlights all of its projected genomic fragments.
   - Hovering a genomic fragment highlights the whole feature and involved exon portions.
   - Clicking pins the selection in the inspector.

4. **Feature controls**
   - Source dimension: InterPro, Pfam, CDD, TMHMM, SignalP, MobiDB-lite, ELM
   - Explicit class dimension only where the local source makes the class defensible: transmembrane-helix prediction (TMHMM), signal peptide (SignalP), disorder (MobiDB-lite), and short linear motif (ELM).
   - InterPro, Pfam, and CDD remain source-labeled annotation lanes in version 1 unless a separate typed ontology is imported. InterPro’s local rows do not contain entry type, so the UI must not guess domain/family/repeat/site class.

Only one transcript should auto-expand at a time. Users may pin multiple open panels deliberately. This avoids extreme vertical growth in genes with many isoforms.

### 6.4 Feature visual language

Color should primarily encode the local feature source in version 1, because that provenance is actually present in the cache. Explicit single-purpose sources may also carry familiar semantic styling:

- InterPro, Pfam, and CDD: distinct source colors and labels; no inferred entry class
- TMHMM: transmembrane-helix prediction styling
- SignalP: signal-peptide prediction styling
- MobiDB-lite: disorder styling
- ELM: short-linear-motif styling
- Selected/cross-highlighted feature: a shared high-contrast focus outline

Never rely on color alone. Every feature remains identifiable by label, outline, hover text, and inspector contents. Overlapping calls remain separate records unless the user explicitly asks for a collapsed consensus view.

The local method value **biomaRt** is labeled as a retrieval method, not biological evidence.

Tiny features receive a minimum visible marker and a larger invisible hit target, while the inspector always reports their exact interval. Visually enlarged markers must be styled differently from true-width blocks. If several features share the pointer location, show a small chooser rather than silently selecting one. All features remain reachable through the keyboard-accessible table.

## 7. Visual and aesthetic direction

### 7.1 Principles

- Quiet neutral background; data receives the visual emphasis.
- Strong hierarchy with a slim top bar, restrained borders, and minimal card chrome.
- Generous whitespace outside the canvas; compact but not cramped transcript rows.
- One primary selection accent.
- Smooth 120–180 ms transitions for row expansion and inspector changes.
- Skeletons for local data arrival; no global blocking spinner.
- Localized, actionable errors with retry and diagnostic details.
- Stable layout during loading to avoid jumping rows.
- A persistent compact legend with **Genomic coordinates (1-based display)**, a genomic distance scale, and **N — amino-acid position — C** on every protein inset.

### 7.2 Typography and sizing

- Use a locally available/system sans-serif stack; no remote font request.
- Use tabular numerals for coordinates and sequence positions.
- Default transcript text 13–14 px, with a user-selectable compact/comfortable density.
- Minimum target size 32 px for frequently used controls; full keyboard access for all actions.
- High-DPI Canvas rendering with device-pixel-ratio tests at 1 and 2.

### 7.3 Accessibility

- WCAG AA color contrast.
- Coding versus UTR distinguished by weight, fill, and outline.
- Real DOM controls for search, transcript disclosure, filters, and menus.
- Accessible names containing transcript name and ID.
- Visible focus styles.
- Keyboard shortcuts documented and user-disableable.
- Reduced-motion preference respected.
- Canvas selection mirrored in a screen-reader-readable inspector/table.

## 8. Local data audit

The cache occupies about 201 MiB on disk and has two different annotation layers. They must not be conflated.

### 8.1 Sources of truth

| File | Approximate size | Contents | Planning decision |
|---|---:|---|---|
| gencode.v45.annotation.gtf.gz | 47 MiB | Full GENCODE v45 annotation feature rows: 63,187 gene, 252,930 transcript, 1,650,704 exon, 885,749 CDS, 384,769 UTR | Authoritative structure, versions, repeated tags, CDS, UTR, phase |
| gencode.v45.pc_transcripts.fa.gz | 46 MiB | 111,048 full spliced protein-coding transcript records | Authoritative full protein-coding transcript sequences and header metadata |
| gencode.v45.pc_translations.fa.gz | 11 MiB | 111,048 protein records | Authoritative protein sequences |

The raw GTF header identifies GENCODE v45, GRCh38, Ensembl 111, dated 2023-09-19. The bundled release manifest must record the official v45-to-GRCh38.p14 mapping before the UI uses the p14 badge. Its genomic coordinates are 1-based closed intervals.

These are GTF feature-row counts, not necessarily distinct biological entities: an exon shared by multiple transcripts can occur more than once. The build report must publish both feature-row counts and distinct stable-ID counts wherever an ID exists.

### 8.2 Processed helper files

| File | Shape | Use | Important caveat |
|---|---|---|---|
| human_gencode_v45.gtf.rds | 863,066 × 58 | Derived per-exon CDS/UTR/frame fields and validation | Lossy subset: only 44,188 genes, 102,198 transcripts, and 716,680 exons; version suffixes removed; repeated tags collapsed; one SP1 transcript omitted |
| human_gencode_v45_sequences.rds | 111,048 × 7 | Fast CDS/protein validation | transcript_seq is coding DNA-like, not the full spliced transcript; 60,063 rows have missing gene linkage because of the subset mismatch |
| human_gencode_v45_hybrids.rds | Two tables, 95,635 and 109,921 rows | Optional alternative first/last-exon relationship view | Not an exon-level protein-feature table |

The raw GTF and FASTAs must drive the product. The processed GTF RDS is used only as a helper and validation source.

The processed GTF contains 51,016 protein IDs, while only 50,985 of those have a matching translation record; the 31 known exceptions are protein_coding_LoF transcripts. They are expected classified exceptions, not permission to synthesize a protein sequence. The full-transcript field must come only from the protein-coding transcript FASTA, CDS must be extracted from its documented interval/GTF structure, and the RDS transcript_seq column must never populate the full-transcript field.

### 8.3 Protein-feature files

Every feature table contains transcript ID, 1-based inclusive amino-acid start/stop, chromosome, strand, feature ID/name, source, peptide ID, and method.

| Source file | Rows | Distinct transcripts | Distinct feature IDs |
|---|---:|---:|---:|
| interpro.rds | 426,721 | 42,321 | 16,298 |
| mobidblite.rds | 97,414 | 23,712 | 1 |
| pfam.rds | 88,496 | 38,958 | 6,449 |
| cdd.rds | 35,697 | 20,604 | 6,733 |
| tmhmm.rds | 32,513 | 9,659 | 1 |
| signalp.rds | 6,085 | 6,085 | 2 |
| elm.rds | 3,179 | 1,844 | 275 |

Combined: 690,105 records over 43,464 distinct transcript/protein pairs.

Validation found:

- Every feature joins to the processed transcript and sequence records.
- No invalid, fractional, or protein-out-of-range amino-acid coordinates.
- Chromosome and strand agree with the transcript annotation.
- The genomic interval embedded in the feature name is only a bounding span and can include introns. It must not be used directly for drawing.
- Source releases, scores, e-values, and detailed evidence are absent. The UI must present only the provenance actually present: source/database, accession, method, and local build.

### 8.4 SP1 acceptance fixture

The raw v45 GTF contains four SP1 transcripts:

- SP1-201 / ENST00000327443.9 / ENSP00000329357.4
- SP1-202 / ENST00000426431.2 / ENSP00000404263.2
- SP1-203 / ENST00000548560.1 / ENSP00000458133.1
- SP1-204 / ENST00000551969.5 / ENSP00000457804.1

The processed GTF RDS contains only three and omits SP1-203. Therefore, an SP1 page showing only three transcripts is a build failure.

For retained SP1 transcripts, the local feature files contain:

- 20 InterPro records across two transcripts
- 6 Pfam records across two transcripts
- 14 MobiDB-lite records across three transcripts
- 2 ELM records on one transcript
- No local CDD, TMHMM, or SignalP records

SP1-203 has a 230-aa local protein sequence but no local feature rows. The UI should show the transcript and protein and explicitly say **No features in the selected local sources**, not hide the transcript.

### 8.5 Data gaps

- No whole-genome GRCh38 FASTA/2bit, FAI/GZI, chromosome-size file, or cytoband file is present in the cache. Version 1 must add a checksum-matched local reference sequence and a provenance-stamped GRCh38.p14 chrom.sizes manifest; cytobands remain optional.
- No noncoding transcript FASTA.
- No gene synonym/alias catalog beyond names and IDs in the GTF; broader alias search requires an optional local HGNC import.
- No feature confidence scores or source-release metadata.
- No variants, repeats, expression, conservation, or regulatory data.

The reference-sequence/chromosome-manifest gap must be resolved in Phase 0 because igv.js requires a local reference definition. The remaining gaps are honest scope boundaries and do not block the first release.

## 9. Preprocessing and build pipeline

The runtime application should never parse multi-million-row GTF or RDS files interactively. Build one normalized immutable data package.

### 9.1 Inputs

Required:

- Raw v45 GTF
- Protein-coding transcript FASTA
- Protein translation FASTA
- Seven protein-feature RDS files
- Bundled checksum-pinned GRCh38.p14 primary-contig chrom.sizes manifest
- Checksum-matched local GRCh38.p14 2bit or BGZF FASTA plus FAI/GZI

Optional:

- Processed exon RDS for validation
- Hybrid RDS for later alternative-first/last-exon functionality
- Cytoband and chromosome-alias files
- Local HGNC alias table

### 9.2 Build stages

1. **Discover and validate inputs**
   - Check file existence and gzip integrity.
   - Compute SHA-256 checksums.
   - Read release/assembly metadata.
   - Refuse to silently mix assemblies or releases.
   - Validate the reference and chrom.sizes checksums against the bundled v45/GRCh38.p14 release manifest.

2. **Parse the raw GTF**
   - Stream 3,427,477 records.
   - Preserve all repeated attributes as one-to-many rows, especially tag.
   - Store base stable ID and numeric version separately.
   - Keep gene, transcript, exon, CDS, UTR, start/stop codon, phase, annotation level, TSL, HGNC ID, CCDS, Havana IDs, and all tags.
   - Normalize genomic intervals internally to 0-based half-open coordinates.
   - Keep database and machine API coordinates 0-based half-open with explicit start0/end0 field names.
   - Convert to familiar 1-based inclusive coordinates only for locus strings, labels, copied human-readable coordinates, and prose.

3. **Parse FASTA records**
   - Store both versioned and versionless ENST/ENSP/ENSG relationships from headers.
   - Validate transcript/protein lengths.
   - Compress sequence strings as per-record blobs or store in an indexed sequence sidecar; fetch only the selected record.

4. **Export and normalize RDS features**
   - Use a small R/data.table export step so the original RDS files are read reliably.
   - Normalize each source to one shared feature schema.
   - Preserve losslessly: feature_id, clean_name, alt_name, database, method, raw name, amino-acid start/stop, peptide ID, transcript ID, chromosome, strand, and the raw genomic bounding span for audit.
   - Generate a deterministic source-record ID from canonical source fields plus a stable duplicate ordinal, so feature URLs and selections survive rebuilds.
   - Preserve source records independently; do not collapse biologically overlapping calls.
   - Join versionless feature IDs to the authoritative versioned transcript/protein records.
   - Never render the raw genomic bounding span; only the validated projected segments are drawable.

5. **Project protein features through CDS exons**
   - Treat verified amino-acid positions as 1-based inclusive.
   - Establish the translation origin and end from the full protein-coding transcript FASTA header’s CDS interval and transcript-coordinate exon map.
   - Use raw GTF CDS intervals, phase, start/stop codon tags, and supplied translation sequence as independent validation.
   - Classify every translated transcript mapping as **exact**, **partial**, or **unresolved**, and persist the status and reason.
   - Only after establishing the translation origin, convert amino acids to a translation-relative half-open nucleotide interval:
     - nucleotide start = (amino-acid start − 1) × 3
     - nucleotide end = amino-acid end × 3
   - Order CDS segments in transcript 5-prime to 3-prime direction.
   - Intersect the feature interval with each CDS segment.
   - Map every intersection to genomic coordinates.
   - Invert the within-segment mapping correctly for reverse-strand transcripts.
   - Persist one feature-segment row per resulting exon piece.
   - Retain the continuous amino-acid feature as the parent record.
   - If an exact genomic mapping cannot be proven, keep the continuous amino-acid lane but do not draw a genomic projection; explain the partial/unresolved state in the inspector.

6. **Build search and interval indexes**
   - Exact normalized-term index for symbols and stable IDs.
   - SQLite FTS5 index for token and prefix discovery. Typo-distance search is out of scope unless a dedicated, tested candidate stage is added.
   - Integer UCSC-style hierarchical bins plus composite B-tree indexes for genomic overlap queries.
   - Do not store canonical chromosome-scale coordinates in SQLite’s default floating-point R*Tree. All canonical start0/end0 values remain integers.
   - Precomputed broad-scale gene-density bins.

7. **Write a build manifest and validation report**
   - Input checksums
   - Release and assembly
   - Entity/feature counts
   - Orphan joins
   - Sequence/translation concordance
   - Coordinate/projection failures
   - Build tool versions
   - Timestamp and schema version
   - Canonical per-table content hashes computed from stable ordered rows

8. **Publish atomically**
   - Build in a temporary directory.
   - Run all validation gates.
   - Rename into the active build only after success.
   - Keep the previous valid build until the new build is complete.

### 9.3 Projection validation invariants

- Amino-acid start is at least 1 and stop does not exceed protein length.
- Projected nucleotide coverage equals the expected amino-acid span, except explicitly recorded partial-CDS edge cases.
- Segment order follows protein order on both strands.
- Every projected segment lies within a CDS segment.
- Reconstructed CDS translation agrees with the supplied protein sequence, allowing documented terminal-stop conventions.
- Positive- and negative-strand golden fixtures produce exact expected coordinates.
- A feature crossing an exon junction creates two or more genomic segments, never an intron-spanning block.

## 10. Runtime database

Recommended logical tables:

| Table | Purpose |
|---|---|
| build_manifest | Release, assembly, input hashes, schema/tool versions, counts |
| contig | Required canonical name, integer length, display order, and optional aliases |
| gene | Base/versioned ID, symbol, HGNC ID, biotype, locus, strand |
| gene_alias | Optional local aliases/synonyms with provenance |
| transcript | IDs/version, gene, name, biotype, protein ID, lengths, level, TSL, canonical/MANE/APPRIS/Basic/CCDS fields |
| transcript_tag | Every repeated raw GTF tag |
| exon | Transcript, exon ID/version, transcript rank, genomic interval |
| cds_segment | Transcript/exon, genomic interval, transcript-relative interval, phase |
| utr_segment | Transcript/exon and genomic interval |
| protein_feature | Deterministic ID, parent continuous AA feature, lossless source/accession/names/method/raw audit fields |
| protein_feature_segment | Feature-to-CDS-exon projected genomic pieces in protein order |
| translation_mapping | Transcript translation origin/end, exact/partial/unresolved status, and validation reason |
| sequence | Explicit kind: transcript_full, cds, or protein; sequence or compressed sidecar reference |
| hybrid_relation | Optional terminal/internal transcript-exon relationships |
| search_entity | Exact normalized terms and ranking priority |
| search_fts | Token/prefix searchable names and identifiers |
| density_tile | Precomputed broad-scale gene/transcript counts |

Runtime database rules:

- Read-only connection after build.
- Foreign keys enabled during build validation.
- Prepared parameterized queries only.
- No unbounded region response.
- Schema version checked at startup.
- API refuses a database whose build manifest does not match the expected schema.

## 11. Local API contract

Use versioned endpoints:

| Endpoint | Purpose |
|---|---|
| GET /api/v1/manifest | Release, build hash, feature sources, capabilities, reference availability |
| GET /api/v1/search?q=SP1&limit=20 | Grouped exact/prefix entity search |
| GET /api/v1/region?chr=chr12&start0=...&end0=...&detail=auto | Level-of-detail-aware genes/transcripts in 0-based half-open machine coordinates |
| GET /api/v1/genes/{id} | Gene summary and transcript ordering |
| GET /api/v1/transcripts/{id} | Transcript/exon/CDS/UTR metadata |
| GET /api/v1/transcripts/{id}/features?sources=... | Parent AA features and projected genomic segments |
| GET /api/v1/transcripts/{id}/sequence?kind=transcript_full | Full protein-coding transcript sequence from pc_transcripts FASTA |
| GET /api/v1/transcripts/{id}/sequence?kind=cds | CDS extracted from the authoritative full transcript/GTF mapping |
| GET /api/v1/transcripts/{id}/sequence?kind=protein | Protein sequence |
| GET /api/v1/features/{id} | One feature with all segments and exon mappings |
| GET /api/v1/export?... | Bounded JSON/TSV export of current selection |

API behavior:

- Accept versioned and unversioned stable IDs.
- Return the resolved local version explicitly.
- Use integer start0/end0 for every machine-readable genomic interval and response. Human-facing locus strings remain 1-based inclusive.
- Disambiguate duplicate symbols instead of choosing silently.
- Cache immutable responses with ETags based on build hash and query.
- Over-fetch roughly one viewport on each side for smooth panning.
- Round regional cache keys to genomic tiles and include the detail tier or normalized bp-per-pixel bucket, so density and transcript responses cannot collide.
- Enforce result and coordinate-span limits.
- Use cancellable frontend requests so rapid panning does not queue stale work.
- Serve the required genomic reference same-origin with correct HTTP range headers and 206 responses as required by igv.js.

## 12. Frontend architecture

### 12.1 Main modules

- **AppShell**: top command bar, route/state restoration, global errors
- **SearchPalette**: grouped autocomplete, recent/pinned loci, coordinate parser
- **GenomeWorkspace**: igv.js lifecycle and locus synchronization
- **TranscriptProteinTrack**: custom track adapter, Canvas2D drawing, hit map, dynamic height
- **TranscriptLabelRail**: DOM labels, disclosure buttons, badges, menus
- **ProteinExpansionPanel controller**: React expansion/filter state; the custom track renders both genomic and AA Canvas geometry using the shared row layout
- **Inspector**: gene/transcript/feature/sequence/table tabs
- **FilterBar**: source, biotype, flag, and density filters
- **ExportMenu**: copy ID/coordinate, JSON/TSV, image/SVG where verified
- **BuildStatus**: immutable local build and capability information

### 12.2 State model

Keep three categories separate:

- URL state: locus, build, selected entity, expanded transcripts, filters, mode, inspector tab
- Server state: region/transcript/feature/sequence queries, cached by build hash
- Ephemeral UI state: hover, menu, temporary highlight, resize state

Suggested libraries:

- React Query or an equivalent small query cache for immutable API data
- Zustand or reducer-based local state for synchronized selection/expansion
- Zod or generated types for runtime API validation
- No global event bus

### 12.3 igv.js boundary

Treat igv.js as a replaceable adapter:

- Pin one exact package version.
- Configure loadDefaultGenomes as false and provide a fully local reference object; never use genome: hg38, which can resolve to remotely hosted assets.
- Disable or replace remote search and BLAT services so a missed local search cannot leave the machine.
- Wrap all custom-track registration and internal extension use in one module.
- Do not fork igv.js.
- Listen to official locus/track events through the adapter.
- Add contract tests for track height, coordinate transforms, click mapping, and image export.
- Keep search outside igv.js because indexed annotation tracks do not provide complete ID search.

The application workspace owns vertical scrolling. The igv.js custom track must not create an independent vertical scrollbar. React may control state and render accessible labels/controls outside the track, but it must not insert DOM panels into igv.js internals; both expanded geometry lanes are drawn by the custom track from the same row-layout model.

## 13. Local launch and packaging

Target commands:

    ./scripts/build_annotations.sh /path/to/annotation-cache \
      --reference-fasta /path/to/Homo_sapiens.GRCh38.dna.toplevel.fa
    ./run_local.sh

Expected behavior:

- The build command creates a versioned data package under the project, prints progress, and writes a human-readable validation report.
- The run command verifies the manifest, starts the FastAPI/static server on 127.0.0.1, and prints the local URL.
- The browser opens only if requested by a flag or configuration.
- The server never scans arbitrary filesystem paths exposed by request parameters.
- A lock prevents two annotation builds from overwriting each other.
- Python and npm dependencies are locked in uv.lock/requirements and package-lock.json.
- The R/data.table export step has an explicit supported R version, preflight check, and renv.lock. R is required only for the one-time annotation build, not for serving or using the completed browser.
- Docker may be provided as an optional reproducibility path, not the primary user experience.

Proposed output package:

    local_transcript_browser/
      backend/
      frontend/
      build/
      scripts/
      tests/
      data/
        builds/
          gencode_v45/
            annotation.sqlite
            manifest.json
            validation_report.json
            reference/          # required 2bit or indexed FASTA, chrom.sizes, checksums
      run_local.sh

## 14. Efficiency and performance plan

### 14.1 Data access

- Query only the visible interval and requested detail level.
- Fetch protein features only when a transcript opens.
- Fetch sequences only when the sequence inspector opens.
- Cache immutable build-scoped responses.
- Precompute broad-scale density bins.
- Serve reference data through byte ranges; never load an entire genome FASTA in the browser.

### 14.2 Rendering

- Draw genomic geometry with Canvas2D.
- Keep labels and controls in the DOM.
- Use one shared row-layout calculation for DOM and Canvas.
- Build a small per-frame spatial hit map rather than querying every feature on pointer movement.
- Redraw only on locus, size, filter, or selection changes.
- Use requestAnimationFrame for pan/zoom synchronization.
- Avoid long main-thread data transforms; all domain projection happens at build time.
- Virtualize long inspector tables and sequence rows.

### 14.3 Initial performance budgets

- Search autocomplete p95 below 50 ms.
- Typical regional API p95 below 100 ms.
- Warm gene jump below 300 ms.
- Pan/zoom near 60 fps after data arrival.
- No ordinary main-thread task above 100 ms.
- Cold local server-ready time below 2 seconds after the database/reference package exists.
- First selected-gene render below 3 seconds with cold application caches.
- Browser memory below roughly 250 MiB for a complex gene with selected expansions.
- No unbounded response or full-chromosome transcript payload.

These are acceptance budgets to measure, not assumptions. The performance report must name the benchmark laptop hardware, OS, browser/engine version, cold-versus-warm cache state, representative loci, and data-build hash. It must report both **server ready** and **first gene rendered** rather than using an ambiguous single launch time.

## 15. Reliability behavior

The application should be explicitly designed around the failure modes visible in large public genome portals:

- No whole-page navigation for a gene-to-transcript transition.
- No global spinner while one track loads.
- Every fetch has timeout, cancellation, and scoped error handling.
- A failed feature source does not hide transcript models.
- The last valid frame remains visible while new locus data arrives.
- Expansion state is not lost during pan/zoom.
- URL restoration waits for the build manifest, then restores deterministically.
- Invalid IDs and coordinates receive precise local errors and suggestions.
- Build/schema mismatch stops startup with a remediation command.
- Empty feature sets are shown as valid empty states.
- Distinguish and explain: no annotated gene in region, no local features for a translated protein, sequence absent from the cache, and a pinned entity outside the current viewport. A missing or checksum-invalid genomic reference is a startup validation failure with the exact remediation command, not a half-functional browser state.

## 16. Test strategy

### 16.1 Data and build tests

- Snapshot raw GTF/FASTA/feature counts and checksums.
- Verify all repeated tags survive ingestion.
- Verify versioned and unversioned identifier joins.
- Verify SP1 produces four transcripts.
- Validate feature coordinates against protein lengths.
- Validate all projected segments against CDS bounds.
- Validate exact/partial/unresolved translation-mapping classification and prohibit unresolved genomic feature drawing.
- Translation-to-protein concordance report.
- Deterministic rebuild: identical inputs produce identical canonical row counts/content hashes and schema version. Timestamps and SQLite page layout are explicitly excluded from byte-for-byte determinism.
- Negative-strand, single-exon, junction-spanning, phase-1/phase-2 split-codon on both strands, partial-CDS, selenocysteine, noncoding, no-sequence, and no-feature fixtures.
- Huge-gene fixture to expose payload and layout limits.

### 16.2 API tests

- Search by symbol, transcript name, ENSG/ENST/ENSP/ENSE with and without versions.
- Duplicate-symbol disambiguation.
- Coordinate parsing and contig aliases.
- Round-trip locus-string conversion to integer start0/end0 machine fields and back.
- Exact interval-boundary inclusion/exclusion.
- Integer-bin overlap fixtures near chromosome starts and ends.
- Correct level-of-detail responses.
- Bounded pagination and span limits.
- ETag/build-hash behavior.
- Required reference range requests return 206, Content-Range, and Accept-Ranges.

### 16.3 UI and end-to-end tests

- Search SP1 and choose the correct gene.
- See all four v45 SP1 transcripts.
- Open SP1-201 and filter InterPro/Pfam/MobiDB-lite/ELM.
- Hover a domain and see matching genomic fragments and contributing exons.
- Open SP1-203 and see its protein plus a correct empty-feature message.
- Navigate directly to a versioned ENST and ENSP.
- Pan, zoom, ruler-select, back, forward, fit gene, and fit transcript.
- Refresh a deep URL and restore locus, expansion, selection, filters, and inspector tab.
- Keyboard-only transcript expansion and feature inspection.
- CI visual regression at pixel ratios 1 and 2 in Playwright Chromium, Firefox, and WebKit, plus an actual desktop Safari smoke test through SafariDriver or a documented manual release gate.
- Network-disabled run asserting zero external requests.
- Resize from laptop to large desktop without misaligned label/canvas rows.
- Verify the complete gesture matrix without breaking ordinary vertical scrolling.
- Verify split-codon exon shading and phase tooltips.
- Verify a selected transcript remains visible across semantic-detail thresholds.
- Verify gene grouping and neighboring-gene treatment at a dense multi-gene locus.
- Verify tiny and exactly overlapping features through pointer, chooser, keyboard, and table access.
- Verify all distinct empty/off-screen states: no gene in region, no features, missing transcript sequence, and selected entity outside the viewport; separately verify the missing/invalid-reference startup remediation.

### 16.4 Usability acceptance tasks

A domain scientist unfamiliar with the app should be able to:

1. Find SP1 in under 10 seconds.
2. Identify the MANE/Ensembl Canonical transcript without hiding alternatives.
3. Expand its protein features without leaving the genome view.
4. Identify which exons contribute to a selected zinc-finger feature.
5. Copy the transcript ID and protein sequence.
6. Return to the exact view from a copied local URL.

## 17. Implementation phases and gates

Estimates assume one experienced full-stack developer familiar with genomic coordinate systems. They are planning ranges, not commitments.

### Phase 0 — Data contract and scaffold, 1–2 days

Deliver:

- Repository/app skeleton
- Locked frontend/backend dependencies
- Locked R/data.table build environment and preflight
- Build manifest schema
- Coordinate and identifier conventions
- Raw-vs-processed source-of-truth decision recorded
- Checksum-verified local GRCh38.p14 reference, chrom.sizes, and release manifest

Exit criteria:

- GENCODE v45/GRCh38 metadata detected correctly.
- Internal 0-based half-open convention documented and tested.
- Local igv.js reference loads with all default/remote genome and search services disabled.
- App starts with a placeholder local manifest.

### Phase 1 — SP1 vertical technical spike, 4–6 days

Deliver:

- Minimal raw GTF/FASTA/feature ingestion for SP1
- Search and direct locus jump
- Four transcript models
- Expandable SP1-201 protein panel
- Projected and continuous feature lanes
- URL restoration
- A realistic interaction/visual prototype covering label width, badge overflow, inspector collapse, legend/scales, genome-versus-protein separation, and feature colors
- A dense multi-gene/40-plus-transcript fixture alongside SP1 to test grouping, compact modes, label synchronization, and the single vertical-scroll owner

Exit gate:

- Dynamic height remains aligned through pan and zoom.
- Canvas hit-testing and DOM disclosure controls agree.
- Collapse/re-expand does not lose selection.
- SP1 feature projection is exact.
- Screenshot/SVG behavior is characterized.
- Ordinary vertical scrolling, genomic pan, and pointer-centered zoom do not conflict.
- Protein and genomic coordinate systems are unmistakably separate.
- Dense-locus grouping and selected-entity overrides remain legible.
- Repeatedly crossing the 250 kb and 5 Mb detail thresholds never reuses a stale density/transcript cache representation.

If the gate fails, replace the igv.js viewport adapter before continuing; do not patch around unstable behavior throughout the product.

### Phase 2 — Full deterministic annotation build, 4–7 days

Deliver:

- Streaming raw GTF and FASTA ingestion
- RDS export/normalization
- Full protein projection
- SQLite schema, exact search, FTS, interval indexes, density tiles
- Manifest and validation report

Exit criteria:

- Counts match audited inputs.
- Orphan and projection failures are zero or explicitly classified.
- Full rebuild has identical canonical content hashes/row counts for identical inputs and publishes atomically.
- Typical region/search query meets the API budgets.

### Phase 3 — Core genome browser, 5–8 days

Deliver:

- Complete top command bar and search
- Locus history and URL state
- Semantic display modes
- Transcript label rail and genomic models
- Gene/transcript inspector
- Empty/error/loading states

Exit criteria:

- All navigation and transcript workflows pass end-to-end tests.
- Broad and dense loci remain bounded and responsive.
- Noncoding transcripts are represented correctly.

### Phase 4 — Protein feature explorer, 5–8 days

Deliver:

- All seven feature sources
- Genomic projection plus AA lane
- Source/class filters
- Cross-highlighting
- Feature inspector/table
- Transcript/protein sequences and copy/export

Exit criteria:

- Projection fixtures pass on both strands.
- Overlap stacking is legible.
- Missing provenance is not overstated.
- No-feature transcripts have explicit valid empty states.

### Phase 5 — Visual polish and accessibility, 4–6 days

Deliver:

- Final design tokens, spacing, typography, transitions, density settings
- Keyboard shortcuts and accessible labels
- Responsive layout
- High-DPI and visual regression baselines
- Onboarding/help overlay
- Structured biological review of coordinate, exon-phase, feature-provenance, and empty-state interpretation

Exit criteria:

- Usability acceptance tasks pass.
- No DOM/Canvas row drift across supported browsers/sizes.
- WCAG AA checks pass for core workflows.
- A domain reviewer signs off on the SP1 fixture plus positive-, negative-, partial-, and split-codon cases.

### Phase 6 — Hardening and release, 3–5 days

Deliver:

- One-command build/run scripts
- Offline verification
- Performance profile and budgets report
- User/developer documentation
- Reference setup diagnostics, checksum validation, and documented one-time acquisition/supply path
- Release checklist
- igv.js MIT license notice, GENCODE attribution/data terms, and complete third-party dependency notices

Exit criteria:

- Fresh-machine install/run instructions are reproducible.
- No runtime external request.
- All definition-of-done items pass.

Expected shape:

- Technical vertical slice: about 1 week
- Functional MVP: about 3–4 weeks
- Polished, tested version 1 engineering baseline: about 6–8 weeks
- Planning range with biological review and a 25–40% custom-integration contingency: about 8–11 weeks

## 18. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| igv.js custom-track hooks are not a fully documented public extension contract | Dynamic rows could break after upgrades | Pin exact version, isolate adapter, test in Phase 1, never fork, retain custom-Canvas fallback |
| Raw GTF and processed RDS differ materially | Missing transcripts/tags and misleading UI | Raw GTF/FASTA are authoritative; RDS is helper only; count/tag fixtures, SP1 four-transcript gate |
| No genomic reference sequence in the supplied cache | igv.js cannot operate fully offline and base-level browsing is impossible | Make a checksum-matched local GRCh38.p14 2bit or indexed FASTA a Phase 0 prerequisite; disable all remote igv.js defaults |
| 1-based/0-based and inclusive/half-open confusion | Off-by-one biological errors | One internal convention, typed coordinate helpers, round-trip and boundary fixtures |
| Reverse-strand domain projection | Incorrect exon mapping | Transcript-ordered CDS algorithm, negative-strand golden fixtures, coverage invariants |
| Overlapping/duplicated biological predictions | Visual clutter or false consensus | Keep source records separate, stack lanes, filter by class/source, optional later consensus mode |
| Very large loci or many transcripts | Slow payload/render and huge vertical layout | LOD, bounded APIs, virtualization, default single expansion, density modes |
| Duplicate gene symbols | Wrong gene chosen | Grouped search with chromosome, ID, biotype; never silently choose |
| Alias data absent | Some familiar gene queries fail | Support local names/IDs now; optional HGNC alias import with provenance |
| Feature evidence metadata absent | UI may imply more confidence than available | Expose only local source/method/accession; label missing score/release explicitly |
| Runtime dependency on internet/CDN | Violates local-first goal | Bundle assets, localhost-only server, network-disabled CI test |

## 19. Product decisions that can remain configurable

Recommended defaults:

- Comprehensive raw GTF annotation, not the processed RDS subset
- Sort MANE Select, Ensembl Canonical, APPRIS Principal, then remaining transcripts, while keeping badges separate
- Automatic semantic detail mode
- One expanded transcript at a time unless pinned
- Feature colors by source in version 1; semantic styling only for explicit TMHMM, SignalP, MobiDB-lite, and ELM meanings
- Light neutral theme first; dark theme can follow
- Browser app on localhost first; native desktop packaging only if later needed

Optional later decisions:

- Add a local HGNC alias file
- Add optional cytobands and chromosome aliases beyond the required reference/chrom.sizes assets
- Expose hybrid first/last-exon relationships as an analysis mode
- Add user-supplied BED/GFF/BigWig/VCF tracks
- Package with Tauri for a native app shell

None of these should block the core v45 transcript/protein browser.

## 20. Definition of done

Version 1 is complete when:

- It launches locally through one documented command after one deterministic annotation build.
- It makes no external runtime request.
- It verifies the local reference and release manifest, then identifies itself as GENCODE v45 / Ensembl 111 / GRCh38.p14.
- Search works for symbols, transcript names, coordinates, and versioned/unversioned stable IDs.
- Genome panning, zooming, ruler selection, fit, and locus history are responsive.
- SP1 shows all four raw-v45 transcripts.
- Each translated transcript can expand inline.
- Protein features are correct on both AA and exon-split genomic axes.
- Cross-highlighting and feature details are interpretable.
- Noncoding, no-sequence, and no-feature states are explicit.
- URL reload restores the research view.
- Core workflows are keyboard accessible.
- Data, API, UI, offline, and performance gates pass.
- The validation/build report makes the exact local data lineage auditable.
- Packaged attribution, licenses, and third-party notices are complete.

## 21. Recommended immediate next action

First, add and checksum-verify the matching local GRCh38.p14 reference plus chrom.sizes/release manifest. Then implement only the Phase 1 SP1 spike before committing to the complete UI. It converts the highest-risk assumptions into observable evidence:

- raw-vs-RDS completeness,
- versioned-ID joins,
- per-transcript dynamic height,
- dual genome/protein coordinate rendering,
- exon-split domain projection,
- pan/zoom synchronization,
- and deep-link state restoration.

Once that spike passes, the remaining work is disciplined productization rather than architecture discovery.

## 22. Addendum — Critical review and error-checking checkpoints

Quality review is a recurring delivery gate, not a final-stage activity. After each module and each larger integrated section is completed, pause new feature work long enough to review the completed work from a deliberately critical standpoint.

Each checkpoint should:

- Run the complete relevant automated test set, then manually verify the most important biological and interaction paths against known fixtures.
- Attempt to falsify the implementation’s assumptions: inspect coordinate boundaries, reverse-strand behavior, missing data, malformed input, large loci, stale state, and failure recovery.
- Compare outputs with the authoritative raw GTF/FASTA records and documented API/data contracts rather than trusting intermediate files or the implementation itself.
- Review correctness, performance, accessibility, visual interpretation, error handling, maintainability, and scope drift.
- Include a fresh-context review by someone other than the primary author when practical. The reviewer should look for defects and unsupported assumptions, not merely confirm that the module appears complete.
- Record findings in a short review log with severity, evidence, owner, resolution, and any follow-up test added.

Critical or high-impact findings must be resolved before dependent work proceeds. Lower-priority issues may be deferred only when they are documented, bounded, and do not compromise biological correctness, reproducibility, or core usability.

In addition to module reviews, conduct broader integration reviews at the end of the annotation builder, core genome browser, protein-feature explorer, and release-hardening phases. These reviews should revisit earlier decisions in light of the assembled system, because individually correct modules can still produce incorrect or confusing behavior when combined.
