import { transcriptFlags } from "../lib/filters";
import {
  FEATURE_CLASSES,
  FEATURE_CLASS_BY_SOURCE,
  FEATURE_CLASS_META,
  FEATURE_SOURCES,
  SOURCE_META,
  TRANSCRIPT_FLAGS,
  TRANSCRIPT_FLAG_META,
  type BuildManifest,
  type FeatureClass,
  type FeatureSource,
  type Gene,
  type RowDensity,
  type TranscriptFlag,
} from "../types";

interface FilterBarProps {
  gene: Gene;
  manifest: BuildManifest;
  activeSources: FeatureSource[];
  activeFeatureClasses: FeatureClass[];
  excludedTranscriptBiotypes: string[];
  activeTranscriptFlags: TranscriptFlag[];
  selectedTranscriptId: string;
  comparisonTranscriptId: string;
  pinnedTranscriptIds: string[];
  visibleTranscriptCount: number;
  transcriptOrderActive: boolean;
  rowDensity: RowDensity;
  canvasKeyboardShortcuts: boolean;
  restoreLastView: boolean;
  onToggleSource: (source: FeatureSource) => void;
  onToggleFeatureClass: (featureClass: FeatureClass) => void;
  onToggleTranscriptBiotype: (biotype: string) => void;
  onToggleTranscriptFlag: (flag: TranscriptFlag) => void;
  onResetTranscriptOrder: () => void;
  onRowDensityChange: (density: RowDensity) => void;
  onCanvasKeyboardShortcutsChange: (enabled: boolean) => void;
  onRestoreLastViewChange: (enabled: boolean) => void;
  onClearSavedWorkspace: () => void;
}

function FilterOption({
  checked,
  label,
  count,
  description,
  onChange,
}: {
  checked: boolean;
  label: string;
  count: number;
  description: string;
  onChange: () => void;
}) {
  return (
    <label className="filter-option" title={description}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
      <small>{count}</small>
    </label>
  );
}

export function FilterBar({
  gene,
  manifest,
  activeSources,
  activeFeatureClasses,
  excludedTranscriptBiotypes,
  activeTranscriptFlags,
  selectedTranscriptId,
  comparisonTranscriptId,
  pinnedTranscriptIds,
  visibleTranscriptCount,
  transcriptOrderActive,
  rowDensity,
  canvasKeyboardShortcuts,
  restoreLastView,
  onToggleSource,
  onToggleFeatureClass,
  onToggleTranscriptBiotype,
  onToggleTranscriptFlag,
  onResetTranscriptOrder,
  onRowDensityChange,
  onCanvasKeyboardShortcutsChange,
  onRestoreLastViewChange,
  onClearSavedWorkspace,
}: FilterBarProps) {
  const sourceCounts = new Map<FeatureSource, number>(FEATURE_SOURCES.map((source) => [source, 0]));
  const classCounts = new Map<FeatureClass, number>(FEATURE_CLASSES.map((featureClass) => [featureClass, 0]));
  const biotypeCounts = new Map<string, number>();
  const flagCounts = new Map<TranscriptFlag, number>(TRANSCRIPT_FLAGS.map((flag) => [flag, 0]));
  const eligibleTranscripts = gene.transcripts.filter((transcript) => transcript.proteinLength > 0);
  const loadedTranscripts = gene.transcripts.filter((transcript) => transcript.featuresState === "ready");

  gene.transcripts.forEach((transcript) => {
    biotypeCounts.set(transcript.biotype, (biotypeCounts.get(transcript.biotype) ?? 0) + 1);
    transcriptFlags(transcript).forEach((flag) => {
      flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
    });
    transcript.features.forEach((feature) => {
      sourceCounts.set(feature.source, (sourceCounts.get(feature.source) ?? 0) + 1);
      const featureClass = FEATURE_CLASS_BY_SOURCE[feature.source];
      if (featureClass) classCounts.set(featureClass, (classCounts.get(featureClass) ?? 0) + 1);
    });
  });

  const biotypes = [...new Set([...biotypeCounts.keys(), ...excludedTranscriptBiotypes])].sort();
  const retainedContextCount = gene.transcripts.filter((transcript) => (
    (transcript.id === selectedTranscriptId || transcript.id === comparisonTranscriptId || pinnedTranscriptIds.includes(transcript.id))
    && (
      excludedTranscriptBiotypes.includes(transcript.biotype)
      || (activeTranscriptFlags.length > 0
        && !activeTranscriptFlags.some((flag) => transcriptFlags(transcript).has(flag)))
    )
  )).length;
  const transcriptFilterActive = excludedTranscriptBiotypes.length > 0 || activeTranscriptFlags.length > 0;

  return (
    <div className="filter-strip" aria-label="Browser filters and view settings">
      <div className="filter-intro">
        <span className="eyebrow">Filters</span>
        <strong>
          {loadedTranscripts.reduce((sum, transcript) => sum + transcript.features.length, 0)} feature records
          {loadedTranscripts.length < eligibleTranscripts.length ? " · lazy" : ""}
        </strong>
      </div>

      <fieldset className="source-filters">
        <legend>Sources</legend>
        <div className="source-chip-row">
          {FEATURE_SOURCES.map((source) => {
            const meta = SOURCE_META[source];
            const count = sourceCounts.get(source) ?? 0;
            const checked = activeSources.includes(source);
            return (
              <label
                key={source}
                className={`source-chip ${checked ? "active" : ""} ${count === 0 ? "empty" : ""}`}
                title={`${meta.description}; ${count} loaded record${count === 1 ? "" : "s"} at ${gene.symbol}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleSource(source)}
                  aria-label={`${checked ? "Hide" : "Show"} ${meta.label}, ${count} loaded records`}
                />
                <span className="source-swatch" style={{ backgroundColor: meta.color }} aria-hidden="true" />
                <span>{meta.label}</span>
                <small>{count}</small>
              </label>
            );
          })}
        </div>
      </fieldset>

      <details className="filter-menu">
        <summary>
          Prediction class
          <small>{activeFeatureClasses.length}/{FEATURE_CLASSES.length}</small>
        </summary>
        <div className="filter-menu-panel class-filter-panel">
          <strong>Typed prediction classes</strong>
          <p>Derived only from the four single-purpose sources below. InterPro, Pfam, and CDD remain source annotations.</p>
          {FEATURE_CLASSES.map((featureClass) => (
            <FilterOption
              key={featureClass}
              checked={activeFeatureClasses.includes(featureClass)}
              label={FEATURE_CLASS_META[featureClass].label}
              count={classCounts.get(featureClass) ?? 0}
              description={FEATURE_CLASS_META[featureClass].description}
              onChange={() => onToggleFeatureClass(featureClass)}
            />
          ))}
        </div>
      </details>

      <details className="filter-menu">
        <summary className={transcriptFilterActive ? "filtered" : ""}>
          Transcripts
          <small>{visibleTranscriptCount}/{gene.transcripts.length}</small>
        </summary>
        <div className="filter-menu-panel transcript-filter-panel">
          <fieldset>
            <legend>Biotype</legend>
            {biotypes.map((biotype) => (
              <FilterOption
                key={biotype}
                checked={!excludedTranscriptBiotypes.includes(biotype)}
                label={biotype.replaceAll("_", " ")}
                count={biotypeCounts.get(biotype) ?? 0}
                description={`Show ${biotype} transcripts`}
                onChange={() => onToggleTranscriptBiotype(biotype)}
              />
            ))}
          </fieldset>
          <fieldset>
            <legend>Match any annotation flag</legend>
            {TRANSCRIPT_FLAGS.map((flag) => (
              <FilterOption
                key={flag}
                checked={activeTranscriptFlags.includes(flag)}
                label={TRANSCRIPT_FLAG_META[flag].label}
                count={flagCounts.get(flag) ?? 0}
                description={TRANSCRIPT_FLAG_META[flag].description}
                onChange={() => onToggleTranscriptFlag(flag)}
              />
            ))}
            <small className="filter-help">No selected flags means any flag state.</small>
          </fieldset>
          <p className="context-retention-note">
            Selected, comparison, and pinned transcripts always remain visible
            {retainedContextCount ? ` · ${retainedContextCount} retained by context` : ""}.
          </p>
        </div>
      </details>

      <details className="filter-menu order-menu">
        <summary className={transcriptOrderActive ? "filtered" : ""}>
          Order
          <small>{transcriptOrderActive ? "Custom" : "Default"}</small>
        </summary>
        <div className="filter-menu-panel order-filter-panel">
          <strong>Visual transcript order</strong>
          <p>Select one transcript as the comparison anchor, then use <b>↕</b> on another row to place it directly above or below the selection.</p>
          <p>Ordering changes only this view; biological records, filters, features, and genomic coordinates are unchanged.</p>
          <button type="button" disabled={!transcriptOrderActive} onClick={onResetTranscriptOrder}>
            Restore original transcript order
          </button>
        </div>
      </details>

      <details className="filter-menu view-menu">
        <summary>
          View
          <small>{rowDensity === "compact" ? "Compact" : "Comfort"}</small>
        </summary>
        <div className="filter-menu-panel view-filter-panel">
          <fieldset>
            <legend>Row density</legend>
            <label className="filter-option radio-option">
              <input
                type="radio"
                name="row-density"
                checked={rowDensity === "compact"}
                onChange={() => onRowDensityChange("compact")}
              />
              <span>Compact</span>
            </label>
            <label className="filter-option radio-option">
              <input
                type="radio"
                name="row-density"
                checked={rowDensity === "comfortable"}
                onChange={() => onRowDensityChange("comfortable")}
              />
              <span>Comfortable</span>
            </label>
          </fieldset>
          <label className="shortcut-setting">
            <input
              type="checkbox"
              checked={canvasKeyboardShortcuts}
              onChange={(event) => onCanvasKeyboardShortcutsChange(event.currentTarget.checked)}
            />
            <span>
              <strong>Canvas keyboard shortcuts</strong>
              <small>Arrow keys pan; plus/minus zoom. Pointer controls remain available.</small>
            </span>
          </label>
          <label className="shortcut-setting">
            <input
              type="checkbox"
              checked={restoreLastView}
              onChange={(event) => onRestoreLastViewChange(event.currentTarget.checked)}
            />
            <span>
              <strong>Restore last view</strong>
              <small>Only on an empty URL; explicit deep links always take priority.</small>
            </span>
          </label>
          <button type="button" className="clear-workspace-button" onClick={onClearSavedWorkspace}>
            Clear saved workspace
          </button>
        </div>
      </details>

      <div className="fallback-notice" role="status">
        <span aria-hidden="true">◇</span>
        {manifest.referenceAvailable
          ? "Custom Canvas · verified local reference"
          : "Technical fixture · reference unavailable"}
      </div>
    </div>
  );
}
