import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VIEW_STATE, SP1_GENE } from "../src/data/sp1.ts";
import {
  enabledFeatureSources,
  filterTranscriptsWithContext,
  transcriptFlags,
} from "../src/lib/filters.ts";
import {
  COMPACT_COLLAPSED_ROW_HEIGHT,
  COLLAPSED_ROW_HEIGHT,
  buildRowLayout,
} from "../src/lib/layout.ts";
import { canvasKeyboardCommand, featureSelectionForTranscript } from "../src/lib/navigation.ts";
import { encodeViewState, parseViewState } from "../src/lib/urlState.ts";
import { FEATURE_CLASS_BY_SOURCE, type BrowserViewState } from "../src/types.ts";

test("feature classes are derived only from the four single-purpose prediction sources", () => {
  assert.deepEqual(FEATURE_CLASS_BY_SOURCE, {
    tmhmm: "transmembrane_helix",
    signalp: "signal_peptide",
    mobidblite: "intrinsic_disorder",
    elm: "short_linear_motif",
  });
  assert.equal(FEATURE_CLASS_BY_SOURCE.interpro, undefined);
  assert.equal(FEATURE_CLASS_BY_SOURCE.pfam, undefined);
  assert.equal(FEATURE_CLASS_BY_SOURCE.cdd, undefined);

  const visible = enabledFeatureSources(DEFAULT_VIEW_STATE.activeSources, ["intrinsic_disorder"]);
  assert.deepEqual(visible, ["interpro", "pfam", "mobidblite", "cdd"]);
});

test("biotype and annotation-flag filters retain selected, comparison, and pinned transcript context", () => {
  const selected = SP1_GENE.transcripts[2].id;
  const pinned = SP1_GENE.transcripts[1].id;
  const comparison = SP1_GENE.transcripts[3].id;
  const onlyContext = filterTranscriptsWithContext(
    SP1_GENE.transcripts,
    ["protein_coding"],
    [],
    selected,
    [pinned],
    comparison,
  );
  assert.deepEqual(onlyContext.map((transcript) => transcript.id), [pinned, selected, comparison]);

  const manePlusContext = filterTranscriptsWithContext(
    SP1_GENE.transcripts,
    [],
    ["mane_select"],
    selected,
    [pinned],
  );
  assert.deepEqual(
    manePlusContext.map((transcript) => transcript.id),
    [SP1_GENE.transcripts[0].id, pinned, selected],
  );
  assert.deepEqual([...transcriptFlags(SP1_GENE.transcripts[0])].sort(), [
    "appris_principal",
    "ccds",
    "ensembl_canonical",
    "gencode_basic",
    "mane_select",
  ]);
});

test("compact and comfortable density use one deterministic shared row layout", () => {
  const comfortable = buildRowLayout(
    SP1_GENE.transcripts,
    [],
    DEFAULT_VIEW_STATE.activeSources,
    "comfortable",
  );
  const compact = buildRowLayout(
    SP1_GENE.transcripts,
    [],
    DEFAULT_VIEW_STATE.activeSources,
    "compact",
  );
  assert.equal(comfortable.rows[0].height, COLLAPSED_ROW_HEIGHT);
  assert.equal(compact.rows[0].height, COMPACT_COLLAPSED_ROW_HEIGHT);
  assert.ok(compact.totalHeight < comfortable.totalHeight);
  assert.equal(compact.rows[1].y, compact.rows[0].y + compact.rows[0].height);
  assert.equal(compact.density, "compact");
});

test("new filter, density, and shortcut state round-trips while prior URLs keep defaults", () => {
  const priorUrl = "?build=sp1-fixture-v1&gene=ENSG00000185591&locus=chr12%3A53380176-53416446&tx=ENST00000327443&sources=interpro%2Cpfam&tab=gene&mode=labeled";
  const prior = parseViewState(priorUrl, DEFAULT_VIEW_STATE);
  assert.deepEqual(prior.activeFeatureClasses, DEFAULT_VIEW_STATE.activeFeatureClasses);
  assert.deepEqual(prior.excludedTranscriptBiotypes, []);
  assert.deepEqual(prior.activeTranscriptFlags, []);
  assert.equal(prior.rowDensity, "comfortable");
  assert.equal(prior.canvasKeyboardShortcuts, true);
  assert.deepEqual(prior.transcriptOrderIds, []);

  const configured: BrowserViewState = {
    ...DEFAULT_VIEW_STATE,
    activeFeatureClasses: ["intrinsic_disorder"],
    excludedTranscriptBiotypes: ["nonsense_mediated_decay"],
    activeTranscriptFlags: ["mane_select", "ccds"],
    transcriptOrderIds: [
      "ENST00000548560",
      "ENST00000327443",
      "ENST00000426431",
      "ENST00000551969",
    ],
    rowDensity: "compact",
    canvasKeyboardShortcuts: false,
    selectedFeatureId: undefined,
  };
  assert.deepEqual(parseViewState(encodeViewState(configured), DEFAULT_VIEW_STATE), configured);
});

test("Canvas shortcut gate and transcript-switch feature invariant are explicit", () => {
  assert.equal(canvasKeyboardCommand("ArrowLeft", true), "pan-left");
  assert.equal(canvasKeyboardCommand("+", true), "zoom-in");
  assert.equal(canvasKeyboardCommand("ArrowLeft", false), null);
  assert.equal(featureSelectionForTranscript("feature-1", "tx-1", "tx-1"), "feature-1");
  assert.equal(featureSelectionForTranscript("feature-1", "tx-1", "tx-2"), undefined);
  assert.equal(featureSelectionForTranscript("feature-1", undefined, "tx-2"), undefined);
});
