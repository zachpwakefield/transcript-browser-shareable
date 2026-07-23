import type { FeatureSource, RowDensity, Transcript } from "../types";

export const GENE_HEADER_HEIGHT = 52;
export const COLLAPSED_ROW_HEIGHT = 66;
export const PROJECTION_LANE_HEIGHT = 18;
export const EXPANDED_BASE_HEIGHT = 180;
export const COMPACT_COLLAPSED_ROW_HEIGHT = 54;
export const COMPACT_PROJECTION_LANE_HEIGHT = 16;
export const COMPACT_EXPANDED_BASE_HEIGHT = 162;

export interface TranscriptRowLayout {
  transcriptId: string;
  y: number;
  height: number;
  modelY: number;
  projectionTop: number;
  proteinTop: number;
  proteinHeight: number;
  projectionLaneHeight: number;
  expanded: boolean;
  laneSources: FeatureSource[];
}

export interface BrowserRowLayout {
  geneHeaderHeight: number;
  rows: TranscriptRowLayout[];
  totalHeight: number;
  density: RowDensity;
}

export function sourcesForTranscript(
  transcript: Transcript,
  activeSources: readonly FeatureSource[],
): FeatureSource[] {
  const available = new Set(transcript.features.map((feature) => feature.source));
  return activeSources.filter((source) => available.has(source));
}

export function expandedRowHeight(laneCount: number, density: RowDensity = "comfortable"): number {
  const baseHeight = density === "compact" ? COMPACT_EXPANDED_BASE_HEIGHT : EXPANDED_BASE_HEIGHT;
  const laneHeight = density === "compact" ? COMPACT_PROJECTION_LANE_HEIGHT : PROJECTION_LANE_HEIGHT;
  return baseHeight + Math.max(0, laneCount - 1) * laneHeight;
}

export function buildRowLayout(
  transcripts: readonly Transcript[],
  expandedTranscriptIds: readonly string[],
  activeSources: readonly FeatureSource[],
  density: RowDensity = "comfortable",
): BrowserRowLayout {
  const expanded = new Set(expandedTranscriptIds);
  let y = GENE_HEADER_HEIGHT;
  const collapsedHeight = density === "compact" ? COMPACT_COLLAPSED_ROW_HEIGHT : COLLAPSED_ROW_HEIGHT;
  const projectionLaneHeight = density === "compact"
    ? COMPACT_PROJECTION_LANE_HEIGHT
    : PROJECTION_LANE_HEIGHT;
  const rows = transcripts.map((transcript) => {
    const isExpanded = expanded.has(transcript.id);
    const laneSources = isExpanded ? sourcesForTranscript(transcript, activeSources) : [];
    // Reserve geometry from the active source selection rather than from
    // asynchronously arriving feature rows. Background feature completion can
    // populate lanes, but it must never move the user's transcript viewport.
    const reservedLaneCount = isExpanded ? activeSources.length : 0;
    const height = isExpanded ? expandedRowHeight(reservedLaneCount, density) : collapsedHeight;
    const proteinHeight = Math.max(density === "compact" ? 52 : 58, 36 + reservedLaneCount * 7);
    const row: TranscriptRowLayout = {
      transcriptId: transcript.id,
      y,
      height,
      modelY: y + (density === "compact" ? 26 : 32),
      projectionTop: y + (density === "compact" ? 58 : 70),
      proteinTop: y + height - proteinHeight - 10,
      proteinHeight,
      projectionLaneHeight,
      expanded: isExpanded,
      laneSources,
    };
    y += height;
    return row;
  });
  return { geneHeaderHeight: GENE_HEADER_HEIGHT, rows, totalHeight: y, density };
}
