import assert from "node:assert/strict";
import test from "node:test";
import { formatDiagnostics, safeServiceOrigin } from "../src/lib/diagnostics";

test("diagnostics are bounded to support-safe fields", () => {
  const output = formatDiagnostics({
    applicationVersion: "1.1.0",
    buildHash: "hash",
    gencodeRelease: "GENCODE v45",
    ensemblRelease: "111",
    assembly: "GRCh38.p14",
    schemaVersion: "1.1.0",
    capabilities: ["pdfReports", "offlineRuntime"],
    pdfAvailable: true,
    currentGene: "SP1",
    currentTranscript: "ENST00000327443.9",
    viewportWidth: 1200,
    viewportHeight: 800,
    devicePixelRatio: 2,
    serviceUrl: "http://127.0.0.1:8765/private/path?note=secret",
    externalResourceCount: 0,
  });
  assert.match(output, /Application version: 1\.1\.0/);
  assert.match(output, /Local service: http:\/\/127\.0\.0\.1:8765/);
  assert.doesNotMatch(output, /private|secret/);
  assert.doesNotMatch(output, /Users\/zachary/);
});

test("diagnostics never expose non-loopback service URLs", () => {
  assert.equal(safeServiceOrigin("https://example.org/user/zach"), "non-loopback origin (unexpected)");
});

