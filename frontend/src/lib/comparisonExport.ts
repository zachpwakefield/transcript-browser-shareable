import {
  FEATURE_SOURCES,
  type FeatureSource,
  type Gene,
  type Transcript,
} from "../types";
import type { EntityKey, UserAnnotation } from "./workspaceStore";
import {
  comparisonCellExportValue,
  optionalTextCell,
  transcriptExonCountCell,
  transcriptFeatureCountCell,
  transcriptHasAnnotationFlag,
  valueCell,
} from "./comparison";

export const MAX_COMPARISON_EXPORT_TRANSCRIPTS = 20;
export type ComparisonExportFormat = "csv" | "tsv";

export type ComparisonExportSelectionErrorCode =
  | "missing-selected"
  | "missing-comparison"
  | "missing-pinned"
  | "same-transcript"
  | "too-many-transcripts"
  | "wrong-gene";

export class ComparisonExportSelectionError extends Error {
  readonly code: ComparisonExportSelectionErrorCode;
  readonly transcriptIds: string[];
  readonly limit: number;

  constructor(
    code: ComparisonExportSelectionErrorCode,
    message: string,
    transcriptIds: readonly string[] = [],
    limit = MAX_COMPARISON_EXPORT_TRANSCRIPTS,
  ) {
    super(message);
    this.name = "ComparisonExportSelectionError";
    this.code = code;
    this.transcriptIds = [...transcriptIds];
    this.limit = limit;
  }
}

export interface ComparisonExportSelectionOptions {
  selectedTranscriptId: string;
  comparisonTranscriptId?: string;
  pinnedTranscriptIds?: readonly string[];
  includePinned?: boolean;
  limit?: number;
}

export interface ComparisonExportTranscript {
  transcript: Transcript;
  selected: boolean;
  comparison: boolean;
  pinned: boolean;
}

export type UserAnnotationLookup = Readonly<Partial<Record<EntityKey, UserAnnotation>>>;

export const COMPARISON_EXPORT_COLUMNS = [
  "build_hash",
  "gene_id",
  "gene_versioned_id",
  "gene_symbol",
  "transcript_id",
  "transcript_versioned_id",
  "transcript_name",
  "protein_id",
  "protein_versioned_id",
  "biotype",
  "transcript_support_level",
  "annotation_level",
  "transcript_length",
  "cds_length",
  "protein_length",
  "exon_count",
  "ccds",
  "appris",
  "mane_select",
  "mane_plus_clinical",
  "ensembl_canonical",
  "gencode_basic",
  "feature_count_total",
  "feature_count_interpro",
  "feature_count_pfam",
  "feature_count_mobidblite",
  "feature_count_elm",
  "feature_count_cdd",
  "feature_count_tmhmm",
  "feature_count_signalp",
  "is_selected",
  "is_comparison",
  "is_pinned",
  "user_note",
  "user_tags",
] as const;

export type ComparisonExportColumn = (typeof COMPARISON_EXPORT_COLUMNS)[number];
export type ComparisonExportValue = string | number | boolean;
export type ComparisonExportRow = Record<ComparisonExportColumn, ComparisonExportValue>;

function stableUnique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });
  return result;
}

export function selectComparisonExportTranscripts(
  visuallyOrderedTranscripts: readonly Transcript[],
  options: ComparisonExportSelectionOptions,
): ComparisonExportTranscript[] {
  const requestedLimit = options.limit ?? MAX_COMPARISON_EXPORT_TRANSCRIPTS;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_COMPARISON_EXPORT_TRANSCRIPTS, Math.floor(requestedLimit)))
    : MAX_COMPARISON_EXPORT_TRANSCRIPTS;
  const byId = new Map(visuallyOrderedTranscripts.map((transcript) => [transcript.id, transcript]));
  const selectedId = options.selectedTranscriptId;
  const comparisonId = options.comparisonTranscriptId;
  if (!byId.has(selectedId)) {
    throw new ComparisonExportSelectionError(
      "missing-selected",
      `Selected transcript ${selectedId || "(empty)"} is not in the current gene.`,
      selectedId ? [selectedId] : [],
      limit,
    );
  }
  if (comparisonId && comparisonId === selectedId) {
    throw new ComparisonExportSelectionError(
      "same-transcript",
      "Selected and comparison transcripts must be different.",
      [selectedId],
      limit,
    );
  }
  if (comparisonId && !byId.has(comparisonId)) {
    throw new ComparisonExportSelectionError(
      "missing-comparison",
      `Comparison transcript ${comparisonId} is not in the current gene.`,
      [comparisonId],
      limit,
    );
  }

  const pinnedIds = options.includePinned ? stableUnique(options.pinnedTranscriptIds ?? []) : [];
  const missingPinned = pinnedIds.filter((id) => !byId.has(id));
  if (missingPinned.length) {
    throw new ComparisonExportSelectionError(
      "missing-pinned",
      `${missingPinned.length} pinned transcript${missingPinned.length === 1 ? " is" : "s are"} not in the current gene.`,
      missingPinned,
      limit,
    );
  }
  const requestedIds = new Set(stableUnique([selectedId, comparisonId ?? "", ...pinnedIds]));
  if (requestedIds.size > limit) {
    throw new ComparisonExportSelectionError(
      "too-many-transcripts",
      `Comparison export is limited to ${limit} transcripts; ${requestedIds.size} were requested.`,
      [...requestedIds],
      limit,
    );
  }
  const pinnedSet = new Set(pinnedIds);
  return visuallyOrderedTranscripts.flatMap((transcript) => requestedIds.has(transcript.id) ? [{
    transcript,
    selected: transcript.id === selectedId,
    comparison: transcript.id === comparisonId,
    pinned: pinnedSet.has(transcript.id),
  }] : []);
}

function exportMetric(value: ReturnType<typeof valueCell>): ComparisonExportValue {
  return comparisonCellExportValue(value);
}

function annotationForTranscript(
  annotations: UserAnnotationLookup | undefined,
  transcriptId: string,
): UserAnnotation | undefined {
  return annotations?.[`transcript:${transcriptId}`];
}

function proteinApplicable(transcript: Transcript): boolean {
  return Boolean(transcript.proteinId.trim() || transcript.versionedProteinId.trim() || transcript.cdsLength > 0);
}

export function buildComparisonExportRows(
  buildHash: string,
  gene: Gene,
  selection: readonly ComparisonExportTranscript[],
  annotations?: UserAnnotationLookup,
): ComparisonExportRow[] {
  if (selection.length > MAX_COMPARISON_EXPORT_TRANSCRIPTS) {
    throw new ComparisonExportSelectionError(
      "too-many-transcripts",
      `Comparison export is limited to ${MAX_COMPARISON_EXPORT_TRANSCRIPTS} transcripts; ${selection.length} were supplied.`,
      selection.map(({ transcript }) => transcript.id),
    );
  }
  const wrongGene = selection
    .map(({ transcript }) => transcript)
    .filter((transcript) => transcript.geneId && transcript.geneId !== gene.id)
    .map((transcript) => transcript.id);
  if (wrongGene.length) {
    throw new ComparisonExportSelectionError(
      "wrong-gene",
      "Comparison export supports transcripts from one current gene only.",
      wrongGene,
    );
  }

  return selection.map(({ transcript, selected, comparison, pinned }) => {
    const annotation = annotationForTranscript(annotations, transcript.id);
    const hasProtein = proteinApplicable(transcript);
    const featureCounts = Object.fromEntries(FEATURE_SOURCES.map((source) => [
      `feature_count_${source}`,
      exportMetric(transcriptFeatureCountCell(transcript, source)),
    ])) as Record<`feature_count_${FeatureSource}`, ComparisonExportValue>;
    return {
      build_hash: buildHash,
      gene_id: gene.id,
      gene_versioned_id: gene.versionedId,
      gene_symbol: gene.symbol,
      transcript_id: transcript.id,
      transcript_versioned_id: transcript.versionedId,
      transcript_name: transcript.name,
      protein_id: hasProtein ? transcript.proteinId : "N/A",
      protein_versioned_id: hasProtein ? transcript.versionedProteinId : "N/A",
      biotype: transcript.biotype,
      transcript_support_level: exportMetric(optionalTextCell(transcript.tsl)),
      annotation_level: transcript.annotationLevel === undefined ? "" : transcript.annotationLevel,
      transcript_length: transcript.transcriptLength,
      cds_length: hasProtein ? transcript.cdsLength : "N/A",
      protein_length: hasProtein ? transcript.proteinLength : "N/A",
      exon_count: exportMetric(transcriptExonCountCell(transcript)),
      ccds: exportMetric(optionalTextCell(transcript.ccdsId)),
      appris: exportMetric(optionalTextCell(transcript.appris)),
      mane_select: transcriptHasAnnotationFlag(transcript, "mane-select"),
      mane_plus_clinical: transcriptHasAnnotationFlag(transcript, "mane-plus-clinical"),
      ensembl_canonical: transcriptHasAnnotationFlag(transcript, "ensembl-canonical"),
      gencode_basic: transcriptHasAnnotationFlag(transcript, "gencode-basic"),
      feature_count_total: exportMetric(transcriptFeatureCountCell(transcript)),
      ...featureCounts,
      is_selected: selected,
      is_comparison: comparison,
      is_pinned: pinned,
      user_note: annotation?.note ?? "",
      user_tags: annotation?.tags.join("; ") ?? "",
    };
  });
}

export function protectSpreadsheetUserValue(value: string): string {
  return /^(?:[=+\-@\t\r\n]|\s+[=+\-@])/u.test(value) ? `'${value}` : value;
}

export function quoteDelimitedField(value: ComparisonExportValue, delimiter: "," | "\t"): string {
  const text = String(value);
  return text.includes(delimiter) || /["\r\n]/u.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

export function serializeComparisonExport(
  rows: readonly ComparisonExportRow[],
  format: ComparisonExportFormat,
): string {
  const delimiter = format === "csv" ? "," : "\t";
  const userColumns = new Set<ComparisonExportColumn>(["user_note", "user_tags"]);
  const lines = [
    COMPARISON_EXPORT_COLUMNS.map((column) => quoteDelimitedField(column, delimiter)).join(delimiter),
    ...rows.map((row) => COMPARISON_EXPORT_COLUMNS.map((column) => {
      const raw = row[column];
      const value = userColumns.has(column) ? protectSpreadsheetUserValue(String(raw)) : raw;
      return quoteDelimitedField(value, delimiter);
    }).join(delimiter)),
  ];
  return `${lines.join("\n")}\n`;
}

function filenamePart(value: string, fallback: string): string {
  const safe = value
    .normalize("NFKC")
    .trim()
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/gu, "_")
    .replace(/\s+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^[._-]+|[._-]+$/gu, "");
  return safe || fallback;
}

export function comparisonExportFilename(
  geneSymbol: string,
  buildHash: string,
  format: ComparisonExportFormat,
): string {
  return `${filenamePart(geneSymbol, "gene")}_${filenamePart(buildHash, "unknown-build")}_transcript-comparison.${format}`;
}
