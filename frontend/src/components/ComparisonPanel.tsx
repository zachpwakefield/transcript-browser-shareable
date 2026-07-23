import { useId, useMemo, useState } from "react";
import {
  buildTranscriptComparison,
  type ComparisonCell,
} from "../lib/comparison";
import {
  MAX_COMPARISON_EXPORT_TRANSCRIPTS,
  type ComparisonExportFormat,
} from "../lib/comparisonExport";
import type { TranscriptOrderPlacement } from "../lib/transcriptOrder";
import type { FeatureSource, Transcript } from "../types";

export interface ComparisonPanelProps {
  selectedTranscript: Transcript;
  comparisonTranscript?: Transcript;
  activeSources: readonly FeatureSource[];
  comparisonPinned: boolean;
  pinnedTranscriptCount?: number;
  onSetComparison: () => void;
  onSwap: () => void;
  onClearComparison: () => void;
  onToggleComparisonPin: () => void;
  onPlaceComparison: (placement: TranscriptOrderPlacement) => void;
  onExportComparison: (format: ComparisonExportFormat, includePinned: boolean) => void;
  ariaLabel?: string;
}

function ComparisonValue({ cell }: { cell: ComparisonCell }) {
  return (
    <span className={`comparison-value comparison-value-${cell.state}`} data-state={cell.state}>
      {cell.state === "zero" && <span className="sr-only">Zero value: </span>}
      {cell.display}
    </span>
  );
}

function TagList({ values }: { values: readonly string[] }) {
  if (!values.length) return <span className="comparison-empty-value">None</span>;
  return (
    <ul>
      {values.map((value) => <li key={value}>{value}</li>)}
    </ul>
  );
}

/**
 * Callback-only transcript comparison UI. Scientific comparison values come
 * from the pure comparison model; this component never mutates transcript,
 * ordering, pin, download, or browser-scroll state.
 */
export function ComparisonPanel({
  selectedTranscript,
  comparisonTranscript,
  activeSources,
  comparisonPinned,
  pinnedTranscriptCount,
  onSetComparison,
  onSwap,
  onClearComparison,
  onToggleComparisonPin,
  onPlaceComparison,
  onExportComparison,
  ariaLabel = "Transcript comparison",
}: ComparisonPanelProps) {
  const headingId = useId();
  const exportLegendId = useId();
  const [includePinned, setIncludePinned] = useState(false);
  const comparison = useMemo(
    () => comparisonTranscript
      ? buildTranscriptComparison(selectedTranscript, comparisonTranscript, activeSources)
      : undefined,
    [activeSources, comparisonTranscript, selectedTranscript],
  );
  const pinnedAvailable = pinnedTranscriptCount === undefined || pinnedTranscriptCount > 0;
  const includePinnedForExport = pinnedAvailable && includePinned;

  if (!comparisonTranscript || !comparison) {
    return (
      <section className="comparison-panel comparison-panel-empty" aria-label={ariaLabel}>
        <header>
          <span className="eyebrow">Compare</span>
          <h3 id={headingId}>Choose a comparison transcript</h3>
        </header>
        <div className="comparison-empty-state" role="status" aria-labelledby={headingId}>
          <p>
            <strong>{selectedTranscript.name}</strong> is selected. Choose a different transcript from this gene
            to compare structure, support, tags, and loaded feature counts.
          </p>
          <button type="button" onClick={onSetComparison}>Choose comparison transcript</button>
        </div>
      </section>
    );
  }

  return (
    <section
      className="comparison-panel"
      aria-label={ariaLabel}
      data-selected-transcript-id={selectedTranscript.id}
      data-comparison-transcript-id={comparisonTranscript.id}
    >
      <header className="comparison-panel-header">
        <div>
          <span className="eyebrow">Compare</span>
          <h3 id={headingId}>{selectedTranscript.name} and {comparisonTranscript.name}</h3>
          <p>Selected versus comparison transcript. “Different” labels identify unequal values without relying on color.</p>
        </div>
        <div className="comparison-primary-actions" role="group" aria-label="Comparison transcript actions">
          <button type="button" onClick={onSwap}>Swap selected and comparison</button>
          <button
            type="button"
            aria-pressed={comparisonPinned}
            onClick={onToggleComparisonPin}
          >
            {comparisonPinned ? "Unpin comparison" : "Pin comparison"}
          </button>
          <button type="button" onClick={onClearComparison}>Clear comparison</button>
        </div>
      </header>

      <div className="comparison-order-actions" role="group" aria-label="Place comparison beside selected transcript">
        <button type="button" onClick={() => onPlaceComparison("before")}>
          Place comparison directly above selected
        </button>
        <button type="button" onClick={() => onPlaceComparison("after")}>
          Place comparison directly below selected
        </button>
      </div>

      <div className="comparison-table-scroll">
        <table className="comparison-table">
          <caption className="sr-only">
            Transcript comparison between selected {selectedTranscript.versionedId} and comparison {comparisonTranscript.versionedId}
          </caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">
                <span>Selected</span>
                <strong>{selectedTranscript.name}</strong>
                <small>{selectedTranscript.versionedId}</small>
              </th>
              <th scope="col">
                <span>Comparison</span>
                <strong>{comparisonTranscript.name}</strong>
                <small>{comparisonTranscript.versionedId}</small>
              </th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((metric) => (
              <tr
                className={metric.different ? "comparison-row-different" : undefined}
                data-different={metric.different ? "true" : "false"}
                key={metric.key}
              >
                <th scope="row">
                  <span>{metric.label}</span>
                  {metric.different && <small className="comparison-difference-label">Different</small>}
                </th>
                <td><ComparisonValue cell={metric.selected} /></td>
                <td><ComparisonValue cell={metric.comparison} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="comparison-tags" aria-label="Shared and unique transcript tags">
        <h4>Scientific annotation tags</h4>
        <div className="comparison-tag-groups">
          <section aria-label="Shared tags">
            <h5>Shared</h5>
            <TagList values={comparison.tags.shared} />
          </section>
          <section aria-label={`Tags unique to selected ${selectedTranscript.name}`}>
            <h5>Selected only</h5>
            <TagList values={comparison.tags.selectedOnly} />
          </section>
          <section aria-label={`Tags unique to comparison ${comparisonTranscript.name}`}>
            <h5>Comparison only</h5>
            <TagList values={comparison.tags.comparisonOnly} />
          </section>
        </div>
      </section>

      <fieldset className="comparison-export" aria-labelledby={exportLegendId}>
        <legend id={exportLegendId}>Comparison export</legend>
        <label>
          <input
            type="checkbox"
            checked={includePinnedForExport}
            disabled={!pinnedAvailable}
            onChange={(event) => setIncludePinned(event.currentTarget.checked)}
          />
          <span>
            Include pinned transcripts
            {pinnedTranscriptCount === undefined ? "" : ` (${pinnedTranscriptCount})`}
          </span>
        </label>
        <div role="group" aria-label="Export transcript comparison">
          <button type="button" onClick={() => onExportComparison("csv", includePinnedForExport)}>
            Export CSV
          </button>
          <button type="button" onClick={() => onExportComparison("tsv", includePinnedForExport)}>
            Export TSV
          </button>
        </div>
        <small>
          Exports selected and comparison transcripts in current visual order, with an explicit maximum of {MAX_COMPARISON_EXPORT_TRANSCRIPTS} transcripts.
        </small>
      </fieldset>
    </section>
  );
}

export default ComparisonPanel;
