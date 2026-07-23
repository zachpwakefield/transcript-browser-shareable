import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  buildTranscriptMinimapGeometry,
  minimapKeyboardScrollTop,
  minimapScrollTopForRatio,
  type TranscriptMinimapViewport,
} from "../lib/transcriptMinimap";
import type { BrowserRowLayout } from "../lib/layout";

export interface TranscriptMinimapProps {
  layout: BrowserRowLayout;
  viewport: TranscriptMinimapViewport;
  selectedTranscriptId: string;
  comparisonTranscriptIds?: readonly string[];
  pinnedTranscriptIds?: readonly string[];
  height?: number;
  controlsId?: string;
  onNavigate: (scrollTop: number) => void;
  ariaLabel?: string;
}

/**
 * Stateless overview of the current transcript-row layout. Navigation is
 * callback-only; this component never mutates a scroll container or page.
 */
export function TranscriptMinimap({
  layout,
  viewport,
  selectedTranscriptId,
  comparisonTranscriptIds = [],
  pinnedTranscriptIds = [],
  height,
  controlsId,
  onNavigate,
  ariaLabel = "Transcript row minimap",
}: TranscriptMinimapProps) {
  const geometry = buildTranscriptMinimapGeometry(
    layout,
    viewport,
    selectedTranscriptId,
    comparisonTranscriptIds,
    pinnedTranscriptIds,
    height,
  );
  if (geometry.hidden) return null;

  const visibleStart = Math.min(geometry.rowCount, geometry.firstVisibleIndex + 1);
  const visibleEnd = Math.max(visibleStart, geometry.lastVisibleIndexExclusive);
  const valueText = `Transcript viewport, rows ${visibleStart} through ${visibleEnd} of ${geometry.rowCount}`;
  const selectedMarkers = geometry.markers.filter((marker) => marker.selected).length;
  const comparisonMarkers = geometry.markers.filter((marker) => marker.comparison).length;
  const pinnedMarkers = geometry.markers.filter((marker) => marker.pinned).length;

  function navigateFromClick(event: ReactMouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = bounds.height > 0 ? (event.clientY - bounds.top) / bounds.height : 0;
    onNavigate(minimapScrollTopForRatio(
      ratio,
      geometry.contentHeight,
      geometry.viewportHeight,
    ));
  }

  function navigateFromPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = bounds.height > 0 ? (event.clientY - bounds.top) / bounds.height : 0;
    onNavigate(minimapScrollTopForRatio(ratio, geometry.contentHeight, geometry.viewportHeight));
  }

  function navigateFromKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const next = minimapKeyboardScrollTop(
      event.key,
      geometry.scrollTop,
      geometry.contentHeight,
      geometry.viewportHeight,
    );
    if (next === null) return;
    event.preventDefault();
    onNavigate(next);
  }

  return (
    <div
      className="transcript-minimap"
      role="scrollbar"
      aria-label={ariaLabel}
      aria-controls={controlsId}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={Math.round(geometry.maximumScrollTop)}
      aria-valuenow={Math.round(geometry.scrollTop)}
      aria-valuetext={valueText}
      tabIndex={0}
      style={{ height: geometry.heightPx }}
      data-visible-row-start={visibleStart}
      data-visible-row-end={visibleEnd}
      data-row-count={geometry.rowCount}
      data-selected-marker-count={selectedMarkers}
      data-comparison-marker-count={comparisonMarkers}
      data-pinned-marker-count={pinnedMarkers}
      onClick={navigateFromClick}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        navigateFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) navigateFromPointer(event);
      }}
      onKeyDown={navigateFromKeyboard}
    >
      <span className="transcript-minimap-track" aria-hidden="true" />
      <span
        className="transcript-minimap-viewport"
        aria-hidden="true"
        style={{ top: geometry.viewportTopPx, height: geometry.viewportHeightPx }}
      />
      {geometry.markers.map((marker) => (
        <span
          className={[
            "transcript-minimap-marker",
            marker.selected ? "selected" : "",
            marker.comparison ? "comparison" : "",
            marker.pinned ? "pinned" : "",
          ].filter(Boolean).join(" ")}
          aria-hidden="true"
          data-transcript-id={marker.transcriptId}
          data-selected={marker.selected ? "true" : "false"}
          data-comparison={marker.comparison ? "true" : "false"}
          data-pinned={marker.pinned ? "true" : "false"}
          key={marker.transcriptId}
          style={{ top: marker.topPx, height: marker.heightPx }}
        />
      ))}
      <span className="sr-only">
        {valueText}. {selectedMarkers} selected, {comparisonMarkers} comparison, and {pinnedMarkers} pinned markers.
        Use Arrow Up, Arrow Down, Page Up, Page Down, Home, or End to navigate.
      </span>
    </div>
  );
}

export default TranscriptMinimap;
