import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparisonPanel } from "../src/components/ComparisonPanel";
import { SP1_GENE } from "../src/data/sp1";

const callbacks = {
  onSetComparison: () => undefined,
  onSwap: () => undefined,
  onClearComparison: () => undefined,
  onToggleComparisonPin: () => undefined,
  onPlaceComparison: () => undefined,
  onExportComparison: () => undefined,
};

test("ComparisonPanel renders an accessible empty state without misleading export controls", () => {
  const html = renderToStaticMarkup(createElement(ComparisonPanel, {
    selectedTranscript: SP1_GENE.transcripts[0],
    activeSources: ["interpro"],
    comparisonPinned: false,
    ...callbacks,
  }));
  assert.match(html, /aria-label="Transcript comparison"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Choose comparison transcript/);
  assert.doesNotMatch(html, /comparison-table/);
  assert.doesNotMatch(html, /Export CSV/);
});

test("ComparisonPanel exposes textual differences, semantic value states, tags, actions, and bounded exports", () => {
  const selected = {
    ...SP1_GENE.transcripts[0],
    detailState: "ready" as const,
    featuresState: "ready" as const,
  };
  const comparison = {
    ...SP1_GENE.transcripts[1],
    proteinId: "",
    versionedProteinId: "",
    cdsLength: 0,
    proteinLength: 0,
    detailState: "loading" as const,
    featuresState: "idle" as const,
  };
  const html = renderToStaticMarkup(createElement(ComparisonPanel, {
    selectedTranscript: selected,
    comparisonTranscript: comparison,
    activeSources: ["interpro", "signalp"],
    comparisonPinned: true,
    pinnedTranscriptCount: 2,
    ...callbacks,
  }));

  assert.match(html, /<table class="comparison-table">/);
  assert.match(html, /scope="col">Metric/);
  assert.match(html, /scope="row">/);
  assert.match(html, /comparison-difference-label">Different/);
  assert.match(html, /data-state="not-applicable">Not applicable/);
  assert.match(html, /data-state="not-loaded">Not loaded/);
  assert.match(html, /data-state="zero"><span class="sr-only">Zero value:/);
  assert.match(html, /Shared and unique transcript tags/);
  assert.match(html, /aria-pressed="true">Unpin comparison/);
  assert.match(html, /Place comparison directly above selected/);
  assert.match(html, /Place comparison directly below selected/);
  assert.match(html, /Include pinned transcripts \(2\)/);
  assert.match(html, /Export CSV/);
  assert.match(html, /Export TSV/);
  assert.match(html, /maximum of 20 transcripts/);
  assert.match(html, /Feature count · InterPro/);
  assert.match(html, /Feature count · SignalP/);
  assert.doesNotMatch(html, /Feature count · Pfam/);
});
