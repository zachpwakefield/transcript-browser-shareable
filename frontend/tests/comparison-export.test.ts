import assert from "node:assert/strict";
import test from "node:test";
import { SP1_GENE } from "../src/data/sp1.ts";
import {
  buildTranscriptComparison,
  compareTranscriptTags,
  comparisonCellExportValue,
  missingCell,
  notApplicableCell,
  notLoadedCell,
  transcriptHasAnnotationFlag,
  valueCell,
} from "../src/lib/comparison.ts";
import {
  COMPARISON_EXPORT_COLUMNS,
  ComparisonExportSelectionError,
  MAX_COMPARISON_EXPORT_TRANSCRIPTS,
  buildComparisonExportRows,
  comparisonExportFilename,
  protectSpreadsheetUserValue,
  quoteDelimitedField,
  selectComparisonExportTranscripts,
  serializeComparisonExport,
} from "../src/lib/comparisonExport.ts";
import type { Transcript } from "../src/types.ts";

function readyTranscript(index: number): Transcript {
  return {
    ...SP1_GENE.transcripts[index],
    detailState: "ready",
    featuresState: "ready",
  };
}

test("comparison metrics keep missing, zero, not-applicable, and not-loaded distinct", () => {
  const selected = readyTranscript(0);
  const comparison: Transcript = {
    ...readyTranscript(1),
    proteinId: "",
    versionedProteinId: "",
    cdsLength: 0,
    proteinLength: 0,
    annotationLevel: undefined,
    ccdsId: undefined,
    appris: undefined,
    exons: [],
    features: [],
    detailState: "loading",
    featuresState: "idle",
  };
  const model = buildTranscriptComparison(selected, comparison, ["interpro", "signalp"]);
  const byKey = new Map(model.rows.map((row) => [row.key, row]));

  assert.equal(byKey.get("protein-length")?.comparison.state, "not-applicable");
  assert.equal(byKey.get("cds-length")?.comparison.display, "Not applicable");
  assert.equal(byKey.get("annotation-level")?.comparison.state, "missing");
  assert.equal(byKey.get("exon-count")?.comparison.state, "not-loaded");
  assert.equal(byKey.get("feature-count-interpro")?.comparison.state, "not-loaded");
  assert.equal(byKey.get("feature-count-signalp")?.selected.state, "zero");
  assert.equal(byKey.get("feature-count-signalp")?.selected.value, 0);
  assert.equal(byKey.get("transcript-length")?.different, true);
  assert.equal(model.selectedTranscriptId, selected.id);
  assert.equal(model.comparisonTranscriptId, comparison.id);
});

test("comparison tags are case-insensitively deduplicated and deterministically partitioned", () => {
  const tags = compareTranscriptTags(
    { tags: ["GENCODE Basic", "shared", "alpha", "SHARED", " "] },
    { tags: ["Shared", "beta", "gencode basic"] },
  );
  assert.deepEqual(tags, {
    shared: ["GENCODE Basic", "shared"],
    selectedOnly: ["alpha"],
    comparisonOnly: ["beta"],
  });
});

test("scientific annotation flags normalize API tags and compact badges", () => {
  const transcript = {
    tags: ["MANE_Select", "MANE_Plus_Clinical", "GENCODE Basic"],
    badges: ["Canonical"],
  };
  assert.equal(transcriptHasAnnotationFlag(transcript, "mane-select"), true);
  assert.equal(transcriptHasAnnotationFlag(transcript, "mane-plus-clinical"), true);
  assert.equal(transcriptHasAnnotationFlag(transcript, "ensembl-canonical"), true);
  assert.equal(transcriptHasAnnotationFlag(transcript, "gencode-basic"), true);
});

test("comparison cell export values retain genuine zero and label unavailable states", () => {
  assert.equal(comparisonCellExportValue(valueCell(0)), 0);
  assert.equal(comparisonCellExportValue(missingCell()), "");
  assert.equal(comparisonCellExportValue(notApplicableCell()), "N/A");
  assert.equal(comparisonCellExportValue(notLoadedCell()), "Not loaded");
});

test("export selection preserves visual order and independently records roles", () => {
  const visualOrder = [
    readyTranscript(2),
    readyTranscript(0),
    readyTranscript(3),
    readyTranscript(1),
  ];
  const selected = visualOrder[3];
  const comparison = visualOrder[0];
  const selection = selectComparisonExportTranscripts(visualOrder, {
    selectedTranscriptId: selected.id,
    comparisonTranscriptId: comparison.id,
    pinnedTranscriptIds: [selected.id, visualOrder[2].id],
    includePinned: true,
  });
  assert.deepEqual(
    selection.map(({ transcript }) => transcript.id),
    [comparison.id, visualOrder[2].id, selected.id],
  );
  assert.deepEqual(
    selection.map(({ selected, comparison, pinned }) => ({ selected, comparison, pinned })),
    [
      { selected: false, comparison: true, pinned: false },
      { selected: false, comparison: false, pinned: true },
      { selected: true, comparison: false, pinned: true },
    ],
  );
});

test("export selection rejects stale context, same-row comparison, and overflow without truncation", () => {
  assert.throws(
    () => selectComparisonExportTranscripts(SP1_GENE.transcripts, {
      selectedTranscriptId: SP1_GENE.transcripts[0].id,
      comparisonTranscriptId: "STALE",
    }),
    (error) => error instanceof ComparisonExportSelectionError && error.code === "missing-comparison",
  );
  assert.throws(
    () => selectComparisonExportTranscripts(SP1_GENE.transcripts, {
      selectedTranscriptId: SP1_GENE.transcripts[0].id,
      comparisonTranscriptId: SP1_GENE.transcripts[0].id,
    }),
    (error) => error instanceof ComparisonExportSelectionError && error.code === "same-transcript",
  );

  const largeGene = Array.from({ length: MAX_COMPARISON_EXPORT_TRANSCRIPTS + 1 }, (_, index) => ({
    ...readyTranscript(0),
    id: `TX${index}`,
    versionedId: `TX${index}.1`,
  }));
  assert.throws(
    () => selectComparisonExportTranscripts(largeGene, {
      selectedTranscriptId: largeGene[0].id,
      comparisonTranscriptId: largeGene[1].id,
      pinnedTranscriptIds: largeGene.map((transcript) => transcript.id),
      includePinned: true,
    }),
    (error) => error instanceof ComparisonExportSelectionError
      && error.code === "too-many-transcripts"
      && error.transcriptIds.length === MAX_COMPARISON_EXPORT_TRANSCRIPTS + 1,
  );
});

test("export rows use stable columns, explicit unavailable values, feature counts, roles, and local annotations", () => {
  const selected = readyTranscript(0);
  const noncoding: Transcript = {
    ...readyTranscript(2),
    geneId: SP1_GENE.id,
    proteinId: "",
    versionedProteinId: "",
    cdsLength: 0,
    proteinLength: 0,
    exons: [],
    features: [],
    detailState: "idle",
    featuresState: "ready",
  };
  const selection = selectComparisonExportTranscripts([noncoding, selected], {
    selectedTranscriptId: selected.id,
    comparisonTranscriptId: noncoding.id,
  });
  const rows = buildComparisonExportRows("build-123", SP1_GENE, selection, {
    [`transcript:${selected.id}`]: {
      note: "candidate",
      tags: ["reviewed", "isoform"],
      updatedAt: "2026-07-14T00:00:00.000Z",
    },
  });

  assert.deepEqual(Object.keys(rows[0]), COMPARISON_EXPORT_COLUMNS);
  assert.deepEqual(rows.map((row) => row.transcript_id), [noncoding.id, selected.id]);
  assert.equal(rows[0].protein_length, "N/A");
  assert.equal(rows[0].exon_count, "Not loaded");
  assert.equal(rows[0].feature_count_signalp, 0);
  assert.equal(rows[0].is_comparison, true);
  assert.equal(rows[1].is_selected, true);
  assert.equal(rows[1].user_note, "candidate");
  assert.equal(rows[1].user_tags, "reviewed; isoform");
});

test("export rows reject transcripts explicitly associated with another gene", () => {
  const foreign = { ...readyTranscript(0), geneId: "ENSG_FOREIGN" };
  assert.throws(
    () => buildComparisonExportRows("build", SP1_GENE, [{
      transcript: foreign,
      selected: true,
      comparison: false,
      pinned: false,
    }]),
    (error) => error instanceof ComparisonExportSelectionError && error.code === "wrong-gene",
  );
});

test("CSV and TSV serialization quote delimiters and neutralize formulas only in user-authored fields", () => {
  const selected = { ...readyTranscript(0), name: "-scientific,name" };
  const selection = selectComparisonExportTranscripts([selected], {
    selectedTranscriptId: selected.id,
  });
  const [row] = buildComparisonExportRows("build", SP1_GENE, selection, {
    [`transcript:${selected.id}`]: {
      note: "=HYPERLINK(\"bad\",\"x\")\nsecond line",
      tags: ["@review"],
      updatedAt: "2026-07-14T00:00:00.000Z",
    },
  });
  const csv = serializeComparisonExport([row], "csv");
  const tsv = serializeComparisonExport([{ ...row, user_note: "has\ttab" }], "tsv");

  assert.match(csv, /"-scientific,name"/);
  assert.doesNotMatch(csv, /'-scientific/);
  assert.match(csv, /"'=HYPERLINK\(""bad"",""x""\)\nsecond line"/);
  assert.match(csv, /'@review/);
  assert.equal(csv.endsWith("\n"), true);
  assert.match(tsv, /"has\ttab"/);
  assert.equal(quoteDelimitedField('one"two', ","), '"one""two"');
  assert.equal(protectSpreadsheetUserValue("  +SUM(A1:A2)"), "'  +SUM(A1:A2)");
  assert.equal(protectSpreadsheetUserValue("\tuntrusted"), "'\tuntrusted");
  assert.equal(protectSpreadsheetUserValue("safe = text"), "safe = text");
});

test("comparison export filenames include sanitized gene, immutable build identity, and format", () => {
  assert.equal(
    comparisonExportFilename("SP 1/beta", "build:abc/123", "tsv"),
    "SP_1_beta_build_abc_123_transcript-comparison.tsv",
  );
  assert.equal(
    comparisonExportFilename("", "", "csv"),
    "gene_unknown-build_transcript-comparison.csv",
  );
});
