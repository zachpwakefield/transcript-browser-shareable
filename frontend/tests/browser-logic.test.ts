import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VIEW_STATE, SP1_GENE } from "../src/data/sp1.ts";
import { formatLocus, MAX_LOCUS_SPAN_BP, parseLocus, zoomLocus } from "../src/lib/coordinates.ts";
import { buildRowLayout, COLLAPSED_ROW_HEIGHT } from "../src/lib/layout.ts";
import {
  MAX_EXPANDED_TRANSCRIPTS,
  canvasBitmapSize,
  defaultProteinTranscriptId,
  intervalOverlapsLocus,
  nextExpansionState,
  semanticDisplayMode,
  transcriptRevealDecision,
  transcriptsForDisplay,
} from "../src/lib/navigation.ts";
import { projectFeatureThroughCds } from "../src/lib/projection.ts";
import { encodeSession, parseSession } from "../src/lib/session.ts";
import { buildSequenceLines, sequenceDecorations } from "../src/lib/sequence.ts";
import { encodeViewState, parseViewState, restoreViewState } from "../src/lib/urlState.ts";
import type { Transcript } from "../src/types.ts";

test("coordinate strings round-trip between 1-based labels and half-open fields", () => {
  const parsed = parseLocus("12:53,380,176-53,416,446");
  assert.deepEqual(parsed, { chrom: "chr12", start0: 53_380_175, end0: 53_416_446 });
  assert.equal(formatLocus(parsed!), "chr12:53,380,176-53,416,446");
  assert.equal(parseLocus("chr12:0-20"), null);
  assert.equal(parseLocus(`chr12:1-${MAX_LOCUS_SPAN_BP + 1}`), null);
  assert.equal(zoomLocus(parsed!, 0.5).end0 - zoomLocus(parsed!, 0.5).start0, 18_136);
  assert.equal(
    zoomLocus({ chrom: "chr12", start0: 0, end0: 20_000_000 }, 2).end0,
    MAX_LOCUS_SPAN_BP,
  );
});

test("URL state preserves build, gene, locus, expansion, filters, and inspector state", () => {
  const state = {
    ...DEFAULT_VIEW_STATE,
    transcriptOrderIds: [
      "ENST00000548560",
      "ENST00000327443",
      "ENST00000426431",
      "ENST00000551969",
    ],
    inspectorTab: "feature" as const,
    selectedFeatureId: "pfam:example",
  };
  const encoded = encodeViewState(state);
  assert.match(encoded, /build=sp1-fixture-v1/);
  assert.match(encoded, /gene=ENSG00000185591/);
  assert.deepEqual(parseViewState(encoded, DEFAULT_VIEW_STATE), state);
  const noSources = { ...state, activeSources: [] };
  assert.deepEqual(parseViewState(encodeViewState(noSources), DEFAULT_VIEW_STATE), noSources);
});

test("deep URL restore spans genes but rejects and clears a mismatched build", () => {
  const deep = {
    ...DEFAULT_VIEW_STATE,
    selectedGeneId: "ENSG00000999999",
    selectedTranscriptId: "ENST00000999999",
    transcriptOrderIds: ["ENST00000999999", "ENST00000999998"],
    expandedTranscriptIds: ["ENST00000999999"],
    pinnedTranscriptIds: ["ENST00000999999"],
    selectedFeatureId: "feature:old-build",
    locus: { chrom: "chr7", start0: 100, end0: 900 },
  };
  const same = restoreViewState(encodeViewState(deep), DEFAULT_VIEW_STATE, deep.buildHash);
  assert.deepEqual(same.view, deep);
  assert.equal(same.mismatchedBuild, undefined);

  const mismatched = restoreViewState(encodeViewState(deep), DEFAULT_VIEW_STATE, "current-build");
  assert.equal(mismatched.mismatchedBuild, deep.buildHash);
  assert.equal(mismatched.view.buildHash, "current-build");
  assert.equal(mismatched.view.selectedGeneId, DEFAULT_VIEW_STATE.selectedGeneId);
  assert.deepEqual(mismatched.view.expandedTranscriptIds, DEFAULT_VIEW_STATE.expandedTranscriptIds);
  assert.deepEqual(mismatched.view.transcriptOrderIds, DEFAULT_VIEW_STATE.transcriptOrderIds);
  assert.equal(mismatched.view.selectedFeatureId, DEFAULT_VIEW_STATE.selectedFeatureId);
});

test("portable session JSON restores only on the declared immutable build", () => {
  const state = {
    ...DEFAULT_VIEW_STATE,
    selectedGeneId: "ENSG000002",
    selectedTranscriptId: "ENST000002",
    transcriptOrderIds: ["ENST000002", "ENST000001"],
    pinnedTranscriptIds: ["ENST000002"],
  };
  const encoded = encodeSession(state);
  assert.deepEqual(parseSession(encoded, DEFAULT_VIEW_STATE, state.buildHash), {
    ...state,
    selectedFeatureId: undefined,
  });
  assert.throws(
    () => parseSession(encoded, DEFAULT_VIEW_STATE, "different-build"),
    /Session requires build/,
  );
});

test("shared row layout gives labels and canvas identical deterministic geometry", () => {
  const collapsed = buildRowLayout(SP1_GENE.transcripts, [], DEFAULT_VIEW_STATE.activeSources);
  const expanded = buildRowLayout(
    SP1_GENE.transcripts,
    ["ENST00000327443"],
    DEFAULT_VIEW_STATE.activeSources,
  );
  assert.equal(collapsed.rows[0].height, COLLAPSED_ROW_HEIGHT);
  assert.ok(expanded.rows[0].height > collapsed.rows[0].height);
  assert.equal(expanded.rows[1].y, expanded.rows[0].y + expanded.rows[0].height);
  assert.equal(expanded.totalHeight, expanded.rows.at(-1)!.y + expanded.rows.at(-1)!.height);

  const twoExpandedIds = SP1_GENE.transcripts.slice(0, 2).map((transcript) => transcript.id);
  const twoExpanded = buildRowLayout(
    SP1_GENE.transcripts,
    twoExpandedIds,
    DEFAULT_VIEW_STATE.activeSources,
  );
  const beforeFeatureArrival = buildRowLayout(
    SP1_GENE.transcripts.map((transcript) => ({ ...transcript, features: [] })),
    twoExpandedIds,
    DEFAULT_VIEW_STATE.activeSources,
  );
  assert.equal(twoExpanded.rows[0].expanded, true);
  assert.equal(twoExpanded.rows[1].expanded, true);
  assert.equal(twoExpanded.totalHeight, beforeFeatureArrival.totalHeight);
  assert.deepEqual(
    twoExpanded.rows.map(({ y, height }) => ({ y, height })),
    beforeFeatureArrival.rows.map(({ y, height }) => ({ y, height })),
  );
});

test("an explicit transcript reveal is consumed once and does not pin later layouts", () => {
  const layout = buildRowLayout(SP1_GENE.transcripts, [], DEFAULT_VIEW_STATE.activeSources);
  const transcriptId = SP1_GENE.transcripts[3].id;
  const request = {
    requestId: 1,
    geneId: SP1_GENE.id,
    transcriptId,
  };

  const initial = transcriptRevealDecision(
    request,
    SP1_GENE.id,
    transcriptId,
    layout.rows,
    0,
    100,
  );
  assert.deepEqual(initial, { consume: true, scrollTop: layout.rows[3].y - 12 });

  const consumedRequest = initial.consume ? null : request;
  assert.deepEqual(
    transcriptRevealDecision(
      consumedRequest,
      SP1_GENE.id,
      transcriptId,
      [...layout.rows],
      500,
      100,
    ),
    { consume: false },
  );

  const repeatedNavigation = { ...request, requestId: 2 };
  assert.deepEqual(
    transcriptRevealDecision(
      repeatedNavigation,
      SP1_GENE.id,
      transcriptId,
      layout.rows,
      500,
      100,
    ),
    { consume: true, scrollTop: layout.rows[3].y - 12 },
  );
  assert.deepEqual(
    transcriptRevealDecision(request, "another-gene", transcriptId, layout.rows, 0, 100),
    { consume: false },
  );
});

test("protein-feature disclosures expand and collapse independently within an explicit bound", () => {
  assert.deepEqual(nextExpansionState("tx2", ["tx1"]), ["tx1", "tx2"]);
  assert.deepEqual(nextExpansionState("tx2", ["tx1", "tx2"]), ["tx1"]);
  assert.deepEqual(nextExpansionState("tx2", ["tx1", "tx1"], true), ["tx1", "tx2"]);
  assert.deepEqual(nextExpansionState("tx1", ["tx1", "tx2"], true), ["tx1", "tx2"]);
  const atLimit = Array.from({ length: MAX_EXPANDED_TRANSCRIPTS }, (_, index) => `tx${index}`);
  assert.deepEqual(nextExpansionState("overflow", atLimit), atLimit);
});

test("fresh gene navigation prefers a translated transcript for default protein features", () => {
  const firstTranslated = SP1_GENE.transcripts.find((transcript) => transcript.proteinLength > 0)!;
  assert.equal(defaultProteinTranscriptId(SP1_GENE.transcripts), firstTranslated.id);
  assert.equal(defaultProteinTranscriptId([
    { ...SP1_GENE.transcripts[0], id: "noncoding", proteinLength: 0 },
    { ...SP1_GENE.transcripts[1], id: "translated", proteinLength: 88 },
  ]), "translated");
  assert.equal(defaultProteinTranscriptId([
    { ...SP1_GENE.transcripts[0], id: "fallback", proteinLength: 0 },
  ]), "fallback");
  assert.equal(defaultProteinTranscriptId([]), "");
});

test("semantic LOD retains selected and pinned entities across overview thresholds", () => {
  const broad = { chrom: "chr12", start0: 0, end0: 8_000_000 };
  assert.equal(semanticDisplayMode("auto", broad, true), "overview");
  const retained = transcriptsForDisplay(
    SP1_GENE.transcripts,
    "overview",
    "ENST00000548560",
    ["ENST00000551969"],
    1,
  );
  assert.deepEqual(retained.map((item) => item.id), ["ENST00000548560", "ENST00000551969"]);
});

test("off-screen classification distinguishes overlap and Canvas DPR sizing is deterministic", () => {
  const locus = { chrom: "chr12", start0: 100, end0: 200 };
  assert.equal(intervalOverlapsLocus("chr12", 150, 250, locus), true);
  assert.equal(intervalOverlapsLocus("12", 200, 250, locus), false);
  assert.equal(intervalOverlapsLocus("chr13", 150, 170, locus), false);
  assert.deepEqual(canvasBitmapSize(760, 500, 1), { width: 760, height: 500, dpr: 1 });
  assert.deepEqual(canvasBitmapSize(760, 500, 2), { width: 1520, height: 1000, dpr: 2 });
  assert.deepEqual(canvasBitmapSize(760, 500, 3), { width: 1520, height: 1000, dpr: 2 });
});

test("junction-spanning amino-acid feature creates CDS-confined pieces, never an intron block", () => {
  const transcript = SP1_GENE.transcripts.find((item) => item.id === "ENST00000327443")!;
  const segments = projectFeatureThroughCds(transcript, 637, 695);
  assert.equal(segments.length, 2);
  assert.equal(segments.reduce((sum, item) => sum + item.end0 - item.start0, 0), 59 * 3);
  assert.ok(segments[0].end0 < segments[1].start0);
  assert.equal(segments[0].exonRank, 5);
  assert.equal(segments[1].exonRank, 6);
  assert.deepEqual(projectFeatureThroughCds(transcript, 780, 800), []);
});

test("minus-strand projection keeps transcript rank order and inverts within segments", () => {
  const transcript: Transcript = {
    id: "ENST_MINUS",
    versionedId: "ENST_MINUS.1",
    name: "minus fixture",
    proteinId: "ENSP_MINUS",
    versionedProteinId: "ENSP_MINUS.1",
    biotype: "protein_coding",
    start0: 700,
    end0: 999,
    strand: "-",
    transcriptLength: 198,
    cdsLength: 198,
    proteinLength: 66,
    tsl: "fixture",
    badges: [],
    tags: [],
    exons: [
      { id: "E1", rank: 1, start0: 900, end0: 999, cdsStart0: 900, cdsEnd0: 999, phase: 0 },
      { id: "E2", rank: 2, start0: 700, end0: 799, cdsStart0: 700, cdsEnd0: 799, phase: 0 },
    ],
    features: [],
  };
  const segments = projectFeatureThroughCds(transcript, 30, 40);
  assert.deepEqual(segments, [
    { start0: 900, end0: 912, exonRank: 1 },
    { start0: 778, end0: 799, exonRank: 2 },
  ]);
  assert.equal(segments.reduce((sum, item) => sum + item.end0 - item.start0, 0), 33);
});

test("sequence overlays preserve text and mark exon/CDS/selected-feature coordinates", () => {
  const transcript = SP1_GENE.transcripts[0];
  const feature = transcript.features[0];
  const decorations = sequenceDecorations(transcript, "protein", feature);
  assert.ok(decorations.some((item) => item.className === "selected-feature"));
  assert.deepEqual(
    decorations.find((item) => item.className === "selected-feature"),
    {
      start0: feature.aaStart - 1,
      end0: feature.aaEnd,
      className: "selected-feature",
      label: feature.name,
    },
  );
  const sequence = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lines = buildSequenceLines(sequence, [{ start0: 4, end0: 10, className: "cds", label: "CDS" }], 12);
  assert.equal(lines.flatMap((line) => line.segments).map((segment) => segment.text).join(""), sequence);
  assert.equal(lines[0].segments.some((segment) => segment.className === "cds"), true);
});
