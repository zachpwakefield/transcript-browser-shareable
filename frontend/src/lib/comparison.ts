import {
  FEATURE_SOURCES,
  SOURCE_META,
  type FeatureSource,
  type Transcript,
} from "../types";

export type ComparisonValueState =
  | "value"
  | "zero"
  | "missing"
  | "not-applicable"
  | "not-loaded";

export type ComparisonPrimitive = string | number | boolean;

export interface ComparisonCell {
  state: ComparisonValueState;
  value: ComparisonPrimitive | null;
  display: string;
}

export interface TranscriptComparisonRow {
  key: string;
  label: string;
  selected: ComparisonCell;
  comparison: ComparisonCell;
  different: boolean;
}

export interface TranscriptTagComparison {
  shared: string[];
  selectedOnly: string[];
  comparisonOnly: string[];
}

export interface TranscriptComparisonModel {
  selectedTranscriptId: string;
  comparisonTranscriptId: string;
  rows: TranscriptComparisonRow[];
  tags: TranscriptTagComparison;
}

export type TranscriptAnnotationFlag =
  | "mane-select"
  | "mane-plus-clinical"
  | "ensembl-canonical"
  | "gencode-basic";

function normalizedLabel(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replaceAll("_", " ").replace(/\s+/g, " ");
}

function deterministicLabelSort(left: string, right: string): number {
  const normalizedLeft = normalizedLabel(left);
  const normalizedRight = normalizedLabel(right);
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

export function valueCell(value: ComparisonPrimitive): ComparisonCell {
  if (typeof value === "number" && value === 0) {
    return { state: "zero", value, display: "0" };
  }
  return {
    state: "value",
    value,
    display: typeof value === "boolean" ? value ? "Yes" : "No" : String(value),
  };
}

export function missingCell(): ComparisonCell {
  return { state: "missing", value: null, display: "Not provided" };
}

export function notApplicableCell(): ComparisonCell {
  return { state: "not-applicable", value: null, display: "Not applicable" };
}

export function notLoadedCell(): ComparisonCell {
  return { state: "not-loaded", value: null, display: "Not loaded" };
}

export function optionalTextCell(value: string | undefined): ComparisonCell {
  const normalized = value?.trim();
  return normalized && normalized.toLocaleLowerCase("en-US") !== "not provided"
    ? valueCell(normalized)
    : missingCell();
}

export function comparisonCellsDiffer(left: ComparisonCell, right: ComparisonCell): boolean {
  return left.state !== right.state || left.value !== right.value;
}

function row(
  key: string,
  label: string,
  selected: ComparisonCell,
  comparison: ComparisonCell,
): TranscriptComparisonRow {
  return {
    key,
    label,
    selected,
    comparison,
    different: comparisonCellsDiffer(selected, comparison),
  };
}

function proteinApplicable(transcript: Transcript): boolean {
  return Boolean(transcript.proteinId.trim() || transcript.versionedProteinId.trim() || transcript.cdsLength > 0);
}

export function transcriptExonCountCell(transcript: Transcript): ComparisonCell {
  if (transcript.detailState === "idle" || transcript.detailState === "loading") return notLoadedCell();
  if (transcript.detailState === "error") return missingCell();
  return valueCell(transcript.exons.length);
}

export function transcriptFeatureCountCell(
  transcript: Transcript,
  source?: FeatureSource,
): ComparisonCell {
  if (transcript.featuresState === "idle" || transcript.featuresState === "loading") return notLoadedCell();
  if (transcript.featuresState === "error") return missingCell();
  const count = source
    ? transcript.features.reduce((total, feature) => total + Number(feature.source === source), 0)
    : transcript.features.length;
  return valueCell(count);
}

export function transcriptHasAnnotationFlag(
  transcript: Pick<Transcript, "badges" | "tags">,
  flag: TranscriptAnnotationFlag,
): boolean {
  const labels = [...transcript.badges, ...transcript.tags].map(normalizedLabel);
  switch (flag) {
    case "mane-select":
      return labels.some((label) => label === "mane select" || label.startsWith("mane select "));
    case "mane-plus-clinical":
      return labels.some((label) => label === "mane plus clinical" || label.startsWith("mane plus clinical "));
    case "ensembl-canonical":
      return labels.some((label) => label === "canonical" || label === "ensembl canonical");
    case "gencode-basic":
      return labels.some((label) => label === "basic" || label === "gencode basic");
  }
}

export function compareTranscriptTags(
  selected: Pick<Transcript, "tags">,
  comparison: Pick<Transcript, "tags">,
): TranscriptTagComparison {
  function tagMap(tags: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    tags.forEach((rawTag) => {
      const tag = rawTag.trim();
      const normalized = normalizedLabel(tag);
      if (normalized && !result.has(normalized)) result.set(normalized, tag);
    });
    return result;
  }

  const selectedTags = tagMap(selected.tags);
  const comparisonTags = tagMap(comparison.tags);
  const shared = [...selectedTags]
    .filter(([normalized]) => comparisonTags.has(normalized))
    .map(([, label]) => label)
    .sort(deterministicLabelSort);
  const selectedOnly = [...selectedTags]
    .filter(([normalized]) => !comparisonTags.has(normalized))
    .map(([, label]) => label)
    .sort(deterministicLabelSort);
  const comparisonOnly = [...comparisonTags]
    .filter(([normalized]) => !selectedTags.has(normalized))
    .map(([, label]) => label)
    .sort(deterministicLabelSort);
  return { shared, selectedOnly, comparisonOnly };
}

export function buildTranscriptComparison(
  selected: Transcript,
  comparison: Transcript,
  featureSources: readonly FeatureSource[] = FEATURE_SOURCES,
): TranscriptComparisonModel {
  const selectedHasProtein = proteinApplicable(selected);
  const comparisonHasProtein = proteinApplicable(comparison);
  const rows: TranscriptComparisonRow[] = [
    row("name", "Name", valueCell(selected.name), valueCell(comparison.name)),
    row("transcript-id", "Transcript ID", valueCell(selected.versionedId), valueCell(comparison.versionedId)),
    row(
      "protein-id",
      "Protein ID",
      selectedHasProtein ? optionalTextCell(selected.versionedProteinId || selected.proteinId) : notApplicableCell(),
      comparisonHasProtein ? optionalTextCell(comparison.versionedProteinId || comparison.proteinId) : notApplicableCell(),
    ),
    row("biotype", "Biotype", valueCell(selected.biotype), valueCell(comparison.biotype)),
    row("tsl", "Transcript support level", optionalTextCell(selected.tsl), optionalTextCell(comparison.tsl)),
    row(
      "annotation-level",
      "Annotation level",
      selected.annotationLevel === undefined ? missingCell() : valueCell(selected.annotationLevel),
      comparison.annotationLevel === undefined ? missingCell() : valueCell(comparison.annotationLevel),
    ),
    row("transcript-length", "Transcript length", valueCell(selected.transcriptLength), valueCell(comparison.transcriptLength)),
    row(
      "cds-length",
      "CDS length",
      selectedHasProtein ? valueCell(selected.cdsLength) : notApplicableCell(),
      comparisonHasProtein ? valueCell(comparison.cdsLength) : notApplicableCell(),
    ),
    row(
      "protein-length",
      "Protein length",
      selectedHasProtein ? valueCell(selected.proteinLength) : notApplicableCell(),
      comparisonHasProtein ? valueCell(comparison.proteinLength) : notApplicableCell(),
    ),
    row("exon-count", "Exon count", transcriptExonCountCell(selected), transcriptExonCountCell(comparison)),
    row("ccds", "CCDS", optionalTextCell(selected.ccdsId), optionalTextCell(comparison.ccdsId)),
    row("appris", "APPRIS", optionalTextCell(selected.appris), optionalTextCell(comparison.appris)),
    row(
      "mane-select",
      "MANE Select",
      valueCell(transcriptHasAnnotationFlag(selected, "mane-select")),
      valueCell(transcriptHasAnnotationFlag(comparison, "mane-select")),
    ),
    row(
      "mane-plus-clinical",
      "MANE Plus Clinical",
      valueCell(transcriptHasAnnotationFlag(selected, "mane-plus-clinical")),
      valueCell(transcriptHasAnnotationFlag(comparison, "mane-plus-clinical")),
    ),
    row(
      "ensembl-canonical",
      "Ensembl canonical",
      valueCell(transcriptHasAnnotationFlag(selected, "ensembl-canonical")),
      valueCell(transcriptHasAnnotationFlag(comparison, "ensembl-canonical")),
    ),
    row(
      "gencode-basic",
      "GENCODE basic",
      valueCell(transcriptHasAnnotationFlag(selected, "gencode-basic")),
      valueCell(transcriptHasAnnotationFlag(comparison, "gencode-basic")),
    ),
    row(
      "feature-count-total",
      "Feature count · total",
      transcriptFeatureCountCell(selected),
      transcriptFeatureCountCell(comparison),
    ),
    ...featureSources.map((source) => row(
      `feature-count-${source}`,
      `Feature count · ${SOURCE_META[source].label}`,
      transcriptFeatureCountCell(selected, source),
      transcriptFeatureCountCell(comparison, source),
    )),
  ];
  return {
    selectedTranscriptId: selected.id,
    comparisonTranscriptId: comparison.id,
    rows,
    tags: compareTranscriptTags(selected, comparison),
  };
}

export function comparisonCellExportValue(cell: ComparisonCell): string | number | boolean {
  switch (cell.state) {
    case "value":
    case "zero":
      return cell.value as ComparisonPrimitive;
    case "not-applicable":
      return "N/A";
    case "not-loaded":
      return "Not loaded";
    case "missing":
      return "";
  }
}
