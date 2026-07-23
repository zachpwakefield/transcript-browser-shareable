import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptMinimap } from "../src/components/TranscriptMinimap";
import { TranscriptNavigator } from "../src/components/TranscriptNavigator";
import { SP1_GENE } from "../src/data/sp1";
import { buildRowLayout, type BrowserRowLayout } from "../src/lib/layout";
import {
  currentTranscriptNavigationState,
  searchCurrentTranscripts,
  transcriptNavigationStatus,
} from "../src/lib/transcriptNavigation";
import {
  MINIMAP_HEIGHT_MAX,
  buildTranscriptMinimapGeometry,
  minimapKeyboardScrollTop,
  minimapScrollTopForRatio,
} from "../src/lib/transcriptMinimap";

function denseLayout(count = 20): BrowserRowLayout {
  const template = SP1_GENE.transcripts[0];
  const transcripts = Array.from({ length: count }, (_, index) => ({
    ...template,
    id: `tx-${index}`,
    versionedId: `ENST${String(index).padStart(11, "0")}.1`,
    name: `Dense-${index + 1}`,
    proteinId: `protein-${index}`,
    versionedProteinId: `protein-${index}.1`,
  }));
  return buildRowLayout(transcripts, [], [], "comfortable");
}

test("current-gene search covers transcript name, base/versioned ENST, protein, and biotype without reordering", () => {
  const transcripts = SP1_GENE.transcripts;
  assert.deepEqual(searchCurrentTranscripts(transcripts, "SP1-203").map((item) => item.id), ["ENST00000548560"]);
  assert.deepEqual(searchCurrentTranscripts(transcripts, "ENST00000548560").map((item) => item.name), ["SP1-203"]);
  assert.deepEqual(searchCurrentTranscripts(transcripts, "ENST00000548560.1").map((item) => item.name), ["SP1-203"]);
  assert.deepEqual(searchCurrentTranscripts(transcripts, "ENSP00000458133").map((item) => item.name), ["SP1-203"]);
  assert.deepEqual(searchCurrentTranscripts(transcripts, "ENSP00000458133.1").map((item) => item.name), ["SP1-203"]);
  assert.deepEqual(searchCurrentTranscripts(transcripts, "SP1-203 protein_coding").map((item) => item.name), ["SP1-203"]);
  assert.deepEqual(searchCurrentTranscripts(transcripts, "sp1-20").map((item) => item.name), ["SP1-201", "SP1-202", "SP1-203", "SP1-204"]);
});

test("navigator exposes exact match position and stable previous/next boundaries", () => {
  const first = currentTranscriptNavigationState(SP1_GENE.transcripts, "ENST00000327443", "");
  assert.equal(first.selectedOrderedIndex, 0);
  assert.equal(first.selectedMatchIndex, 0);
  assert.equal(first.previous, undefined);
  assert.equal(first.next?.id, "ENST00000426431");
  assert.equal(transcriptNavigationStatus(first, 4), "Transcript 1 of 4 matches; 4 current transcripts.");

  const last = currentTranscriptNavigationState(SP1_GENE.transcripts, "ENST00000551969", "sp1-20");
  assert.equal(last.previous?.id, "ENST00000548560");
  assert.equal(last.next, undefined);

  const outside = currentTranscriptNavigationState(SP1_GENE.transcripts, "ENST00000327443", "SP1-203");
  assert.equal(outside.selectedMatchIndex, -1);
  assert.equal(outside.previous, undefined);
  assert.equal(outside.next, undefined);
  assert.equal(
    transcriptNavigationStatus(outside, 4),
    "Selected transcript 1 of 4 is outside the 1 matches.",
  );
});

test("TranscriptNavigator renders controlled, labeled native controls and exact status", () => {
  const html = renderToStaticMarkup(createElement(TranscriptNavigator, {
    transcripts: SP1_GENE.transcripts,
    selectedTranscriptId: "ENST00000327443",
    query: "",
    onQueryChange: () => undefined,
    onSelectTranscript: () => undefined,
  }));
  assert.match(html, /aria-label="Current gene transcript navigator"/);
  assert.match(html, /type="search"/);
  assert.match(html, /data-selected-match-position="1"/);
  assert.match(html, /Transcript 1 of 4 matches; 4 current transcripts\./);
  assert.match(html, /Previous transcript unavailable: at first matching transcript/);
  assert.match(html, /Next transcript: SP1-202, ENST00000426431\.2/);
  assert.match(html, /ENSP00000329357\.4/);
  assert.match(html, /Matching transcripts in current visual order/);
});

test("minimap geometry is bounded and marks selected, comparison, and pinned rows", () => {
  const layout = denseLayout();
  const geometry = buildTranscriptMinimapGeometry(
    layout,
    { scrollTop: 420, height: 360 },
    "tx-10",
    ["tx-3", "tx-10"],
    ["tx-18"],
    999,
  );
  assert.equal(geometry.hidden, false);
  assert.equal(geometry.heightPx, MINIMAP_HEIGHT_MAX);
  assert.ok(geometry.viewportTopPx >= 0);
  assert.ok(geometry.viewportTopPx + geometry.viewportHeightPx <= geometry.heightPx);
  assert.ok(geometry.firstVisibleIndex < geometry.lastVisibleIndexExclusive);
  assert.deepEqual(geometry.markers.map((marker) => marker.transcriptId), ["tx-3", "tx-10", "tx-18"]);
  assert.equal(geometry.markers.find((marker) => marker.transcriptId === "tx-10")?.selected, true);
  assert.equal(geometry.markers.find((marker) => marker.transcriptId === "tx-10")?.comparison, true);
  assert.equal(geometry.markers.find((marker) => marker.transcriptId === "tx-18")?.pinned, true);
  assert.ok(geometry.markers.every((marker) => (
    marker.topPx >= 0
    && marker.heightPx >= 2
    && marker.topPx + marker.heightPx <= geometry.heightPx
  )));
});

test("minimap hides without overflow and navigation calculations clamp at boundaries", () => {
  const layout = denseLayout(3);
  const hidden = buildTranscriptMinimapGeometry(
    layout,
    { scrollTop: 0, height: layout.totalHeight + 100 },
    "tx-0",
  );
  assert.equal(hidden.hidden, true);
  assert.equal(minimapScrollTopForRatio(-1, 1_000, 200), 0);
  assert.equal(minimapScrollTopForRatio(0.5, 1_000, 200), 400);
  assert.equal(minimapScrollTopForRatio(2, 1_000, 200), 800);
  assert.equal(minimapKeyboardScrollTop("Home", 400, 1_000, 200), 0);
  assert.equal(minimapKeyboardScrollTop("End", 400, 1_000, 200), 800);
  assert.equal(minimapKeyboardScrollTop("ArrowUp", 10, 1_000, 200), 0);
  assert.equal(minimapKeyboardScrollTop("PageDown", 700, 1_000, 200), 800);
  assert.equal(minimapKeyboardScrollTop("Enter", 400, 1_000, 200), null);
});

test("TranscriptMinimap emits a keyboard-focusable scrollbar contract and marker metadata", () => {
  const layout = denseLayout();
  const html = renderToStaticMarkup(createElement(TranscriptMinimap, {
    layout,
    viewport: { scrollTop: 420, height: 360 },
    selectedTranscriptId: "tx-10",
    comparisonTranscriptIds: ["tx-3"],
    pinnedTranscriptIds: ["tx-18"],
    controlsId: "track-scroller",
    onNavigate: () => undefined,
  }));
  assert.match(html, /role="scrollbar"/);
  assert.match(html, /aria-controls="track-scroller"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-valuetext="Transcript viewport, rows \d+ through \d+ of 20"/);
  assert.match(html, /data-transcript-id="tx-10"/);
  assert.match(html, /data-selected="true"/);
  assert.match(html, /data-comparison-marker-count="1"/);
  assert.match(html, /data-pinned-marker-count="1"/);

  const noOverflow = renderToStaticMarkup(createElement(TranscriptMinimap, {
    layout,
    viewport: { scrollTop: 0, height: layout.totalHeight },
    selectedTranscriptId: "tx-0",
    onNavigate: () => undefined,
  }));
  assert.equal(noOverflow, "");
});

test("new foundations remain callback-only and never mutate background scroll state", () => {
  const navigatorSource = readFileSync(
    new URL("../src/components/TranscriptNavigator.tsx", import.meta.url),
    "utf8",
  );
  const minimapSource = readFileSync(
    new URL("../src/components/TranscriptMinimap.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(navigatorSource, /\buseState\b|\buseEffect\b/);
  assert.doesNotMatch(minimapSource, /\buseState\b|\buseEffect\b|\bwindow\s*\.|\bdocument\s*\./);
  assert.doesNotMatch(minimapSource, /\.scroll(?:To|By)\s*\(|\.scrollTop\s*=/);
  assert.match(navigatorSource, /onQueryChange/);
  assert.match(navigatorSource, /onSelectTranscript/);
  assert.match(minimapSource, /onNavigate/);
});
