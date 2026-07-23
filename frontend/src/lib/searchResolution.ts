import type { SearchResult } from "../types";

export type SubmittedSearchResolution =
  | { kind: "navigate"; result: SearchResult }
  | { kind: "ambiguous-gene"; count: number }
  | { kind: "ambiguous-exact"; count: number }
  | { kind: "none" }
  | { kind: "choose"; count: number };

export function normalizedSearchToken(value: string): string {
  return value.trim().toLowerCase().replace(/\.\d+$/, "");
}

export function exactSearchMatches(
  query: string,
  results: readonly SearchResult[],
): SearchResult[] {
  const token = normalizedSearchToken(query);
  return results.filter((result) => {
    const identityValues = [result.id, result.versionedId, result.label];
    if (result.kind === "gene") identityValues.push(result.symbol);
    return identityValues.some((value) => value && normalizedSearchToken(value) === token);
  });
}

export function resolveSubmittedSearch(
  query: string,
  results: readonly SearchResult[],
): SubmittedSearchResolution {
  if (results.length === 1) return { kind: "navigate", result: results[0] };

  const exactGenes = exactSearchMatches(
    query,
    results.filter((result) => result.kind === "gene"),
  );
  if (exactGenes.length === 1) return { kind: "navigate", result: exactGenes[0] };
  if (exactGenes.length > 1) return { kind: "ambiguous-gene", count: exactGenes.length };

  const exact = exactSearchMatches(query, results);
  if (exact.length === 1) return { kind: "navigate", result: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous-exact", count: exact.length };
  if (results.length === 0) return { kind: "none" };
  return { kind: "choose", count: results.length };
}
