import assert from "node:assert/strict";
import test from "node:test";
import { SP1_GENE } from "../src/data/sp1";
import { createPdfPreset, resolveQuickPdfPreset } from "../src/lib/pdfPreset";

const buildHash = "build-123";
const context = {
  buildHash,
  gene: SP1_GENE,
  visuallyOrderedTranscripts: SP1_GENE.transcripts,
  selectedTranscriptId: SP1_GENE.transcripts[0].id,
  comparisonTranscriptId: SP1_GENE.transcripts[1].id,
  pinnedTranscriptIds: [SP1_GENE.transcripts[2].id],
  locus: { chrom: SP1_GENE.chrom, start0: SP1_GENE.start0, end0: SP1_GENE.end0 },
};

test("reuses a valid selected-plus-comparison preset in visual order", () => {
  const preset = createPdfPreset(buildHash, {
    scope: "selected_comparison",
    sections: ["summary", "structure"],
    featureSources: [],
    structureScope: "full",
  });
  const result = resolveQuickPdfPreset(preset, context);
  assert.equal(result.valid, true);
  if (result.valid) assert.deepEqual(result.transcriptIds, [context.selectedTranscriptId, context.comparisonTranscriptId]);
});

test("rejects build mismatch and stale comparison without omission", () => {
  const preset = createPdfPreset(buildHash, {
    scope: "selected_comparison",
    sections: ["summary"],
    featureSources: [],
    structureScope: "full",
  });
  assert.equal(resolveQuickPdfPreset(preset, { ...context, buildHash: "other" }).valid, false);
  assert.equal(resolveQuickPdfPreset(preset, { ...context, comparisonTranscriptId: "STALE" }).valid, false);
});

test("rejects stale sequence ranges", () => {
  const preset = createPdfPreset(buildHash, {
    scope: "selected",
    sections: ["summary", "sequence"],
    featureSources: [],
    structureScope: "full",
    sequenceExcerpt: { kind: "protein", start1: 1, end1: 10_000 },
  });
  const result = resolveQuickPdfPreset(preset, context);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /exceeds/);
});
