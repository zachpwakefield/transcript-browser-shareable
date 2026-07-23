import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSequenceLineRange } from "../src/lib/sequence";
import {
  MAX_CANVAS_BITMAP_PIXELS,
  MAX_TRACK_WINDOW_CSS_HEIGHT,
  boundedCanvasBitmapSize,
  fixedRowWindow,
  transcriptDemandIds,
  variableRowWindow,
} from "../src/lib/windowing";

function collapsedRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({ y: 52 + index * 66, height: 66 }));
}

test("296-transcript dense locus uses one shared bounded DPR2 track window", () => {
  const rows = collapsedRows(296);
  const totalHeight = 52 + rows.length * 66;
  const window = variableRowWindow(rows, totalHeight, 0, 720);
  const bitmap = boundedCanvasBitmapSize(1_278, window.height, 2);

  assert.ok(window.height <= MAX_TRACK_WINDOW_CSS_HEIGHT);
  assert.ok(window.lastIndexExclusive - window.firstIndex < 30);
  assert.equal(bitmap.dpr, 2);
  assert.ok(bitmap.width * bitmap.height <= MAX_CANVAS_BITMAP_PIXELS);
  assert.ok(bitmap.height < totalHeight * 2);

  const bottom = variableRowWindow(rows, totalHeight, totalHeight - 720, 720);
  assert.equal(bottom.lastIndexExclusive, 296);
  assert.ok(bottom.firstIndex > 270);
  assert.ok(bottom.height <= MAX_TRACK_WINDOW_CSS_HEIGHT);
});

test("oversized display reduces backing scale instead of exceeding the Canvas pixel cap", () => {
  const bitmap = boundedCanvasBitmapSize(3_200, 3_000, 2);
  assert.ok(bitmap.dpr < 2);
  assert.ok(bitmap.width * bitmap.height <= MAX_CANVAS_BITMAP_PIXELS);
});

test("table and longest-build sequence windows keep mounted row counts small", () => {
  const table = fixedRowWindow(500, 8_000, 520, 44);
  assert.ok(table.lastIndexExclusive - table.firstIndex <= 26);
  assert.equal(table.paddingTop + table.paddingBottom + (table.lastIndexExclusive - table.firstIndex) * 44, 500 * 44);

  // Longest v45 transcript_full sequence is 109,224 nt => 1,821 lines at 60 nt.
  const sequence = fixedRowWindow(1_821, 20_000, 360, 22);
  assert.ok(sequence.lastIndexExclusive - sequence.firstIndex <= 30);
  assert.equal(sequence.paddingTop + sequence.paddingBottom + (sequence.lastIndexExclusive - sequence.firstIndex) * 22, 1_821 * 22);
});

test("large-gene mode change requests only window rows plus explicit context", () => {
  const all = Array.from({ length: 296 }, (_, index) => `tx-${index}`);
  const windowed = all.slice(0, 18);
  const demand = transcriptDemandIds(windowed, "tx-295", ["tx-294"], ["tx-293"], "tx-292");
  assert.equal(demand.length, 22);
  assert.deepEqual(demand.slice(-4), ["tx-295", "tx-292", "tx-294", "tx-293"]);
  assert.equal(demand.includes("tx-200"), false);
});

test("sequence transform builds only the virtual line interval", () => {
  const sequence = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(100);
  const lines = buildSequenceLineRange(
    sequence,
    [{ start0: 610, end0: 650, className: "selected-feature", label: "selected" }],
    10,
    14,
    60,
  );
  assert.equal(lines.length, 4);
  assert.equal(lines[0].start1, 601);
  assert.equal(lines.at(-1)?.end1, 840);
  assert.equal(lines.flatMap((line) => line.segments).map((segment) => segment.text).join(""), sequence.slice(600, 840));
  assert.ok(lines.some((line) => line.segments.some((segment) => segment.className === "selected-feature")));
});

test("inspector and track components consume virtual windows instead of hard truncation", () => {
  const inspector = readFileSync(new URL("../src/components/Inspector.tsx", import.meta.url), "utf8");
  const canvas = readFileSync(new URL("../src/components/GenomeCanvas.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(inspector, /fixedRowWindow/);
  assert.match(inspector, /buildSequenceLineRange/);
  assert.doesNotMatch(inspector, /filteredFeatures\.slice\(0,\s*500\)/);
  assert.match(canvas, /renderWindow\.firstIndex/);
  assert.match(canvas, /boundedCanvasBitmapSize/);
  assert.match(app, /windowAndContextDemandIds/);
  assert.match(app, /windowedTranscripts/);
});

test("search result selection blurs real focus and refocus cancels the old blur timer", () => {
  const command = readFileSync(new URL("../src/components/CommandBar.tsx", import.meta.url), "utf8");
  assert.match(command, /const inputRef = useRef<HTMLInputElement>/);
  assert.match(command, /inputRef\.current\?\.blur\(\)/);
  assert.match(command, /onFocus=\{\(\) => \{\s*cancelPendingBlur\(\)/);
  assert.match(command, /window\.clearTimeout\(blurTimer\.current\)/);
  assert.match(command, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(command, /onSubmit\(result\.label, result\);\s*closePaletteAndBlur\(\)/);
});
