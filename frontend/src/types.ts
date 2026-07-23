export const FEATURE_SOURCES = [
  "interpro",
  "pfam",
  "mobidblite",
  "elm",
  "cdd",
  "tmhmm",
  "signalp",
] as const;

export type FeatureSource = (typeof FEATURE_SOURCES)[number];

export const FEATURE_CLASSES = [
  "transmembrane_helix",
  "signal_peptide",
  "intrinsic_disorder",
  "short_linear_motif",
] as const;

export type FeatureClass = (typeof FEATURE_CLASSES)[number];

export const TRANSCRIPT_FLAGS = [
  "mane_select",
  "mane_plus_clinical",
  "ensembl_canonical",
  "appris_principal",
  "gencode_basic",
  "ccds",
] as const;

export type TranscriptFlag = (typeof TRANSCRIPT_FLAGS)[number];

export type RowDensity = "compact" | "comfortable";

export type InspectorTab =
  | "gene"
  | "transcript"
  | "compare"
  | "feature"
  | "sequence"
  | "table";

export type DisplayMode = "overview" | "compact" | "labeled" | "expanded";
export type DisplayModeSetting = "auto" | DisplayMode;

export interface Locus {
  chrom: string;
  start0: number;
  end0: number;
}

export interface GenomicSegment {
  start0: number;
  end0: number;
  exonRank?: number;
  ntStart0?: number;
  ntEnd0?: number;
}

export interface FeatureRawAudit {
  name?: string;
  chrom?: string;
  start1?: number;
  end1?: number;
  strand?: string;
  notDrawable?: boolean;
}

export interface TranscriptExon {
  id: string;
  rank: number;
  start0: number;
  end0: number;
  cdsStart0?: number;
  cdsEnd0?: number;
  phase?: 0 | 1 | 2;
  aaStart?: number;
  aaEnd?: number;
}

export interface ProteinFeature {
  recordId: string;
  transcriptId: string;
  source: FeatureSource;
  featureId: string;
  name: string;
  altName?: string;
  aaStart: number;
  aaEnd: number;
  method: string;
  projectionStatus?: string;
  mappingReason?: string;
  rawAudit?: FeatureRawAudit;
  segments: GenomicSegment[];
}

export type LoadState = "idle" | "loading" | "ready" | "error";

export interface Transcript {
  id: string;
  geneId?: string;
  versionedId: string;
  name: string;
  proteinId: string;
  versionedProteinId: string;
  biotype: string;
  start0: number;
  end0: number;
  strand: "+" | "-";
  transcriptLength: number;
  cdsLength: number;
  fastaCdsSpanLength?: number;
  proteinLength: number;
  tsl: string;
  annotationLevel?: number;
  ccdsId?: string;
  appris?: string;
  badges: string[];
  tags: string[];
  exons: TranscriptExon[];
  features: ProteinFeature[];
  featureCount?: number;
  featuresState?: LoadState;
  detailState?: LoadState;
  sequences?: Partial<Record<"transcript_full" | "cds" | "protein", { available: boolean; length: number }>>;
}

export interface Gene {
  id: string;
  versionedId: string;
  symbol: string;
  name: string;
  hgncId: string;
  biotype: string;
  chrom: string;
  start0: number;
  end0: number;
  strand: "+" | "-";
  transcripts: Transcript[];
}

export interface BrowserViewState {
  buildHash: string;
  selectedGeneId: string;
  locus: Locus;
  selectedTranscriptId: string;
  comparisonTranscriptId: string;
  transcriptOrderIds: string[];
  expandedTranscriptIds: string[];
  pinnedTranscriptIds: string[];
  activeSources: FeatureSource[];
  activeFeatureClasses: FeatureClass[];
  excludedTranscriptBiotypes: string[];
  activeTranscriptFlags: TranscriptFlag[];
  rowDensity: RowDensity;
  canvasKeyboardShortcuts: boolean;
  inspectorTab: InspectorTab;
  selectedFeatureId?: string;
  displayMode: DisplayModeSetting;
}

export interface BuildManifest {
  schemaVersion?: string;
  release: string;
  gencodeRelease?: string;
  ensemblRelease?: string | number;
  assembly: string;
  buildHash: string;
  dataSource: "api" | "fixture";
  referenceAvailable: boolean;
  technicalPreview: boolean;
  featureSources: FeatureSource[];
  capabilities: Record<string, boolean>;
  coordinateContract?: { machine: string; display: string };
  reference?: {
    available: boolean;
    verified?: boolean;
    kind?: string;
    url?: string;
    faiUrl?: string;
    chromSizesUrl?: string;
  };
}

export type SearchEntityKind = "gene" | "transcript" | "protein" | "exon" | "coordinate";

export interface SearchResult {
  kind: SearchEntityKind;
  id: string;
  versionedId?: string;
  resolvedVersion?: string;
  label: string;
  symbol?: string;
  chrom: string;
  start0: number;
  end0: number;
  strand?: "+" | "-";
  biotype?: string;
  geneId?: string;
  geneVersionedId?: string;
  geneSymbol?: string;
  transcriptId?: string;
  transcriptVersionedId?: string;
}

export interface RegionGene {
  id: string;
  versionedId: string;
  symbol: string;
  hgncId?: string;
  biotype: string;
  chrom: string;
  start0: number;
  end0: number;
  strand: "+" | "-";
  transcriptCount: number;
  inRequestedRegion?: boolean;
  lodOverride?: boolean;
}

export interface DensityBin {
  start0: number;
  end0: number;
  geneCount: number;
  transcriptCount: number;
}

export interface RegionData {
  chrom: string;
  start0: number;
  end0: number;
  requestedDetail: DisplayModeSetting;
  detail: DisplayMode;
  genes: RegionGene[];
  transcripts: Transcript[];
  density: DensityBin[];
  emptyState?: string;
  truncated: boolean;
  limits: { genes?: number; transcripts?: number; spanBp?: number };
  cache?: Record<string, unknown>;
}

export const SOURCE_META: Record<
  FeatureSource,
  { label: string; shortLabel: string; color: string; description: string }
> = {
  interpro: {
    label: "InterPro",
    shortLabel: "IPR",
    color: "#287f78",
    description: "InterPro source annotation",
  },
  pfam: {
    label: "Pfam",
    shortLabel: "PF",
    color: "#4664a8",
    description: "Pfam source annotation",
  },
  mobidblite: {
    label: "MobiDB-lite",
    shortLabel: "MOBI",
    color: "#8a6a98",
    description: "Consensus intrinsic-disorder prediction",
  },
  elm: {
    label: "ELM",
    shortLabel: "ELM",
    color: "#d16852",
    description: "Eukaryotic linear motif",
  },
  cdd: {
    label: "CDD",
    shortLabel: "CDD",
    color: "#5b7d3b",
    description: "CDD source annotation",
  },
  tmhmm: {
    label: "TMHMM",
    shortLabel: "TM",
    color: "#97633f",
    description: "Transmembrane-helix prediction",
  },
  signalp: {
    label: "SignalP",
    shortLabel: "SIG",
    color: "#b14869",
    description: "Signal-peptide prediction",
  },
};

/**
 * Only single-purpose sources have a defensible semantic class in the supplied
 * cache. InterPro, Pfam, and CDD intentionally have no entry here because their
 * local rows do not carry a typed ontology that would support one.
 */
export const FEATURE_CLASS_BY_SOURCE: Partial<Record<FeatureSource, FeatureClass>> = {
  tmhmm: "transmembrane_helix",
  signalp: "signal_peptide",
  mobidblite: "intrinsic_disorder",
  elm: "short_linear_motif",
};

export const FEATURE_CLASS_META: Record<FeatureClass, { label: string; description: string }> = {
  transmembrane_helix: {
    label: "TM helix",
    description: "Transmembrane-helix prediction from TMHMM",
  },
  signal_peptide: {
    label: "Signal peptide",
    description: "Signal-peptide prediction from SignalP",
  },
  intrinsic_disorder: {
    label: "Disorder",
    description: "Intrinsic-disorder prediction from MobiDB-lite",
  },
  short_linear_motif: {
    label: "Linear motif",
    description: "Short linear motif from ELM",
  },
};

export const TRANSCRIPT_FLAG_META: Record<TranscriptFlag, { label: string; description: string }> = {
  mane_select: { label: "MANE Select", description: "MANE Select transcript" },
  mane_plus_clinical: { label: "MANE Plus Clinical", description: "MANE Plus Clinical transcript" },
  ensembl_canonical: { label: "Canonical", description: "Ensembl canonical transcript" },
  appris_principal: { label: "APPRIS principal", description: "APPRIS principal isoform" },
  gencode_basic: { label: "GENCODE Basic", description: "GENCODE Basic transcript" },
  ccds: { label: "CCDS", description: "Transcript with a CCDS identifier" },
};
