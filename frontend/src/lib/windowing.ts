export const TRACK_OVERSCAN_PX = 264;
export const MAX_TRACK_WINDOW_CSS_HEIGHT = 4_096;
export const FIXED_ROW_OVERSCAN = 6;
export const MAX_CANVAS_BITMAP_PIXELS = 16_000_000;
export const MAX_CANVAS_BITMAP_DIMENSION = 16_384;

export interface PositionedRow {
  y: number;
  height: number;
}

export interface VariableRowWindow {
  start0: number;
  end0: number;
  height: number;
  firstIndex: number;
  lastIndexExclusive: number;
}

export interface FixedRowWindow {
  firstIndex: number;
  lastIndexExclusive: number;
  paddingTop: number;
  paddingBottom: number;
}

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/**
 * Return the variable-height rows intersecting one bounded viewport window.
 * The window always covers the visible viewport and adds modest overscan, but
 * never expands to the full dense-gene layout merely because it has many rows.
 */
export function variableRowWindow(
  rows: readonly PositionedRow[],
  totalHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscanPx = TRACK_OVERSCAN_PX,
  maximumWindowHeight = MAX_TRACK_WINDOW_CSS_HEIGHT,
): VariableRowWindow {
  const total = finiteNonNegative(totalHeight);
  if (total === 0) {
    return { start0: 0, end0: 1, height: 1, firstIndex: 0, lastIndexExclusive: 0 };
  }

  const viewport = Math.min(total, Math.max(1, finiteNonNegative(viewportHeight, 1)));
  const top = Math.min(Math.max(0, finiteNonNegative(scrollTop)), Math.max(0, total - viewport));
  const overscan = finiteNonNegative(overscanPx);
  // A viewport taller than the ordinary cap still has to remain completely
  // covered. In normal laptop/desktop layouts the explicit cap is the bound.
  const cap = Math.max(viewport, Math.max(1, finiteNonNegative(maximumWindowHeight, 1)));
  let start0 = Math.max(0, top - overscan);
  let end0 = Math.min(total, top + viewport + overscan);

  if (end0 - start0 > cap) {
    const spare = Math.max(0, cap - viewport);
    start0 = Math.max(0, top - Math.min(overscan, spare / 2));
    end0 = Math.min(total, start0 + cap);
    if (end0 < top + viewport) {
      end0 = Math.min(total, top + viewport);
      start0 = Math.max(0, end0 - cap);
    }
  }

  let firstIndex = 0;
  while (firstIndex < rows.length && rows[firstIndex].y + rows[firstIndex].height <= start0) {
    firstIndex += 1;
  }
  let lastIndexExclusive = firstIndex;
  while (lastIndexExclusive < rows.length && rows[lastIndexExclusive].y < end0) {
    lastIndexExclusive += 1;
  }

  return {
    start0,
    end0,
    height: Math.max(1, end0 - start0),
    firstIndex,
    lastIndexExclusive,
  };
}

/** Fixed-height row window used by the inspector table and sequence viewer. */
export function fixedRowWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscanRows = FIXED_ROW_OVERSCAN,
): FixedRowWindow {
  const count = Math.max(0, Math.floor(finiteNonNegative(rowCount)));
  const height = Math.max(1, finiteNonNegative(rowHeight, 1));
  if (count === 0) {
    return { firstIndex: 0, lastIndexExclusive: 0, paddingTop: 0, paddingBottom: 0 };
  }
  const overscan = Math.max(0, Math.floor(finiteNonNegative(overscanRows)));
  const top = finiteNonNegative(scrollTop);
  const viewport = Math.max(1, finiteNonNegative(viewportHeight, 1));
  const firstVisible = Math.min(count - 1, Math.floor(top / height));
  const lastVisibleExclusive = Math.min(count, Math.ceil((top + viewport) / height));
  const firstIndex = Math.max(0, firstVisible - overscan);
  const lastIndexExclusive = Math.min(count, lastVisibleExclusive + overscan);
  return {
    firstIndex,
    lastIndexExclusive,
    paddingTop: firstIndex * height,
    paddingBottom: (count - lastIndexExclusive) * height,
  };
}

/**
 * Bound a Canvas bitmap by both dimensions and pixel area. Typical DPR2
 * viewports retain DPR2; unusually large displays reduce only backing scale.
 */
export function boundedCanvasBitmapSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
) {
  const width = Math.max(1, finiteNonNegative(cssWidth, 1));
  const height = Math.max(1, finiteNonNegative(cssHeight, 1));
  const requested = Math.max(1, Math.min(2, finiteNonNegative(devicePixelRatio, 1) || 1));
  const scaleByArea = Math.sqrt(MAX_CANVAS_BITMAP_PIXELS / (width * height));
  const scaleByDimension = Math.min(
    MAX_CANVAS_BITMAP_DIMENSION / width,
    MAX_CANVAS_BITMAP_DIMENSION / height,
  );
  const requestedScale = Math.max(Number.EPSILON, Math.min(requested, scaleByArea, scaleByDimension));
  const initialWidth = Math.max(1, Math.floor(width * requestedScale));
  const initialHeight = Math.max(1, Math.floor(height * requestedScale));
  const dpr = Math.min(initialWidth / width, initialHeight / height);
  return {
    width: Math.max(1, Math.floor(width * dpr)),
    height: Math.max(1, Math.floor(height * dpr)),
    dpr,
  };
}

/** Build a stable, de-duplicated request set without coupling it to all rows. */
export function transcriptDemandIds(
  windowedTranscriptIds: readonly string[],
  selectedTranscriptId: string,
  pinnedTranscriptIds: readonly string[],
  expandedTranscriptIds: readonly string[],
  comparisonTranscriptId = "",
): string[] {
  return [
    ...windowedTranscriptIds,
    selectedTranscriptId,
    comparisonTranscriptId,
    ...pinnedTranscriptIds,
    ...expandedTranscriptIds,
  ].filter((id, index, values) => Boolean(id) && values.indexOf(id) === index);
}
