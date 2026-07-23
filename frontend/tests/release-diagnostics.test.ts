import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FIRST_GENE_RENDER_MEASURE,
  MAX_FPS_SAMPLES,
  MAX_LISTED_RESOURCE_ORIGINS,
  MAX_LISTED_RESOURCE_URL_LENGTH,
  MAX_LISTED_RESOURCE_URLS,
  canvasBackingBytes,
  firstGeneRenderDuration,
  framesPerSecond,
  summarizeResourceNames,
} from "../src/lib/releaseDiagnostics";

function performanceEntry(
  name: string,
  entryType: string,
  duration: number,
): PerformanceEntry {
  return {
    name,
    entryType,
    duration,
    startTime: 0,
    toJSON: () => ({}),
  };
}

test("release diagnostics expose stable hidden local DOM fields", () => {
  const source = readFileSync(
    new URL("../src/components/ReleaseDiagnostics.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /data-release-diagnostics="local"/);
  assert.match(source, /data-first-gene-render-ms=/);
  assert.match(source, /data-fps-samples=/);
  assert.match(source, /data-long-task-count=/);
  assert.match(source, /data-long-task-max-ms=/);
  assert.match(source, /data-js-heap-used-bytes=/);
  assert.match(source, /data-user-agent-memory-status=/);
  assert.match(source, /data-user-agent-memory-bytes=/);
  assert.match(source, /data-canvas-backing-bytes=/);
  assert.match(source, /data-user-agent=/);
  assert.match(source, /data-device-pixel-ratio=/);
  assert.match(source, /data-viewport-width=/);
  assert.match(source, /data-viewport-height=/);
  assert.match(source, /data-external-resource-count=/);
  assert.match(source, /VISUALLY_HIDDEN/);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/);
});

test("Canvas diagnostic reports conservative RGBA backing bytes", () => {
  assert.equal(canvasBackingBytes([{ width: 200, height: 100 }]), 80_000);
  assert.equal(canvasBackingBytes([
    { width: 200, height: 100 },
    { width: 50, height: 20 },
  ]), 84_000);
  assert.equal(canvasBackingBytes([{ width: Number.NaN, height: 100 }]), 0);
});

test("first-gene measure and FPS calculations reject unusable samples", () => {
  const entries = [
    performanceEntry(FIRST_GENE_RENDER_MEASURE, "mark", 0),
    performanceEntry(FIRST_GENE_RENDER_MEASURE, "measure", 184.25),
  ];
  assert.equal(firstGeneRenderDuration(entries), 184.25);
  assert.equal(firstGeneRenderDuration([performanceEntry("other", "measure", 1)]), null);
  assert.equal(framesPerSecond([]), null);
  assert.equal(framesPerSecond([5, 5]), null);
  const fps = framesPerSecond([0, 16.6667, 33.3334, 50.0001]);
  assert.ok(fps !== null && Math.abs(fps - 60) < 0.001);
  assert.equal(MAX_FPS_SAMPLES, 120);
});

test("resource diagnostics count all entries but strictly bound emitted URL and origin lists", () => {
  const localOrigin = "http://127.0.0.1:8765";
  const names = [
    `${localOrigin}/assets/app.js`,
    `${localOrigin}/api/v1/gene/ENSG1`,
    "https://external.example/library.js",
    "data:text/plain,local",
    ...Array.from(
      { length: MAX_LISTED_RESOURCE_URLS + 8 },
      (_, index) => `https://origin-${index}.example/${"x".repeat(MAX_LISTED_RESOURCE_URL_LENGTH + 20)}`,
    ),
  ];
  const summary = summarizeResourceNames(names, `${localOrigin}/`, localOrigin);

  assert.equal(summary.totalEntries, names.length);
  assert.equal(summary.externalEntries, MAX_LISTED_RESOURCE_URLS + 9);
  assert.equal(summary.urls.length, MAX_LISTED_RESOURCE_URLS);
  assert.equal(summary.origins.length, MAX_LISTED_RESOURCE_ORIGINS);
  assert.equal(summary.urlsTruncated, true);
  assert.equal(summary.originsTruncated, true);
  assert.ok(summary.urls.every((url) => url.length <= MAX_LISTED_RESOURCE_URL_LENGTH));
  assert.ok(summary.origins.includes("data:"));
});
