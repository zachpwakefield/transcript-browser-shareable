import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptLabels } from "../src/components/TranscriptLabels";
import { DEFAULT_VIEW_STATE, SP1_GENE } from "../src/data/sp1";
import { buildRowLayout } from "../src/lib/layout";

const translated = SP1_GENE.transcripts.filter((transcript) => transcript.proteinLength > 0).slice(0, 2);
const gene = { ...SP1_GENE, transcripts: translated };
const ids = translated.map((transcript) => transcript.id);
const callbacks = {
  onSelectTranscript: () => undefined,
  onToggleExpanded: () => undefined,
  onTogglePinned: () => undefined,
  onSetComparison: () => undefined,
  onReorderTranscript: () => undefined,
  onReorderFocusHandled: () => undefined,
};

function renderLabels(displayMode: "labeled" | "expanded", expandedTranscriptIds: string[]) {
  return renderToStaticMarkup(createElement(TranscriptLabels, {
    gene,
    transcripts: translated,
    layout: buildRowLayout(translated, expandedTranscriptIds, DEFAULT_VIEW_STATE.activeSources),
    displayMode,
    selectedTranscriptId: ids[0],
    comparisonTranscriptId: "",
    selectedTranscriptName: translated[0].name,
    expandedTranscriptIds,
    pinnedTranscriptIds: [],
    reorderableTranscriptIds: ids,
    customOrderActive: false,
    activeSources: DEFAULT_VIEW_STATE.activeSources,
    rowDensity: "comfortable",
    locus: DEFAULT_VIEW_STATE.locus,
    ...callbacks,
  }));
}

test("multiple translated transcript rows expose independent expanded controls", () => {
  const html = renderLabels("expanded", ids);
  assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 2);
  assert.match(html, new RegExp(`Collapse ${translated[0].name} protein annotations`));
  assert.match(html, new RegExp(`Collapse ${translated[1].name} protein annotations`));
});

test("a translated transcript can open protein features from another track-content mode", () => {
  const html = renderLabels("labeled", []);
  assert.match(html, new RegExp(`aria-label="Expand ${translated[0].name} protein annotations"`));
  assert.doesNotMatch(html, new RegExp(`aria-label="Expand ${translated[0].name} protein annotations"[^>]*disabled`));
});
