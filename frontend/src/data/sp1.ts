import { fitInterval } from "../lib/coordinates";
import { projectFeatureThroughCds } from "../lib/projection";
import type {
  BrowserViewState,
  BuildManifest,
  FeatureSource,
  Gene,
  ProteinFeature,
  Transcript,
  TranscriptExon,
} from "../types";

type FeatureSeed = readonly [
  transcriptId: string,
  source: FeatureSource,
  aaStart: number,
  aaEnd: number,
  featureId: string,
  name: string,
  method?: string,
];

function exon(
  id: string,
  rank: number,
  start1: number,
  end1: number,
  cdsStart1?: number,
  cdsEnd1?: number,
  phase?: 0 | 1 | 2,
  aaStart?: number,
  aaEnd?: number,
): TranscriptExon {
  return {
    id,
    rank,
    start0: start1 - 1,
    end0: end1,
    cdsStart0: cdsStart1 === undefined ? undefined : cdsStart1 - 1,
    cdsEnd0: cdsEnd1,
    phase,
    aaStart,
    aaEnd,
  };
}

const BASE_TRANSCRIPTS: Transcript[] = [
  {
    id: "ENST00000327443",
    versionedId: "ENST00000327443.9",
    name: "SP1-201",
    proteinId: "ENSP00000329357",
    versionedProteinId: "ENSP00000329357.4",
    biotype: "protein_coding",
    start0: 53_380_175,
    end0: 53_416_446,
    strand: "+",
    transcriptLength: 7_680,
    cdsLength: 2_355,
    fastaCdsSpanLength: 2_358,
    proteinLength: 785,
    tsl: "TSL 1",
    annotationLevel: 2,
    ccdsId: "CCDS8857.1",
    appris: "APPRIS principal 4",
    badges: ["MANE Select", "Canonical", "+3"],
    tags: ["GENCODE Basic", "APPRIS principal 4", "CCDS8857.1", "Level 2"],
    exons: [
      exon("ENSE00002328883.1", 1, 53_380_176, 53_380_298, 53_380_292, 53_380_298, 0, 1, 3),
      exon("ENSE00003476492.1", 2, 53_381_659, 53_381_813, 53_381_659, 53_381_813, 2, 3, 54),
      exon("ENSE00001323424.1", 3, 53_382_110, 53_383_622, 53_382_110, 53_383_622, 0, 55, 559),
      exon("ENSE00001262755.1", 4, 53_406_585, 53_406_753, 53_406_585, 53_406_753, 2, 559, 615),
      exon("ENSE00001262751.1", 5, 53_409_362, 53_409_561, 53_409_362, 53_409_561, 1, 615, 682),
      exon("ENSE00001300823.5", 6, 53_410_927, 53_416_446, 53_410_927, 53_411_237, 2, 682, 785),
    ],
    features: [],
  },
  {
    id: "ENST00000426431",
    versionedId: "ENST00000426431.2",
    name: "SP1-202",
    proteinId: "ENSP00000404263",
    versionedProteinId: "ENSP00000404263.2",
    biotype: "protein_coding",
    start0: 53_380_638,
    end0: 53_416_446,
    strand: "+",
    transcriptLength: 7_603,
    cdsLength: 2_334,
    fastaCdsSpanLength: 2_337,
    proteinLength: 778,
    tsl: "TSL 1",
    annotationLevel: 2,
    ccdsId: "CCDS44898.1",
    appris: "APPRIS alternative 1",
    badges: ["APPRIS alt 1", "Basic", "+1"],
    tags: ["GENCODE Basic", "CCDS44898.1", "Level 2"],
    exons: [
      exon("ENSE00001601266.2", 1, 53_380_639, 53_380_684),
      exon("ENSE00003542413.1", 2, 53_381_659, 53_381_813, 53_381_673, 53_381_813, 0, 1, 47),
      exon("ENSE00001323424.1", 3, 53_382_110, 53_383_622, 53_382_110, 53_383_622, 0, 48, 552),
      exon("ENSE00001262755.1", 4, 53_406_585, 53_406_753, 53_406_585, 53_406_753, 2, 552, 608),
      exon("ENSE00001262751.1", 5, 53_409_362, 53_409_561, 53_409_362, 53_409_561, 1, 608, 675),
      exon("ENSE00001300823.5", 6, 53_410_927, 53_416_446, 53_410_927, 53_411_237, 2, 675, 778),
    ],
    features: [],
  },
  {
    id: "ENST00000548560",
    versionedId: "ENST00000548560.1",
    name: "SP1-203",
    proteinId: "ENSP00000458133",
    versionedProteinId: "ENSP00000458133.1",
    biotype: "protein_coding",
    start0: 53_381_301,
    end0: 53_382_658,
    strand: "+",
    transcriptLength: 1_061,
    cdsLength: 690,
    proteinLength: 230,
    tsl: "TSL 2",
    annotationLevel: 2,
    badges: ["TSL 2", "CDS end NF"],
    tags: ["mRNA end not found", "CDS end not found", "Level 2"],
    exons: [
      exon("ENSE00002413875.1", 1, 53_381_302, 53_381_813, 53_381_673, 53_381_813, 0, 1, 47),
      exon("ENSE00002404298.1", 2, 53_382_110, 53_382_658, 53_382_110, 53_382_658, 0, 48, 230),
    ],
    features: [],
  },
  {
    id: "ENST00000551969",
    versionedId: "ENST00000551969.5",
    name: "SP1-204",
    proteinId: "ENSP00000457804",
    versionedProteinId: "ENSP00000457804.1",
    biotype: "protein_coding",
    start0: 53_380_175,
    end0: 53_382_577,
    strand: "+",
    transcriptLength: 602,
    cdsLength: 486,
    proteinLength: 162,
    tsl: "TSL 3",
    annotationLevel: 1,
    badges: ["Level 1", "Experimental"],
    tags: ["mRNA end not found", "CDS end not found", "exp_conf"],
    exons: [
      exon("ENSE00002328883.1", 1, 53_380_176, 53_380_298, 53_380_292, 53_380_298, 0, 1, 3),
      exon("ENSE00003476492.1", 2, 53_381_659, 53_381_813, 53_381_659, 53_381_813, 2, 3, 54),
      exon("ENSE00002326499.1", 3, 53_382_254, 53_382_577, 53_382_254, 53_382_577, 0, 55, 162),
    ],
    features: [],
  },
];

function seedSeries(
  transcriptId: string,
  source: FeatureSource,
  intervals: readonly (readonly [number, number])[],
  featureId: string,
  name: string,
  method = "biomaRt",
): FeatureSeed[] {
  return intervals.map(([aaStart, aaEnd]) => [
    transcriptId,
    source,
    aaStart,
    aaEnd,
    featureId,
    name,
    method,
  ]);
}

const FEATURE_SEEDS: FeatureSeed[] = [
  ...seedSeries("ENST00000327443", "interpro", [[626, 650], [626, 655], [628, 650], [656, 680], [656, 685], [658, 680], [686, 708], [686, 713], [688, 708]], "IPR013087", "Zinc finger C2H2-type"),
  ["ENST00000327443", "interpro", 637, 695, "IPR036236", "Zinc finger C2H2 superfamily", "biomaRt"],
  ...seedSeries("ENST00000426431", "interpro", [[619, 643], [619, 648], [621, 643], [649, 673], [649, 678], [651, 673], [679, 701], [679, 706], [681, 701]], "IPR013087", "Zinc finger C2H2-type"),
  ["ENST00000426431", "interpro", 630, 688, "IPR036236", "Zinc finger C2H2 superfamily", "biomaRt"],
  ...seedSeries("ENST00000327443", "pfam", [[626, 650], [656, 680], [686, 708]], "PF00096", "C2H2 zinc finger"),
  ...seedSeries("ENST00000426431", "pfam", [[619, 643], [649, 673], [679, 701]], "PF00096", "C2H2 zinc finger"),
  ...seedSeries("ENST00000327443", "mobidblite", [[1, 93], [29, 63], [70, 93], [109, 141], [329, 395], [567, 598]], "mobidb-lite", "Predicted disorder"),
  ...seedSeries("ENST00000426431", "mobidblite", [[1, 86], [22, 56], [63, 86], [102, 134], [322, 388], [559, 591]], "mobidb-lite", "Predicted disorder"),
  ...seedSeries("ENST00000551969", "mobidblite", [[1, 94], [29, 94]], "mobidb-lite", "Predicted disorder"),
  ...seedSeries("ENST00000327443", "elm", [[450, 456], [736, 742]], "MOD_ProDKin_1", "Proline-directed kinase motif", "elm"),
];

const transcriptById = new Map(BASE_TRANSCRIPTS.map((transcript) => [transcript.id, transcript]));
const featuresByTranscript = new Map<string, ProteinFeature[]>();

FEATURE_SEEDS.forEach((seed, index) => {
  const [transcriptId, source, aaStart, aaEnd, featureId, name, method = "local"] = seed;
  const transcript = transcriptById.get(transcriptId);
  if (!transcript) return;
  const feature: ProteinFeature = {
    recordId: `${source}:${transcriptId}:${featureId}:${aaStart}-${aaEnd}:${index + 1}`,
    transcriptId,
    source,
    featureId,
    name,
    aaStart,
    aaEnd,
    method,
    segments: projectFeatureThroughCds(transcript, aaStart, aaEnd),
  };
  const bucket = featuresByTranscript.get(transcriptId) ?? [];
  bucket.push(feature);
  featuresByTranscript.set(transcriptId, bucket);
});

export const SP1_TRANSCRIPTS: Transcript[] = BASE_TRANSCRIPTS.map((transcript) => ({
  ...transcript,
  features: featuresByTranscript.get(transcript.id) ?? [],
}));

export const SP1_GENE: Gene = {
  id: "ENSG00000185591",
  versionedId: "ENSG00000185591.10",
  symbol: "SP1",
  name: "Sp1 transcription factor",
  hgncId: "HGNC:11205",
  biotype: "protein_coding",
  chrom: "chr12",
  start0: 53_380_175,
  end0: 53_416_446,
  strand: "+",
  transcripts: SP1_TRANSCRIPTS,
};

export const FALLBACK_MANIFEST: BuildManifest = {
  release: "GENCODE v45 · Ensembl 111",
  assembly: "GRCh38.p14",
  buildHash: "sp1-fixture-v1",
  dataSource: "fixture",
  referenceAvailable: false,
  technicalPreview: true,
  featureSources: ["interpro", "pfam", "mobidblite", "elm", "cdd", "tmhmm", "signalp"],
  capabilities: {
    search: true,
    region: true,
    sequences: true,
    proteinFeatures: true,
    export: true,
  },
  coordinateContract: { machine: "0-based half-open", display: "1-based inclusive" },
  reference: { available: false },
};

export const DEFAULT_VIEW_STATE: BrowserViewState = {
  buildHash: FALLBACK_MANIFEST.buildHash,
  selectedGeneId: SP1_GENE.id,
  locus: fitInterval(SP1_GENE.chrom, SP1_GENE.start0, SP1_GENE.end0),
  selectedTranscriptId: "ENST00000327443",
  comparisonTranscriptId: "",
  transcriptOrderIds: [],
  expandedTranscriptIds: ["ENST00000327443"],
  pinnedTranscriptIds: [],
  activeSources: ["interpro", "pfam", "mobidblite", "elm", "cdd", "tmhmm", "signalp"],
  activeFeatureClasses: ["transmembrane_helix", "signal_peptide", "intrinsic_disorder", "short_linear_motif"],
  excludedTranscriptBiotypes: [],
  activeTranscriptFlags: [],
  rowDensity: "comfortable",
  canvasKeyboardShortcuts: true,
  inspectorTab: "transcript",
  displayMode: "expanded",
};
