import type { PdfReportRequest, SequenceKind } from "../api";
import type { Gene, Locus, Transcript } from "../types";
import {
  MAX_PDF_PRESET_TRANSCRIPTS,
  validatePdfPreset,
  type PdfPreset,
} from "./workspaceStore";

export const MAX_QUICK_PDF_SEQUENCE_CHARS = 20_000;

export interface QuickPdfContext {
  buildHash: string;
  gene: Gene;
  visuallyOrderedTranscripts: readonly Transcript[];
  selectedTranscriptId: string;
  comparisonTranscriptId: string;
  pinnedTranscriptIds: readonly string[];
  locus: Locus;
}

export type QuickPdfResolution =
  | { valid: true; request: PdfReportRequest; transcriptIds: string[] }
  | { valid: false; reason: string };

function sequenceLength(transcript: Transcript, kind: SequenceKind): number {
  const declared = transcript.sequences?.[kind];
  if (declared) return declared.available ? declared.length : 0;
  if (kind === "protein") return transcript.proteinLength;
  if (kind === "cds") return transcript.fastaCdsSpanLength ?? transcript.cdsLength;
  return transcript.transcriptLength;
}

export function resolveQuickPdfPreset(preset: unknown, context: QuickPdfContext): QuickPdfResolution {
  const validated = validatePdfPreset(preset, context.buildHash);
  if (!validated) return { valid: false, reason: "The saved PDF preset is invalid or belongs to another build." };
  const requested = validated.scope === "selected"
    ? [context.selectedTranscriptId]
    : validated.scope === "selected_comparison"
      ? [context.selectedTranscriptId, context.comparisonTranscriptId]
      : [context.selectedTranscriptId, ...context.pinnedTranscriptIds];
  const requestedIds = [...new Set(requested.filter(Boolean))];
  if (validated.scope === "selected_comparison" && !context.comparisonTranscriptId) {
    return { valid: false, reason: "The saved preset requires a comparison transcript." };
  }
  if (!requestedIds.length) return { valid: false, reason: "The saved preset has no current transcript." };
  if (requestedIds.length > MAX_PDF_PRESET_TRANSCRIPTS) {
    return { valid: false, reason: `The saved preset requests ${requestedIds.length} transcripts; the limit is ${MAX_PDF_PRESET_TRANSCRIPTS}.` };
  }
  const byId = new Map(context.visuallyOrderedTranscripts.map((transcript) => [transcript.id, transcript]));
  const missing = requestedIds.filter((id) => !byId.has(id));
  if (missing.length) return { valid: false, reason: "One or more saved-scope transcripts are stale for the current gene." };
  const transcriptIds = context.visuallyOrderedTranscripts
    .filter((transcript) => requestedIds.includes(transcript.id))
    .map((transcript) => transcript.id);
  if (transcriptIds.length !== requestedIds.length) return { valid: false, reason: "The current visual order could not resolve every requested transcript." };

  if (validated.sequenceExcerpt) {
    const span = validated.sequenceExcerpt.end1 - validated.sequenceExcerpt.start1 + 1;
    const lengths = transcriptIds.map((id) => sequenceLength(byId.get(id)!, validated.sequenceExcerpt!.kind));
    if (!lengths.length || lengths.some((length) => length <= 0)) {
      return { valid: false, reason: `The saved ${validated.sequenceExcerpt.kind} sequence section is unavailable for a requested transcript.` };
    }
    if (lengths.some((length) => validated.sequenceExcerpt!.end1 > length)) {
      return { valid: false, reason: "The saved sequence range exceeds a current transcript sequence." };
    }
    if (span * transcriptIds.length > MAX_QUICK_PDF_SEQUENCE_CHARS) {
      return { valid: false, reason: `The saved sequence scope exceeds the ${MAX_QUICK_PDF_SEQUENCE_CHARS.toLocaleString()}-character combined limit.` };
    }
  }

  return {
    valid: true,
    transcriptIds,
    request: {
      buildHash: context.buildHash,
      geneId: context.gene.id,
      transcriptIds,
      sections: validated.sections,
      featureSources: validated.sections.includes("features") ? validated.featureSources : [],
      structureScope: validated.structureScope,
      locus: validated.structureScope === "current_locus" ? context.locus : undefined,
      sequenceExcerpt: validated.sequenceExcerpt,
    },
  };
}

export function createPdfPreset(
  buildHash: string,
  input: Omit<PdfPreset, "buildHash" | "updatedAt">,
  updatedAt = new Date().toISOString(),
): PdfPreset {
  const preset = validatePdfPreset({ ...input, buildHash, updatedAt }, buildHash);
  if (!preset) throw new Error("The PDF preset is invalid.");
  return preset;
}

