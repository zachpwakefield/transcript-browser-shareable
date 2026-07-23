import assert from "node:assert/strict";
import test from "node:test";
import { SP1_GENE } from "../src/data/sp1.ts";
import { filterTranscriptsWithContext } from "../src/lib/filters.ts";
import { transcriptsForDisplay } from "../src/lib/navigation.ts";
import {
  applyTranscriptOrder,
  moveTranscriptRelative,
  normalizeTranscriptOrder,
  transcriptNeighborIds,
} from "../src/lib/transcriptOrder.ts";

const canonicalIds = SP1_GENE.transcripts.map((transcript) => transcript.id);

test("empty transcript order preserves the immutable canonical order", () => {
  assert.deepEqual(
    applyTranscriptOrder(SP1_GENE.transcripts, []).map((transcript) => transcript.id),
    canonicalIds,
  );
  assert.deepEqual(normalizeTranscriptOrder(canonicalIds, canonicalIds), []);
});

test("custom order is a complete, sanitized gene-scoped permutation", () => {
  const requested = [canonicalIds[2], canonicalIds[0], canonicalIds[2], "UNKNOWN"];
  assert.deepEqual(normalizeTranscriptOrder(canonicalIds, requested), [
    canonicalIds[2],
    canonicalIds[0],
    canonicalIds[1],
    canonicalIds[3],
  ]);
});

test("transcripts move one row or directly beside a selected anchor", () => {
  const besideSelected = moveTranscriptRelative(
    canonicalIds,
    [],
    canonicalIds[3],
    canonicalIds[0],
    "after",
  );
  assert.deepEqual(besideSelected, [
    canonicalIds[0],
    canonicalIds[3],
    canonicalIds[1],
    canonicalIds[2],
  ]);
  assert.deepEqual(transcriptNeighborIds(besideSelected, canonicalIds[0]), [canonicalIds[3]]);

  const restored = moveTranscriptRelative(
    canonicalIds,
    besideSelected,
    canonicalIds[3],
    canonicalIds[2],
    "after",
  );
  assert.deepEqual(restored, []);
});

test("filtered rows retain the custom relative order and selected context", () => {
  const customIds = [canonicalIds[2], canonicalIds[1], canonicalIds[0], canonicalIds[3]];
  const ordered = applyTranscriptOrder(SP1_GENE.transcripts, customIds);
  const visible = filterTranscriptsWithContext(
    ordered,
    ["protein_coding"],
    [],
    canonicalIds[2],
    [canonicalIds[1]],
  );
  assert.deepEqual(visible.map((transcript) => transcript.id), [canonicalIds[2], canonicalIds[1]]);
});

test("selected neighbors remain adjacent across the bounded transcript prefix", () => {
  const fixture = Array.from({ length: 130 }, (_, index) => ({
    ...SP1_GENE.transcripts[0],
    id: `TX${String(index).padStart(3, "0")}`,
    versionedId: `TX${String(index).padStart(3, "0")}.1`,
    name: `Transcript ${index}`,
  }));
  const selectedId = "TX125";
  const neighborIds = transcriptNeighborIds(fixture.map((transcript) => transcript.id), selectedId);
  const displayed = transcriptsForDisplay(
    fixture,
    "expanded",
    selectedId,
    [],
    120,
    neighborIds,
    "TX129",
    ["TX128"],
  );
  assert.deepEqual(displayed.slice(-5).map((transcript) => transcript.id), ["TX124", "TX125", "TX126", "TX128", "TX129"]);
  assert.equal(displayed.length, 125);
});
