import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatBaseCount, formatLocus } from "../lib/coordinates";
import type {
  BuildManifest,
  DisplayMode,
  DisplayModeSetting,
  LoadState,
  Locus,
  SearchEntityKind,
  SearchResult,
} from "../types";

interface CommandBarProps {
  manifest: BuildManifest;
  manifestState: LoadState;
  query: string;
  locus: Locus;
  displayMode: DisplayModeSetting;
  effectiveDisplayMode: DisplayMode;
  inspectorOpen: boolean;
  searchResults: SearchResult[];
  searchState: LoadState;
  searchError?: string;
  canFitTranscript: boolean;
  onQueryChange: (value: string) => void;
  onSubmit: (value: string, result?: SearchResult) => void;
  onFitGene: () => void;
  onFitTranscript: () => void;
  onZoom: (scale: number) => void;
  onDisplayModeChange: (mode: DisplayModeSetting) => void;
  onToggleInspector: () => void;
  onToggleHelp: () => void;
  workspaceMenu?: ReactNode;
}

const KIND_LABELS: Record<SearchEntityKind, string> = {
  gene: "Genes",
  transcript: "Transcripts",
  protein: "Proteins",
  exon: "Exons",
  coordinate: "Coordinates",
};

function resultDetail(result: SearchResult): string {
  const locus = formatLocus({ chrom: result.chrom, start0: result.start0, end0: result.end0 });
  return [result.symbol ?? result.geneSymbol, result.biotype, locus].filter(Boolean).join(" · ");
}

export function CommandBar({
  manifest,
  manifestState,
  query,
  locus,
  displayMode,
  effectiveDisplayMode,
  inspectorOpen,
  searchResults,
  searchState,
  searchError,
  canFitTranscript,
  onQueryChange,
  onSubmit,
  onFitGene,
  onFitTranscript,
  onZoom,
  onDisplayModeChange,
  onToggleInspector,
  onToggleHelp,
  workspaceMenu,
}: CommandBarProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<number | undefined>(undefined);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => setActiveIndex(-1), [searchResults]);
  useEffect(() => () => {
    if (blurTimer.current !== undefined) window.clearTimeout(blurTimer.current);
  }, []);

  function cancelPendingBlur() {
    if (blurTimer.current === undefined) return;
    window.clearTimeout(blurTimer.current);
    blurTimer.current = undefined;
  }

  function closePaletteAndBlur() {
    cancelPendingBlur();
    inputRef.current?.blur();
    setFocused(false);
    setActiveIndex(-1);
  }

  const grouped = useMemo(() => {
    const groups = new Map<SearchEntityKind, SearchResult[]>();
    searchResults.forEach((result) => {
      const rows = groups.get(result.kind) ?? [];
      rows.push(result);
      groups.set(result.kind, rows);
    });
    return [...groups.entries()];
  }, [searchResults]);
  const showPalette = focused && query.trim().length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = activeIndex >= 0 ? searchResults[activeIndex] : undefined;
    onSubmit(query, selected);
    closePaletteAndBlur();
  }

  return (
    <header className="command-bar">
      <div className="brand-block" aria-label="Application identity">
        <span className="brand-mark" aria-hidden="true">TB</span>
        <span className="brand-copy">
          <strong>Transcript browser</strong>
          <small>local annotation instrument</small>
        </span>
      </div>

      <form className="search-form" role="search" onSubmit={submit}>
        <span className="search-glyph" aria-hidden="true">⌕</span>
        <input
          id="global-search-input"
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onFocus={() => {
            cancelPendingBlur();
            setFocused(true);
          }}
          onBlur={() => {
            cancelPendingBlur();
            blurTimer.current = window.setTimeout(() => {
              blurTimer.current = undefined;
              setFocused(false);
            }, 140);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closePaletteAndBlur();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setFocused(true);
              setActiveIndex((current) => Math.min(searchResults.length - 1, current + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(0, current - 1));
            } else if (event.key === "Enter" && activeIndex >= 0 && searchResults[activeIndex]) {
              event.preventDefault();
              onSubmit(query, searchResults[activeIndex]);
              closePaletteAndBlur();
            }
          }}
          role="combobox"
          aria-label="Search local gene, transcript, protein, exon, or coordinate"
          aria-controls={listId}
          aria-expanded={showPalette}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          aria-busy={searchState === "loading"}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search gene, ENST…, ENSP…, ENSE…, or chr12:53,380,176-53,416,446"
        />
        <span className={`search-activity ${searchState}`} aria-hidden="true" />
        <kbd>↵</kbd>
        {showPalette && (
          <div className="search-results" id={listId} role="listbox" aria-label="Local search results">
            {searchState === "loading" && searchResults.length === 0 && (
              <div className="search-palette-state" role="status">Searching the local annotation index…</div>
            )}
            {searchState === "error" && (
              <div className="search-palette-state error" role="alert">
                <strong>Search unavailable</strong><span>{searchError}</span>
              </div>
            )}
            {searchState === "ready" && searchResults.length === 0 && (
              <div className="search-palette-state" role="status">
                <strong>No exact or prefix match</strong><span>Try a stable Ensembl ID, gene symbol, transcript name, or complete locus.</span>
              </div>
            )}
            {grouped.map(([kind, results]) => (
              <div className="search-result-group" role="group" aria-label={KIND_LABELS[kind]} key={kind}>
                <div className="search-group-heading">{KIND_LABELS[kind]}</div>
                {results.map((result) => {
                  const index = searchResults.indexOf(result);
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={activeIndex === index}
                      id={`${listId}-${index}`}
                      key={`${result.kind}-${result.id}-${result.start0}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => {
                        onQueryChange(result.label);
                        onSubmit(result.label, result);
                        closePaletteAndBlur();
                      }}
                    >
                      <span className="result-kind">{result.kind}</span>
                      <span className="result-copy">
                        <strong>{result.label}{result.versionedId && result.versionedId !== result.label ? ` · ${result.versionedId}` : ""}</strong>
                        <small>{resultDetail(result)}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </form>

      {workspaceMenu}

      <div
        className="build-badge"
        title={manifestState === "ready" ? `${manifest.release} · build ${manifest.buildHash}` : "Verifying local build"}
      >
        <span className={`status-dot ${manifestState === "ready" ? manifest.dataSource : "pending"}`} aria-hidden="true" />
        <span>
          <strong>{manifestState === "ready" ? manifest.release : "Verifying local build"}</strong>
          <small>
            {manifestState === "ready"
              ? `${manifest.assembly} · ${manifest.technicalPreview ? "technical preview" : "verified local build"}`
              : "Release identity pending"}
          </small>
        </span>
      </div>

      <nav className="locus-controls" aria-label="Locus controls">
        <button type="button" onClick={() => history.back()} aria-label="Previous complete browser view" title="Previous view">←</button>
        <button type="button" onClick={() => history.forward()} aria-label="Next complete browser view" title="Next view">→</button>
        <span className="locus-readout" title={formatLocus(locus)}>
          <strong>{formatLocus(locus)}</strong>
          <small>{formatBaseCount(locus.end0 - locus.start0)} · {effectiveDisplayMode}</small>
        </span>
        <button type="button" onClick={() => onZoom(1.7)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" onClick={() => onZoom(0.58)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" className="text-control" onClick={onFitGene}>Fit gene</button>
        <button type="button" className="text-control" onClick={onFitTranscript} disabled={!canFitTranscript}>Fit transcript</button>
        <label className="mode-control">
          <span className="sr-only">Track content</span>
          <select
            value={displayMode}
            onChange={(event) => onDisplayModeChange(event.target.value as DisplayModeSetting)}
            aria-label="Track content"
          >
            <option value="auto">Automatic by zoom</option>
            <option value="overview">Gene overview</option>
            <option value="compact">Transcript spans</option>
            <option value="labeled">Exon structures</option>
            <option value="expanded">Protein features</option>
          </select>
        </label>
        <button
          type="button"
          className="text-control inspector-toggle"
          onClick={onToggleInspector}
          aria-pressed={inspectorOpen}
        >
          {inspectorOpen ? "Hide details" : "Show details"}
        </button>
        <button type="button" onClick={onToggleHelp} aria-label="Open keyboard and gesture help" title="Keyboard and gesture help">?</button>
      </nav>
    </header>
  );
}
