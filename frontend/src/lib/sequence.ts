import type { ProteinFeature, Transcript } from "../types";
import type { SequenceKind } from "../api";

export interface SequenceDecoration {
  start0: number;
  end0: number;
  className: string;
  label: string;
}

export interface SequenceLineSegment {
  text: string;
  className: string;
}

export interface SequenceLine {
  start1: number;
  end1: number;
  segments: SequenceLineSegment[];
}

export function sequenceDecorations(
  transcript: Transcript,
  kind: SequenceKind,
  selectedFeature?: ProteinFeature,
): SequenceDecoration[] {
  const decorations: SequenceDecoration[] = [];
  if (kind === "protein") {
    transcript.exons.forEach((exon, index) => {
      if (exon.aaStart === undefined || exon.aaEnd === undefined) return;
      decorations.push({
        start0: exon.aaStart - 1,
        end0: exon.aaEnd,
        className: index % 2 ? "exon-odd" : "exon-even",
        label: `coding exon ${exon.rank}`,
      });
    });
    if (selectedFeature) decorations.push({
      start0: selectedFeature.aaStart - 1,
      end0: selectedFeature.aaEnd,
      className: "selected-feature",
      label: selectedFeature.name,
    });
    return decorations;
  }

  if (kind === "cds") {
    let cursor = 0;
    transcript.exons.forEach((exon, index) => {
      if (exon.cdsStart0 === undefined || exon.cdsEnd0 === undefined) return;
      const length = exon.cdsEnd0 - exon.cdsStart0;
      decorations.push({
        start0: cursor,
        end0: cursor + length,
        className: index % 2 ? "exon-odd cds" : "exon-even cds",
        label: `coding exon ${exon.rank}`,
      });
      cursor += length;
    });
    if (selectedFeature) decorations.push({
      start0: (selectedFeature.aaStart - 1) * 3,
      end0: selectedFeature.aaEnd * 3,
      className: "selected-feature",
      label: selectedFeature.name,
    });
    return decorations;
  }

  let transcriptCursor = 0;
  transcript.exons.forEach((exon, index) => {
    const exonLength = exon.end0 - exon.start0;
    decorations.push({
      start0: transcriptCursor,
      end0: transcriptCursor + exonLength,
      className: index % 2 ? "exon-odd" : "exon-even",
      label: `exon ${exon.rank}`,
    });
    if (exon.cdsStart0 !== undefined && exon.cdsEnd0 !== undefined) {
      const localStart = transcript.strand === "+"
        ? exon.cdsStart0 - exon.start0
        : exon.end0 - exon.cdsEnd0;
      const localEnd = transcript.strand === "+"
        ? exon.cdsEnd0 - exon.start0
        : exon.end0 - exon.cdsStart0;
      decorations.push({
        start0: transcriptCursor + localStart,
        end0: transcriptCursor + localEnd,
        className: "cds",
        label: `CDS in exon ${exon.rank}`,
      });
    }
    transcriptCursor += exonLength;
  });
  return decorations;
}

export function buildSequenceLines(
  sequence: string,
  decorations: readonly SequenceDecoration[],
  lineLength = 60,
): SequenceLine[] {
  return buildSequenceLineRange(
    sequence,
    decorations,
    0,
    Math.ceil(sequence.length / Math.max(1, lineLength)),
    lineLength,
  );
}

/** Build only the requested line interval for a virtualized sequence viewport. */
export function buildSequenceLineRange(
  sequence: string,
  decorations: readonly SequenceDecoration[],
  firstLine: number,
  lastLineExclusive: number,
  lineLength = 60,
): SequenceLine[] {
  const lines: SequenceLine[] = [];
  const safeLineLength = Math.max(1, Math.floor(lineLength));
  const maximumLine = Math.ceil(sequence.length / safeLineLength);
  const first = Math.max(0, Math.min(maximumLine, Math.floor(firstLine)));
  const last = Math.max(first, Math.min(maximumLine, Math.floor(lastLineExclusive)));
  for (let lineIndex = first; lineIndex < last; lineIndex += 1) {
    const lineStart = lineIndex * safeLineLength;
    const lineEnd = Math.min(sequence.length, lineStart + safeLineLength);
    const boundaries = new Set([lineStart, lineEnd]);
    decorations.forEach((decoration) => {
      if (decoration.start0 > lineStart && decoration.start0 < lineEnd) boundaries.add(decoration.start0);
      if (decoration.end0 > lineStart && decoration.end0 < lineEnd) boundaries.add(decoration.end0);
    });
    const sorted = [...boundaries].sort((a, b) => a - b);
    const segments: SequenceLineSegment[] = [];
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const start0 = sorted[index];
      const end0 = sorted[index + 1];
      const classes = decorations
        .filter((decoration) => decoration.start0 < end0 && decoration.end0 > start0)
        .map((decoration) => decoration.className);
      segments.push({ text: sequence.slice(start0, end0), className: [...new Set(classes)].join(" ") });
    }
    lines.push({ start1: lineStart + 1, end1: lineEnd, segments });
  }
  return lines;
}
