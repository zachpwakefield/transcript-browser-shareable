import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PDF_SEQUENCE_CHARS,
  MAX_PDF_SEQUENCE_EXCERPT,
  MAX_PDF_TRANSCRIPTS,
  orderedPdfTranscriptIds,
  transcriptSequenceLength,
} from "../src/components/PdfExportDialog.tsx";
import { SP1_GENE } from "../src/data/sp1.ts";

test("PDF transcript selection preserves the supplied custom visual order", () => {
  const customOrder = [
    SP1_GENE.transcripts[2],
    SP1_GENE.transcripts[0],
    SP1_GENE.transcripts[3],
    SP1_GENE.transcripts[1],
  ];
  assert.deepEqual(
    orderedPdfTranscriptIds(customOrder, [customOrder[3].id, customOrder[0].id]),
    [customOrder[0].id, customOrder[3].id],
  );
});

test("PDF sequence coordinates use the correct molecule lengths", () => {
  const transcript = SP1_GENE.transcripts[0];
  assert.equal(transcriptSequenceLength(transcript, "transcript_full"), transcript.transcriptLength);
  assert.equal(transcriptSequenceLength(transcript, "cds"), transcript.fastaCdsSpanLength);
  assert.equal(transcriptSequenceLength(transcript, "protein"), transcript.proteinLength);

  const authoritative = {
    ...transcript,
    sequences: {
      cds: { available: true, length: transcript.cdsLength + 3 },
      protein: { available: false, length: 0 },
    },
  };
  assert.equal(transcriptSequenceLength(authoritative, "cds"), transcript.cdsLength + 3);
  assert.equal(transcriptSequenceLength(authoritative, "protein"), 0);
});

test("PDF UI and service share explicit conservative export bounds", () => {
  assert.equal(MAX_PDF_TRANSCRIPTS, 20);
  assert.equal(MAX_PDF_SEQUENCE_EXCERPT, 10_000);
  assert.equal(MAX_PDF_SEQUENCE_CHARS, 20_000);
});
