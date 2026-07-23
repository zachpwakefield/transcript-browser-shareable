import { useId, useMemo } from "react";
import {
  currentTranscriptNavigationState,
  transcriptNavigationStatus,
} from "../lib/transcriptNavigation";
import type { Transcript } from "../types";

export interface TranscriptNavigatorProps {
  transcripts: readonly Transcript[];
  selectedTranscriptId: string;
  query: string;
  onQueryChange: (query: string) => void;
  onSelectTranscript: (transcriptId: string) => void;
  comparisonTranscriptId?: string;
  onSetComparison?: (transcriptId: string) => void;
  ariaLabel?: string;
}

function optionLabel(transcript: Transcript): string {
  const protein = transcript.versionedProteinId || transcript.proteinId || "no protein";
  const product = transcript.proteinLength > 0 ? `${transcript.proteinLength.toLocaleString()} aa` : "No translated product";
  return `${transcript.name} · ${transcript.versionedId} · ${protein} · ${transcript.biotype} · ${product}`;
}

/**
 * Controlled current-gene transcript navigator. It owns no browser or scroll
 * state: every query or selection change is returned through a callback.
 */
export function TranscriptNavigator({
  transcripts,
  selectedTranscriptId,
  query,
  onQueryChange,
  onSelectTranscript,
  comparisonTranscriptId = "",
  onSetComparison,
  ariaLabel = "Current gene transcript navigator",
}: TranscriptNavigatorProps) {
  const searchId = useId();
  const resultsId = useId();
  const statusId = useId();
  const state = useMemo(
    () => currentTranscriptNavigationState(transcripts, selectedTranscriptId, query),
    [query, selectedTranscriptId, transcripts],
  );
  const selectedIsMatch = state.selectedMatchIndex >= 0;
  const status = transcriptNavigationStatus(state, transcripts.length);

  return (
    <section
      className="transcript-navigator"
      aria-label={ariaLabel}
      data-match-count={state.matches.length}
      data-selected-match-position={selectedIsMatch ? state.selectedMatchIndex + 1 : 0}
      data-selected-ordered-position={state.selectedOrderedIndex >= 0 ? state.selectedOrderedIndex + 1 : 0}
    >
      <label className="transcript-navigator-search" htmlFor={searchId}>
        <span>Find current transcript</span>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-controls={resultsId}
          aria-describedby={statusId}
          autoComplete="off"
          spellCheck={false}
          placeholder="Name, ENST, ENSP, or biotype"
        />
      </label>

      <div className="transcript-navigator-stepper" role="group" aria-label="Step through matching transcripts">
        <button
          type="button"
          disabled={!state.previous}
          onClick={() => state.previous && onSelectTranscript(state.previous.id)}
          aria-label={state.previous
            ? `Previous transcript: ${state.previous.name}, ${state.previous.versionedId}`
            : "Previous transcript unavailable: at first matching transcript"}
        >
          Previous
        </button>
        <output id={statusId} aria-live="polite" aria-atomic="true">
          {status}
        </output>
        <button
          type="button"
          disabled={!state.next}
          onClick={() => state.next && onSelectTranscript(state.next.id)}
          aria-label={state.next
            ? `Next transcript: ${state.next.name}, ${state.next.versionedId}`
            : "Next transcript unavailable: at last matching transcript"}
        >
          Next
        </button>
      </div>

      <label className="transcript-navigator-results" htmlFor={resultsId}>
        <span>Matching transcripts in current visual order</span>
        <select
          id={resultsId}
          value={selectedIsMatch ? selectedTranscriptId : ""}
          disabled={state.matches.length === 0}
          onChange={(event) => {
            if (event.target.value) onSelectTranscript(event.target.value);
          }}
          aria-describedby={statusId}
        >
          {!selectedIsMatch && (
            <option value="">{state.matches.length ? "Choose a matching transcript" : "No matching transcripts"}</option>
          )}
          {state.matches.map((transcript, index) => (
            <option value={transcript.id} key={transcript.id}>
              {index + 1}. {optionLabel(transcript)}
            </option>
          ))}
        </select>
      </label>
      {onSetComparison && (
        <label className="transcript-navigator-comparison">
          <span>Comparison transcript</span>
          <select
            value={state.matches.some((transcript) => transcript.id === comparisonTranscriptId) ? comparisonTranscriptId : ""}
            onChange={(event) => { if (event.target.value) onSetComparison(event.target.value); }}
            aria-label="Set comparison transcript from current-gene navigator"
          >
            <option value="">Choose a different match</option>
            {state.matches.filter((transcript) => transcript.id !== selectedTranscriptId).map((transcript) => (
              <option value={transcript.id} key={`compare-${transcript.id}`}>
                {optionLabel(transcript)}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}

export default TranscriptNavigator;
