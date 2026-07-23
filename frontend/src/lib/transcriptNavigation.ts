import type { Transcript } from "../types";

export interface TranscriptNavigationState {
  matches: Transcript[];
  selectedOrderedIndex: number;
  selectedMatchIndex: number;
  previous?: Transcript;
  next?: Transcript;
}

function normalizedTokens(query: string): string[] {
  return query
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

/**
 * Search only the supplied ordered/filtered transcript set. Every token must
 * match at least one local identity field; input order is never changed.
 */
export function searchCurrentTranscripts(
  transcripts: readonly Transcript[],
  query: string,
): Transcript[] {
  const tokens = normalizedTokens(query);
  if (tokens.length === 0) return [...transcripts];
  return transcripts.filter((transcript) => {
    const fields = [
      transcript.name,
      transcript.id,
      transcript.versionedId,
      transcript.proteinId,
      transcript.versionedProteinId,
      transcript.biotype,
    ].map((value) => value.normalize("NFKC").toLocaleLowerCase());
    return tokens.every((token) => fields.some((field) => field.includes(token)));
  });
}

/** Exact position and previous/next boundaries within the current match set. */
export function currentTranscriptNavigationState(
  transcripts: readonly Transcript[],
  selectedTranscriptId: string,
  query: string,
): TranscriptNavigationState {
  const matches = searchCurrentTranscripts(transcripts, query);
  const selectedOrderedIndex = transcripts.findIndex((transcript) => transcript.id === selectedTranscriptId);
  const selectedMatchIndex = matches.findIndex((transcript) => transcript.id === selectedTranscriptId);
  return {
    matches,
    selectedOrderedIndex,
    selectedMatchIndex,
    previous: selectedMatchIndex > 0 ? matches[selectedMatchIndex - 1] : undefined,
    next: selectedMatchIndex >= 0 && selectedMatchIndex < matches.length - 1
      ? matches[selectedMatchIndex + 1]
      : undefined,
  };
}

export function transcriptNavigationStatus(
  state: TranscriptNavigationState,
  totalCount: number,
): string {
  if (state.matches.length === 0) return `No matching transcripts among ${totalCount}.`;
  if (state.selectedMatchIndex >= 0) {
    return `Transcript ${state.selectedMatchIndex + 1} of ${state.matches.length} matches; ${totalCount} current transcripts.`;
  }
  if (state.selectedOrderedIndex >= 0) {
    return `Selected transcript ${state.selectedOrderedIndex + 1} of ${totalCount} is outside the ${state.matches.length} matches.`;
  }
  return `${state.matches.length} matching transcripts among ${totalCount}; no current transcript is selected.`;
}
