import { intervalOverlapsLocus } from "../lib/navigation";
import type { TranscriptOrderAction } from "../lib/transcriptOrder";
import { SOURCE_META, type DisplayMode, type FeatureSource, type Gene, type Locus, type RowDensity, type Transcript } from "../types";
import type { BrowserRowLayout } from "../lib/layout";
import { TranscriptOrderMenu } from "./TranscriptOrderMenu";

interface TranscriptLabelsProps {
  gene: Gene;
  transcripts: Transcript[];
  layout: BrowserRowLayout;
  displayMode: DisplayMode;
  selectedTranscriptId: string;
  comparisonTranscriptId: string;
  selectedTranscriptName: string;
  expandedTranscriptIds: string[];
  pinnedTranscriptIds: string[];
  reorderableTranscriptIds: string[];
  customOrderActive: boolean;
  reorderFocusTranscriptId?: string;
  activeSources: FeatureSource[];
  rowDensity: RowDensity;
  locus: Locus;
  onSelectTranscript: (transcriptId: string) => void;
  onToggleExpanded: (transcriptId: string) => void;
  onTogglePinned: (transcriptId: string) => void;
  onSetComparison: (transcriptId: string) => void;
  onReorderTranscript: (transcriptId: string, action: TranscriptOrderAction) => void;
  onReorderFocusHandled: (transcriptId: string) => void;
}

export function TranscriptLabels({
  gene,
  transcripts,
  layout,
  displayMode,
  selectedTranscriptId,
  comparisonTranscriptId,
  selectedTranscriptName,
  expandedTranscriptIds,
  pinnedTranscriptIds,
  reorderableTranscriptIds,
  customOrderActive,
  reorderFocusTranscriptId,
  activeSources,
  rowDensity,
  locus,
  onSelectTranscript,
  onToggleExpanded,
  onTogglePinned,
  onSetComparison,
  onReorderTranscript,
  onReorderFocusHandled,
}: TranscriptLabelsProps) {
  const rowById = new Map(layout.rows.map((row) => [row.transcriptId, row]));
  const reorderPositionById = new Map(reorderableTranscriptIds.map((id, index) => [id, index]));
  return (
    <section
      className={`transcript-label-rail mode-${displayMode} density-${rowDensity}`}
      style={{ height: layout.totalHeight }}
      aria-label={`${gene.symbol} transcript labels`}
    >
      <div className="gene-label" style={{ height: layout.geneHeaderHeight }}>
        <span className="gene-symbol">{gene.symbol}</span>
        <span className="gene-meta">
          <strong>{gene.versionedId}</strong>
          <small>{gene.biotype} · {gene.strand} strand{customOrderActive ? " · custom visual order" : ""}</small>
        </span>
        <span className="gene-count">{gene.transcripts.length} isoforms</span>
      </div>

      {displayMode === "overview" && transcripts.length === 0 && (
        <div className="overview-label-note">
          <strong>Gene overview</strong>
          <span>Switch to Labeled or Expanded to inspect isoforms.</span>
        </div>
      )}

      <div className="transcript-window-list" role="list" aria-label={`${gene.symbol} visible transcript rows`}>
      {transcripts.map((transcript) => {
        const row = rowById.get(transcript.id);
        if (!row) return null;
        const selected = transcript.id === selectedTranscriptId;
        const comparison = transcript.id === comparisonTranscriptId;
        const reorderIndex = reorderPositionById.get(transcript.id) ?? 0;
        const expanded = expandedTranscriptIds.includes(transcript.id) && displayMode === "expanded";
        const pinned = pinnedTranscriptIds.includes(transcript.id);
        const offscreen = !intervalOverlapsLocus(gene.chrom, transcript.start0, transcript.end0, locus);
        const visibleFeatures = transcript.features.filter((feature) => activeSources.includes(feature.source));
        const sourceCounts = new Map<FeatureSource, number>();
        visibleFeatures.forEach((feature) => {
          sourceCounts.set(feature.source, (sourceCounts.get(feature.source) ?? 0) + 1);
        });
        const railBadges = transcript.badges.length > 3
          ? [...transcript.badges.slice(0, 2), `+${transcript.badges.length - 2}`]
          : transcript.badges;
        return (
          <div
            key={transcript.id}
            className={`transcript-label-row ${selected ? "selected" : ""} ${comparison ? "comparison" : ""} ${expanded ? "expanded" : ""} ${offscreen ? "offscreen" : ""}`}
            style={{ top: row.y, height: row.height }}
            role="listitem"
            aria-posinset={layout.rows.findIndex((item) => item.transcriptId === transcript.id) + 1}
            aria-setsize={layout.rows.length}
          >
            <div className="transcript-label-main">
              <button
                className="disclosure-button"
                type="button"
                onClick={() => onToggleExpanded(transcript.id)}
                aria-label={`${expanded ? "Collapse" : "Expand"} ${transcript.name} protein annotations`}
                aria-expanded={expanded}
                disabled={transcript.proteinLength <= 0}
                title={transcript.proteinLength <= 0 ? "No translated product" : undefined}
              >
                <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
              </button>
              <button
                className="transcript-select-button"
                type="button"
                onClick={() => onSelectTranscript(transcript.id)}
                aria-pressed={selected}
              >
                <span className="transcript-name-row">
                  <strong>{transcript.name}</strong>
                  <span>{transcript.proteinLength > 0 ? `${transcript.proteinLength} aa` : "No translated product"}</span>
                </span>
                <span className="transcript-id">{transcript.versionedId}</span>
                <span className="badge-row" aria-label={transcript.badges.join(", ")}>
                  {railBadges.map((badge) => (
                    <span className={badge.startsWith("+") ? "overflow-badge" : "mini-badge"} key={badge}>{badge}</span>
                  ))}
                </span>
              </button>
              <button
                type="button"
                className="compare-button"
                aria-pressed={comparison}
                aria-label={`${comparison ? "Clear" : "Compare selected transcript with"} ${transcript.name}`}
                title={comparison ? "Clear comparison" : `Compare with ${transcript.name}`}
                onClick={() => onSetComparison(transcript.id)}
                disabled={selected}
              >
                <span aria-hidden="true">{comparison ? "⇆" : "⇄"}</span>
              </button>
              <button
                type="button"
                className="pin-button"
                aria-pressed={pinned}
                aria-label={`${pinned ? "Unpin" : "Pin"} ${transcript.name} expansion`}
                title={`${pinned ? "Unpin" : "Pin"} expansion`}
                onClick={() => onTogglePinned(transcript.id)}
                disabled={transcript.proteinLength <= 0}
              >
                <span aria-hidden="true">{pinned ? "◆" : "◇"}</span>
              </button>
              {displayMode !== "overview" && (
                <TranscriptOrderMenu
                  transcriptName={transcript.name}
                  position={reorderIndex + 1}
                  total={reorderableTranscriptIds.length}
                  selectedTranscriptName={selectedTranscriptName}
                  selected={selected}
                  canMoveUp={reorderIndex > 0}
                  canMoveDown={reorderIndex < reorderableTranscriptIds.length - 1}
                  focusRequested={reorderFocusTranscriptId === transcript.id}
                  onAction={(action) => onReorderTranscript(transcript.id, action)}
                  onFocusHandled={() => onReorderFocusHandled(transcript.id)}
                />
              )}
            </div>

            {offscreen && <span className="offscreen-tag">outside current view</span>}

            {expanded && (
              <div className="label-expansion">
                {transcript.featuresState === "loading" ? (
                  <div className="feature-loading-label" role="status">Loading local protein annotations…</div>
                ) : transcript.featuresState === "error" ? (
                  <div className="empty-feature-label error" role="alert">
                    <span className="empty-mark" aria-hidden="true">!</span>
                    <span><strong>Feature annotations could not be loaded</strong><small>The transcript model remains available. Collapse and reopen to retry.</small></span>
                  </div>
                ) : visibleFeatures.length === 0 ? (
                  <div className="empty-feature-label" role="status">
                    <span className="empty-mark" aria-hidden="true">∅</span>
                    <span>
                      <strong>No features in the selected local sources</strong>
                      <small>The {transcript.proteinLength}-aa translated product remains available.</small>
                    </span>
                  </div>
                ) : (
                  <>
                    <span className="axis-caption">Genome projection</span>
                    <div className="label-source-list">
                      {[...sourceCounts].map(([source, count]) => {
                        const meta = SOURCE_META[source];
                        return (
                          <span key={source}>
                            <i style={{ backgroundColor: meta.color }} aria-hidden="true" />
                            {meta.shortLabel} <small>{count}</small>
                          </span>
                        );
                      })}
                    </div>
                    <span className="axis-caption protein-caption">Independent N→C protein axis</span>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </section>
  );
}
