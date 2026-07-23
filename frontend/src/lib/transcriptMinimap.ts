import type { BrowserRowLayout } from "./layout";

export const DEFAULT_MINIMAP_HEIGHT = 160;
export const MINIMAP_HEIGHT_MIN = 80;
export const MINIMAP_HEIGHT_MAX = 240;
export const MINIMAP_VIEWPORT_MIN_PX = 8;
export const MINIMAP_MARKER_MIN_PX = 2;

export interface TranscriptMinimapViewport {
  scrollTop: number;
  height: number;
}

export interface TranscriptMinimapMarker {
  transcriptId: string;
  topPx: number;
  heightPx: number;
  selected: boolean;
  comparison: boolean;
  pinned: boolean;
}

export interface TranscriptMinimapGeometry {
  hidden: boolean;
  heightPx: number;
  contentHeight: number;
  viewportHeight: number;
  scrollTop: number;
  maximumScrollTop: number;
  viewportTopPx: number;
  viewportHeightPx: number;
  firstVisibleIndex: number;
  lastVisibleIndexExclusive: number;
  rowCount: number;
  markers: TranscriptMinimapMarker[];
}

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function boundedHeight(value: number): number {
  return Math.round(clamp(
    finiteNonNegative(value, DEFAULT_MINIMAP_HEIGHT),
    MINIMAP_HEIGHT_MIN,
    MINIMAP_HEIGHT_MAX,
  ));
}

/**
 * Derive all minimap pixels from immutable row layout plus a supplied viewport.
 * The helper never reads or changes a scroll container.
 */
export function buildTranscriptMinimapGeometry(
  layout: BrowserRowLayout,
  viewport: TranscriptMinimapViewport,
  selectedTranscriptId: string,
  comparisonTranscriptIds: readonly string[] = [],
  pinnedTranscriptIds: readonly string[] = [],
  requestedHeight = DEFAULT_MINIMAP_HEIGHT,
): TranscriptMinimapGeometry {
  const heightPx = boundedHeight(requestedHeight);
  const finalRow = layout.rows.at(-1);
  const finalRowEnd = finalRow
    ? finiteNonNegative(finalRow.y) + finiteNonNegative(finalRow.height)
    : 0;
  const contentHeight = Math.max(1, finiteNonNegative(layout.totalHeight, 1), finalRowEnd);
  const viewportHeight = clamp(finiteNonNegative(viewport.height, 1), 1, contentHeight);
  const maximumScrollTop = Math.max(0, contentHeight - viewportHeight);
  const scrollTop = clamp(finiteNonNegative(viewport.scrollTop), 0, maximumScrollTop);
  const hidden = layout.rows.length === 0 || maximumScrollTop <= 0;
  const rawViewportHeight = (viewportHeight / contentHeight) * heightPx;
  const viewportHeightPx = hidden
    ? heightPx
    : Math.min(heightPx, Math.max(MINIMAP_VIEWPORT_MIN_PX, rawViewportHeight));
  const viewportTopPx = maximumScrollTop > 0
    ? (scrollTop / maximumScrollTop) * (heightPx - viewportHeightPx)
    : 0;
  const viewportEnd = scrollTop + viewportHeight;
  let firstVisibleIndex = 0;
  while (
    firstVisibleIndex < layout.rows.length
    && finiteNonNegative(layout.rows[firstVisibleIndex].y)
      + finiteNonNegative(layout.rows[firstVisibleIndex].height) <= scrollTop
  ) firstVisibleIndex += 1;
  let lastVisibleIndexExclusive = firstVisibleIndex;
  while (
    lastVisibleIndexExclusive < layout.rows.length
    && finiteNonNegative(layout.rows[lastVisibleIndexExclusive].y) < viewportEnd
  ) lastVisibleIndexExclusive += 1;

  const comparison = new Set(comparisonTranscriptIds);
  const pinned = new Set(pinnedTranscriptIds);
  const marked = new Set([selectedTranscriptId, ...comparison, ...pinned].filter(Boolean));
  const markers = layout.rows.flatMap((row): TranscriptMinimapMarker[] => {
    if (!marked.has(row.transcriptId)) return [];
    const rowHeight = finiteNonNegative(row.height);
    const rowTop = finiteNonNegative(row.y);
    const rawHeight = (rowHeight / contentHeight) * heightPx;
    const markerHeight = Math.min(heightPx, Math.max(MINIMAP_MARKER_MIN_PX, rawHeight));
    const center = ((rowTop + rowHeight / 2) / contentHeight) * heightPx;
    return [{
      transcriptId: row.transcriptId,
      topPx: clamp(center - markerHeight / 2, 0, heightPx - markerHeight),
      heightPx: markerHeight,
      selected: row.transcriptId === selectedTranscriptId,
      comparison: comparison.has(row.transcriptId),
      pinned: pinned.has(row.transcriptId),
    }];
  });

  return {
    hidden,
    heightPx,
    contentHeight,
    viewportHeight,
    scrollTop,
    maximumScrollTop,
    viewportTopPx,
    viewportHeightPx,
    firstVisibleIndex,
    lastVisibleIndexExclusive,
    rowCount: layout.rows.length,
    markers,
  };
}

export function minimapScrollTopForRatio(
  ratio: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  const content = Math.max(1, finiteNonNegative(contentHeight, 1));
  const viewport = clamp(finiteNonNegative(viewportHeight, 1), 1, content);
  const maximum = Math.max(0, content - viewport);
  const targetCenter = clamp(Number.isFinite(ratio) ? ratio : 0, 0, 1) * content;
  return clamp(targetCenter - viewport / 2, 0, maximum);
}

export function minimapKeyboardScrollTop(
  key: string,
  scrollTop: number,
  contentHeight: number,
  viewportHeight: number,
): number | null {
  const content = Math.max(1, finiteNonNegative(contentHeight, 1));
  const viewport = clamp(finiteNonNegative(viewportHeight, 1), 1, content);
  const maximum = Math.max(0, content - viewport);
  const current = clamp(finiteNonNegative(scrollTop), 0, maximum);
  const smallStep = Math.max(24, viewport * 0.25);
  if (key === "ArrowUp") return clamp(current - smallStep, 0, maximum);
  if (key === "ArrowDown") return clamp(current + smallStep, 0, maximum);
  if (key === "PageUp") return clamp(current - viewport, 0, maximum);
  if (key === "PageDown") return clamp(current + viewport, 0, maximum);
  if (key === "Home") return 0;
  if (key === "End") return maximum;
  return null;
}
