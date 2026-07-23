import {
  FEATURE_CLASS_BY_SOURCE,
  type FeatureClass,
  type FeatureSource,
  type Transcript,
  type TranscriptFlag,
} from "../types";

function normalizedLabels(transcript: Transcript): string[] {
  return [...transcript.badges, ...transcript.tags]
    .map((value) => value.trim().toLowerCase().replaceAll("_", " "));
}

export function transcriptFlags(transcript: Transcript): Set<TranscriptFlag> {
  const labels = normalizedLabels(transcript);
  const has = (test: (value: string) => boolean) => labels.some(test);
  const flags = new Set<TranscriptFlag>();
  if (has((value) => value === "mane select")) flags.add("mane_select");
  if (has((value) => value === "mane plus clinical")) flags.add("mane_plus_clinical");
  if (has((value) => value === "canonical" || value === "ensembl canonical")) {
    flags.add("ensembl_canonical");
  }
  const appris = transcript.appris?.trim().toLowerCase() ?? "";
  if (appris.startsWith("appris principal") || has((value) => value.startsWith("appris principal"))) {
    flags.add("appris_principal");
  }
  if (has((value) => value === "basic" || value === "gencode basic")) flags.add("gencode_basic");
  if (Boolean(transcript.ccdsId) || has((value) => value.startsWith("ccds"))) flags.add("ccds");
  return flags;
}

export function enabledFeatureSources(
  activeSources: readonly FeatureSource[],
  activeClasses: readonly FeatureClass[],
): FeatureSource[] {
  const classes = new Set(activeClasses);
  return activeSources.filter((source) => {
    const featureClass = FEATURE_CLASS_BY_SOURCE[source];
    return featureClass === undefined || classes.has(featureClass);
  });
}

export function transcriptMatchesFilters(
  transcript: Transcript,
  excludedBiotypes: readonly string[],
  activeFlags: readonly TranscriptFlag[],
): boolean {
  if (excludedBiotypes.includes(transcript.biotype)) return false;
  if (!activeFlags.length) return true;
  const flags = transcriptFlags(transcript);
  return activeFlags.some((flag) => flags.has(flag));
}

/**
 * Selection and pins are research context, not ordinary filter results. They
 * are retained in their original gene order even if a biotype/flag filter
 * excludes them, so filtering can never make the active object disappear.
 */
export function filterTranscriptsWithContext(
  transcripts: readonly Transcript[],
  excludedBiotypes: readonly string[],
  activeFlags: readonly TranscriptFlag[],
  selectedTranscriptId: string,
  pinnedTranscriptIds: readonly string[],
  comparisonTranscriptId = "",
): Transcript[] {
  const retained = new Set([selectedTranscriptId, comparisonTranscriptId, ...pinnedTranscriptIds]);
  return transcripts.filter((transcript) => (
    retained.has(transcript.id)
    || transcriptMatchesFilters(transcript, excludedBiotypes, activeFlags)
  ));
}
