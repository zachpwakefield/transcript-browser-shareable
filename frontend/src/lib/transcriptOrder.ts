import type { Transcript } from "../types";

export type TranscriptOrderPlacement = "before" | "after";
export type TranscriptOrderAction = "up" | "down" | "before-selected" | "after-selected";

function uniqueKnownIds(
  canonicalIds: readonly string[],
  requestedIds: readonly string[],
): string[] {
  const known = new Set(canonicalIds);
  const seen = new Set<string>();
  return requestedIds.filter((id) => {
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function completeTranscriptOrder(
  canonicalIds: readonly string[],
  requestedIds: readonly string[],
): string[] {
  const ordered = uniqueKnownIds(canonicalIds, requestedIds);
  const included = new Set(ordered);
  return [...ordered, ...canonicalIds.filter((id) => !included.has(id))];
}

/**
 * Empty custom order means the canonical API order. A non-empty order is a
 * complete, gene-scoped permutation so copied URLs restore deterministically.
 */
export function normalizeTranscriptOrder(
  canonicalIds: readonly string[],
  requestedIds: readonly string[],
): string[] {
  if (!requestedIds.length) return [];
  const ordered = completeTranscriptOrder(canonicalIds, requestedIds);
  return ordered.every((id, index) => id === canonicalIds[index]) ? [] : ordered;
}

export function applyTranscriptOrder<T extends Pick<Transcript, "id">>(
  transcripts: readonly T[],
  requestedIds: readonly string[],
): T[] {
  if (!requestedIds.length) return [...transcripts];
  const byId = new Map(transcripts.map((transcript) => [transcript.id, transcript]));
  return completeTranscriptOrder(
    transcripts.map((transcript) => transcript.id),
    requestedIds,
  ).flatMap((id) => {
    const transcript = byId.get(id);
    return transcript ? [transcript] : [];
  });
}

export function moveTranscriptRelative(
  canonicalIds: readonly string[],
  customIds: readonly string[],
  transcriptId: string,
  referenceId: string,
  placement: TranscriptOrderPlacement,
): string[] {
  const current = completeTranscriptOrder(canonicalIds, customIds);
  if (
    transcriptId === referenceId
    || !current.includes(transcriptId)
    || !current.includes(referenceId)
  ) {
    return normalizeTranscriptOrder(canonicalIds, current);
  }
  const withoutTranscript = current.filter((id) => id !== transcriptId);
  const referenceIndex = withoutTranscript.indexOf(referenceId);
  const insertionIndex = placement === "before" ? referenceIndex : referenceIndex + 1;
  const next = [
    ...withoutTranscript.slice(0, insertionIndex),
    transcriptId,
    ...withoutTranscript.slice(insertionIndex),
  ];
  return normalizeTranscriptOrder(canonicalIds, next);
}

export function transcriptNeighborIds(
  transcriptIds: readonly string[],
  transcriptId: string,
): string[] {
  const index = transcriptIds.indexOf(transcriptId);
  if (index < 0) return [];
  return [transcriptIds[index - 1], transcriptIds[index + 1]].filter(
    (id): id is string => Boolean(id),
  );
}
