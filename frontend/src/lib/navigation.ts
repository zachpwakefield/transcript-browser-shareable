import type {
  DisplayMode,
  DisplayModeSetting,
  Locus,
  RegionData,
  Transcript,
} from "../types";
import type { TranscriptRowLayout } from "./layout";

export const DEFAULT_TRANSCRIPT_RENDER_LIMIT = 120;
// Full v45 genes can exceed 180 isoforms (maximum 296). The shared vertical
// window keeps DOM/Canvas work bounded, so users may deliberately reveal all.
export const MAX_TRANSCRIPT_RENDER_LIMIT = 500;
// Expanded rows load local feature detail and reserve substantially more track
// height. Keep deliberate multi-expansion useful without allowing an imported
// URL/session to fan out across an entire dense gene.
export const MAX_EXPANDED_TRANSCRIPTS = 25;

export interface TranscriptRevealRequest {
  requestId: number;
  geneId: string;
  transcriptId?: string;
}

export interface TranscriptRevealDecision {
  consume: boolean;
  scrollTop?: number;
}

/**
 * Resolve one explicit navigation request against the current row geometry.
 * A handled request is consumed by the caller, even when the row is already
 * visible, so later async layout updates cannot keep pinning the viewport.
 */
export function transcriptRevealDecision(
  request: TranscriptRevealRequest | null,
  currentGeneId: string,
  targetTranscriptId: string,
  rows: readonly TranscriptRowLayout[],
  scrollTop: number,
  viewportHeight: number,
): TranscriptRevealDecision {
  if (!request || request.geneId !== currentGeneId || !targetTranscriptId) {
    return { consume: false };
  }
  const row = rows.find((item) => item.transcriptId === targetTranscriptId);
  if (!row) return { consume: false };

  const visibleTop = Math.max(0, scrollTop);
  const visibleBottom = visibleTop + Math.max(1, viewportHeight);
  const rowControlBottom = row.y + Math.min(row.height, 66);
  if (row.y < visibleTop || rowControlBottom > visibleBottom) {
    return { consume: true, scrollTop: Math.max(0, row.y - 12) };
  }
  return { consume: true };
}

export function semanticDisplayMode(
  setting: DisplayModeSetting,
  locus: Locus,
  hasExpandedSelection: boolean,
  serverDetail?: DisplayMode,
): DisplayMode {
  if (setting !== "auto") return setting;
  const span = Math.max(1, locus.end0 - locus.start0);
  if (span > 5_000_000) return "overview";
  if (span > 250_000) return "compact";
  if (hasExpandedSelection) return "expanded";
  return serverDetail === "overview" || serverDetail === "compact" ? serverDetail : "labeled";
}

export function intervalOverlapsLocus(
  chrom: string,
  start0: number,
  end0: number,
  locus: Locus,
): boolean {
  return chrom.toLowerCase().replace(/^chr/, "") === locus.chrom.toLowerCase().replace(/^chr/, "")
    && start0 < locus.end0
    && end0 > locus.start0;
}

export function transcriptsForDisplay(
  transcripts: readonly Transcript[],
  mode: DisplayMode,
  selectedTranscriptId: string,
  pinnedTranscriptIds: readonly string[],
  limit: number,
  adjacentContextIds: readonly string[] = [],
  comparisonTranscriptId = "",
  expandedTranscriptIds: readonly string[] = [],
): Transcript[] {
  const selectedAndPinned = new Set([selectedTranscriptId, comparisonTranscriptId, ...pinnedTranscriptIds]);
  if (mode === "overview") {
    return transcripts.filter((transcript) => selectedAndPinned.has(transcript.id));
  }
  const required = new Set([...selectedAndPinned, ...adjacentContextIds, ...expandedTranscriptIds]);
  transcripts
    .slice(0, Math.max(1, Math.min(MAX_TRANSCRIPT_RENDER_LIMIT, limit)))
    .forEach((transcript) => required.add(transcript.id));
  // Filtering the ordered source preserves adjacency for selected/pinned
  // overrides instead of appending them after the bounded prefix.
  return transcripts.filter((transcript) => required.has(transcript.id));
}

export function nextExpansionState(
  transcriptId: string,
  expandedTranscriptIds: readonly string[],
  forceOpen = false,
): string[] {
  const bounded = expandedTranscriptIds
    .filter((id, index, values) => Boolean(id) && values.indexOf(id) === index)
    .slice(0, MAX_EXPANDED_TRANSCRIPTS);
  if (bounded.includes(transcriptId)) {
    return forceOpen ? bounded : bounded.filter((id) => id !== transcriptId);
  }
  return bounded.length >= MAX_EXPANDED_TRANSCRIPTS ? bounded : [...bounded, transcriptId];
}

export function defaultProteinTranscriptId(transcripts: readonly Transcript[]): string {
  return transcripts.find((transcript) => transcript.proteinLength > 0)?.id
    ?? transcripts[0]?.id
    ?? "";
}

export function nextPinnedState(
  transcriptId: string,
  pinnedTranscriptIds: readonly string[],
): string[] {
  return pinnedTranscriptIds.includes(transcriptId)
    ? pinnedTranscriptIds.filter((id) => id !== transcriptId)
    : [...pinnedTranscriptIds, transcriptId];
}

export function featureSelectionForTranscript(
  selectedFeatureId: string | undefined,
  selectedFeatureTranscriptId: string | undefined,
  nextTranscriptId: string,
): string | undefined {
  return selectedFeatureId && selectedFeatureTranscriptId === nextTranscriptId
    ? selectedFeatureId
    : undefined;
}

export function canvasBitmapSize(width: number, height: number, devicePixelRatio: number) {
  const dpr = Math.max(1, Math.min(2, devicePixelRatio || 1));
  return {
    width: Math.max(1, Math.round(width * dpr)),
    height: Math.max(1, Math.round(height * dpr)),
    dpr,
  };
}

export function regionContainsSelectedGene(region: RegionData | undefined, geneId: string): boolean {
  return Boolean(region?.genes.some((gene) => gene.id === geneId));
}

export function coordinateLike(value: string): boolean {
  return /^(?:chr)?[^\s:]+\s*:\s*[\d,]+\s*(?:-|\.\.)\s*[\d,]+$/i.test(value.trim());
}

export type CanvasKeyboardCommand = "pan-left" | "pan-right" | "zoom-in" | "zoom-out";

export function canvasKeyboardCommand(
  key: string,
  shortcutsEnabled: boolean,
): CanvasKeyboardCommand | null {
  if (!shortcutsEnabled) return null;
  if (key === "ArrowLeft") return "pan-left";
  if (key === "ArrowRight") return "pan-right";
  if (key === "+" || key === "=") return "zoom-in";
  if (key === "-") return "zoom-out";
  return null;
}
