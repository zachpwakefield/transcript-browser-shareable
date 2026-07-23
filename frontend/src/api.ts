import { FALLBACK_MANIFEST } from "./data/sp1";
import {
  FEATURE_SOURCES,
  type BuildManifest,
  type DensityBin,
  type DisplayModeSetting,
  type FeatureSource,
  type Gene,
  type Locus,
  type ProteinFeature,
  type RegionData,
  type RegionGene,
  type SearchEntityKind,
  type SearchResult,
  type Transcript,
  type TranscriptExon,
} from "./types";

type JsonObject = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 12_000;
const immutableCache = new Map<string, unknown>();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function firstString(record: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(record: JsonObject, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstBoolean(record: JsonObject, keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === "boolean") return record[key] as boolean;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function baseId(value: string): string {
  return value.replace(/\.\d+$/, "");
}

function normalizeChrom(value: string): string {
  return /^chr/i.test(value) ? `chr${value.slice(3)}` : `chr${value}`;
}

function normalizeSource(value: unknown): FeatureSource | null {
  const normalized = typeof value === "string"
    ? value.toLowerCase().replaceAll(/[-_\s]/g, "")
    : "";
  const aliases: Record<string, FeatureSource> = {
    interpro: "interpro",
    pfam: "pfam",
    mobidblite: "mobidblite",
    elm: "elm",
    cdd: "cdd",
    tmhmm: "tmhmm",
    signalp: "signalp",
  };
  return aliases[normalized] ?? null;
}

function errorDetail(payload: unknown, status: number, path: string): ApiError {
  const root = objectValue(payload);
  const detail = objectValue(root?.detail) ?? root;
  const message = detail ? firstString(detail, ["message", "detail", "error"]) : undefined;
  const code = detail ? firstString(detail, ["code"]) : undefined;
  return new ApiError(message ?? `${path} returned HTTP ${status}.`, status, code);
}

async function fetchJson<T = unknown>(
  path: string,
  signal: AbortSignal,
  cacheKey?: string,
): Promise<T> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (cacheKey && immutableCache.has(cacheKey)) return immutableCache.get(cacheKey) as T;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException("Local request timed out", "TimeoutError")),
    REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(path, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-cache",
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) throw errorDetail(payload, response.status, path);
    if (cacheKey) immutableCache.set(cacheKey, payload);
    return payload as T;
  } catch (error) {
    if (controller.signal.aborted) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      throw new ApiError("The local service did not respond within 12 seconds.", 408, "LOCAL_TIMEOUT");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

export function clearApiCache(): void {
  immutableCache.clear();
}

export function normalizeManifest(value: unknown): BuildManifest {
  const record = objectValue(value);
  if (!record) throw new ApiError("The local build manifest is not a JSON object.", 500, "INVALID_MANIFEST");
  const buildHash = firstString(record, ["buildHash", "build_hash", "content_hash", "hash"]);
  if (!buildHash) throw new ApiError("The local build manifest has no build hash.", 500, "INVALID_MANIFEST");
  const reference = objectValue(record.reference);
  const featureSources = (Array.isArray(record.featureSources) ? record.featureSources : [])
    .map((value) => normalizeSource(objectValue(value)?.name ?? value))
    .filter((source): source is FeatureSource => source !== null);
  const capabilitiesRecord = objectValue(record.capabilities) ?? {};
  const capabilities = Object.fromEntries(
    Object.entries(capabilitiesRecord).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
  );
  const release = firstString(record, ["release", "gencodeRelease", "gencode_release"]) ?? "GENCODE v45";
  const ensembl = firstNumber(record, ["ensemblRelease", "ensembl_release"])
    ?? firstString(record, ["ensemblRelease", "ensembl_release"]);
  const referenceAvailable = firstBoolean(reference ?? {}, ["available"]) ?? false;
  const coordinate = objectValue(record.coordinateContract);
  return {
    schemaVersion: firstString(record, ["schemaVersion", "schema_version"]),
    release: ensembl !== undefined && !release.toLowerCase().includes("ensembl")
      ? `${release} · Ensembl ${ensembl}`
      : release,
    gencodeRelease: release,
    ensemblRelease: ensembl,
    assembly: firstString(record, ["assembly", "genomeBuild", "genome_build"]) ?? "GRCh38.p14",
    buildHash,
    dataSource: "api",
    referenceAvailable,
    technicalPreview: firstBoolean(record, ["technicalPreview", "technical_preview"]) ?? false,
    featureSources: featureSources.length ? featureSources : [...FEATURE_SOURCES],
    capabilities,
    coordinateContract: coordinate ? {
      machine: firstString(coordinate, ["machine"]) ?? "0-based half-open",
      display: firstString(coordinate, ["display"]) ?? "1-based inclusive",
    } : undefined,
    reference: {
      available: referenceAvailable,
      verified: firstBoolean(reference ?? {}, ["verified"]),
      kind: reference ? firstString(reference, ["kind"]) : undefined,
      url: reference ? firstString(reference, ["url"]) : undefined,
      faiUrl: reference ? firstString(reference, ["faiUrl", "fai_url"]) : undefined,
      chromSizesUrl: reference ? firstString(reference, ["chromSizesUrl", "chrom_sizes_url"]) : undefined,
    },
  };
}

export async function loadManifest(signal: AbortSignal): Promise<BuildManifest> {
  return normalizeManifest(await fetchJson("/api/v1/manifest", signal));
}

function normalizeSearchResult(value: unknown): SearchResult | null {
  const record = objectValue(value);
  if (!record) return null;
  const rawKind = firstString(record, ["kind", "entityType", "entity_type"])?.toLowerCase();
  const kinds: SearchEntityKind[] = ["gene", "transcript", "protein", "exon", "coordinate"];
  if (!rawKind || !kinds.includes(rawKind as SearchEntityKind)) return null;
  const id = firstString(record, ["id", "stableId", "stable_id"]);
  const chrom = firstString(record, ["chr", "chrom", "contig"]);
  const start0 = firstNumber(record, ["start0"]);
  const end0 = firstNumber(record, ["end0"]);
  if (!id || !chrom || start0 === undefined || end0 === undefined || end0 <= start0) return null;
  const strandValue = firstString(record, ["strand"]);
  return {
    kind: rawKind as SearchEntityKind,
    id,
    versionedId: firstString(record, ["versionedId", "versioned_id"]),
    resolvedVersion: firstString(record, ["resolvedVersion", "resolved_version"]),
    label: firstString(record, ["label", "displayName", "display_name"]) ?? id,
    symbol: firstString(record, ["symbol"]),
    chrom: normalizeChrom(chrom),
    start0,
    end0,
    strand: strandValue === "+" || strandValue === "-" ? strandValue : undefined,
    biotype: firstString(record, ["biotype"]),
    geneId: firstString(record, ["geneId", "gene_id"]),
    geneVersionedId: firstString(record, ["geneVersionedId", "gene_versioned_id"]),
    geneSymbol: firstString(record, ["geneSymbol", "gene_symbol"]),
    transcriptId: firstString(record, ["transcriptId", "transcript_id"]),
    transcriptVersionedId: firstString(record, ["transcriptVersionedId", "transcript_versioned_id"]),
  };
}

export function normalizeSearchPayload(value: unknown): SearchResult[] {
  const record = objectValue(value);
  const rows = Array.isArray(record?.results) ? record.results : Array.isArray(value) ? value : [];
  return rows.map(normalizeSearchResult).filter((item): item is SearchResult => item !== null);
}

export async function searchLocal(query: string, signal: AbortSignal, limit = 20): Promise<SearchResult[]> {
  const value = await fetchJson(
    `/api/v1/search?q=${encodeURIComponent(query)}&limit=${Math.max(1, Math.min(50, limit))}`,
    signal,
  );
  return normalizeSearchPayload(value);
}

function transcriptBadges(record: JsonObject): string[] {
  const rawAppris = firstString(record, ["appris"]);
  return [
    firstBoolean(record, ["isManeSelect", "is_mane_select"]) ? "MANE Select" : undefined,
    firstBoolean(record, ["isManePlusClinical", "is_mane_plus_clinical"]) ? "MANE Plus Clinical" : undefined,
    firstBoolean(record, ["isEnsemblCanonical", "is_ensembl_canonical"]) ? "Canonical" : undefined,
    rawAppris ? rawAppris.replace(/^appris_/i, "APPRIS ").replaceAll("_", " ") : undefined,
    firstBoolean(record, ["isBasic", "is_basic"]) ? "Basic" : undefined,
    firstString(record, ["ccdsId", "ccds_id"]),
  ].filter((value): value is string => Boolean(value));
}

function normalizeTranscriptSummary(value: unknown, fallback?: Transcript): Transcript | null {
  const record = objectValue(value);
  if (!record) return fallback ?? null;
  const rawId = firstString(record, ["id", "transcriptId", "transcript_id"]);
  if (!rawId && !fallback) return null;
  const id = baseId(rawId ?? fallback!.id);
  const versionedId = firstString(record, ["versionedId", "transcriptVersionedId", "transcript_id_versioned"])
    ?? fallback?.versionedId
    ?? id;
  const rawStrand = firstString(record, ["strand"]);
  const proteinId = firstString(record, ["proteinId", "protein_id"]) ?? fallback?.proteinId ?? "";
  const proteinVersionedId = firstString(record, ["proteinVersionedId", "protein_id_versioned"])
    ?? fallback?.versionedProteinId
    ?? proteinId;
  const badges = transcriptBadges(record);
  const tags = stringArray(record.tags);
  const sequencesRecord = objectValue(record.sequences);
  const normalizedSequences = sequencesRecord
    ? Object.fromEntries(Object.entries(sequencesRecord).flatMap(([kind, raw]) => {
        if (!["transcript_full", "cds", "protein"].includes(kind)) return [];
        const item = objectValue(raw);
        return item ? [[kind, {
          available: firstBoolean(item, ["available"]) ?? true,
          length: firstNumber(item, ["length"]) ?? 0,
        }]] : [];
      })) as Transcript["sequences"]
    : undefined;
  const sequences = normalizedSequences
    ? { ...fallback?.sequences, ...normalizedSequences }
    : fallback?.sequences;
  const rawTsl = firstString(record, ["tsl"]);
  return {
    id,
    geneId: firstString(record, ["geneId", "gene_id"]) ?? fallback?.geneId,
    versionedId,
    name: firstString(record, ["name", "transcriptName", "transcript_name", "label"])
      ?? fallback?.name
      ?? versionedId,
    proteinId,
    versionedProteinId: proteinVersionedId,
    biotype: firstString(record, ["biotype", "transcriptType", "transcript_type"])
      ?? fallback?.biotype
      ?? "unknown",
    start0: firstNumber(record, ["start0"]) ?? fallback?.start0 ?? 0,
    end0: firstNumber(record, ["end0"]) ?? fallback?.end0 ?? 1,
    strand: rawStrand === "-" ? "-" : fallback?.strand ?? "+",
    transcriptLength: firstNumber(record, ["transcriptLength", "transcript_length"])
      ?? fallback?.transcriptLength
      ?? 0,
    cdsLength: firstNumber(record, ["cdsLength", "cds_length"]) ?? fallback?.cdsLength ?? 0,
    fastaCdsSpanLength: firstNumber(record, ["fastaCdsSpanLength", "fasta_cds_span_length"])
      ?? fallback?.fastaCdsSpanLength,
    proteinLength: firstNumber(record, ["proteinLength", "protein_length"])
      ?? fallback?.proteinLength
      ?? 0,
    tsl: rawTsl
      ? rawTsl.toLowerCase().startsWith("tsl") ? rawTsl : `TSL ${rawTsl}`
      : fallback?.tsl ?? "Not provided",
    annotationLevel: firstNumber(record, ["annotationLevel", "annotation_level", "level"])
      ?? fallback?.annotationLevel,
    ccdsId: firstString(record, ["ccdsId", "ccds_id"]) ?? fallback?.ccdsId,
    appris: firstString(record, ["appris"])?.replace(/^appris_/i, "APPRIS ").replaceAll("_", " ")
      ?? fallback?.appris,
    badges: badges.length ? badges : fallback?.badges ?? [],
    tags: tags.length ? tags : fallback?.tags ?? [],
    exons: fallback?.exons ?? [],
    features: fallback?.features ?? [],
    featureCount: firstNumber(record, ["featureCount", "feature_count"]) ?? fallback?.featureCount,
    featuresState: fallback?.featuresState ?? "idle",
    detailState: fallback?.detailState ?? "idle",
    sequences,
  };
}

export function normalizeDetailedTranscript(value: unknown, fallback?: Transcript): Transcript | null {
  const record = objectValue(value);
  const summary = normalizeTranscriptSummary(value, fallback);
  if (!record || !summary) return summary;
  const rawExons = Array.isArray(record.exons) ? record.exons : [];
  const rawCds = Array.isArray(record.cdsSegments) ? record.cdsSegments : [];
  const mapping = objectValue(record.translationMapping);
  const cdsTranscriptStarts = rawCds.flatMap((raw) => {
      const item = objectValue(raw);
      const value = item ? firstNumber(item, ["transcriptStart0"]) : undefined;
      return value === undefined ? [] : [value];
    });
  const cdsOrigin = firstNumber(mapping ?? {}, ["cdsStart0", "codingStart0"])
    ?? (cdsTranscriptStarts.length ? Math.min(...cdsTranscriptStarts) : 0);
  const cdsByExon = new Map<number, JsonObject[]>();
  rawCds.forEach((raw) => {
    const item = objectValue(raw);
    const rank = item ? firstNumber(item, ["exonRank", "exon_rank"]) : undefined;
    if (!item || rank === undefined) return;
    const bucket = cdsByExon.get(rank) ?? [];
    bucket.push(item);
    cdsByExon.set(rank, bucket);
  });
  const exons: TranscriptExon[] = rawExons.flatMap((raw) => {
    const item = objectValue(raw);
    if (!item) return [];
    const rank = firstNumber(item, ["rank", "exonRank"]);
    const start0 = firstNumber(item, ["start0"]);
    const end0 = firstNumber(item, ["end0"]);
    if (rank === undefined || start0 === undefined || end0 === undefined || end0 <= start0) return [];
    const rows = cdsByExon.get(rank) ?? [];
    const numbers = (key: string) => rows.flatMap((row) => {
      const value = firstNumber(row, [key]);
      return value === undefined ? [] : [value];
    });
    const starts = numbers("start0");
    const ends = numbers("end0");
    const transcriptStarts = numbers("transcriptStart0");
    const transcriptEnds = numbers("transcriptEnd0");
    const rawPhase = rows[0] ? firstNumber(rows[0], ["phase"]) : undefined;
    return [{
      id: firstString(item, ["versionedId", "id"]) ?? `exon-${rank}`,
      rank,
      start0,
      end0,
      cdsStart0: starts.length ? Math.min(...starts) : undefined,
      cdsEnd0: ends.length ? Math.max(...ends) : undefined,
      phase: rawPhase === 0 || rawPhase === 1 || rawPhase === 2 ? rawPhase : undefined,
      aaStart: transcriptStarts.length
        ? Math.floor((Math.min(...transcriptStarts) - cdsOrigin) / 3) + 1
        : undefined,
      aaEnd: transcriptEnds.length
        ? Math.floor((Math.max(...transcriptEnds) - cdsOrigin - 1) / 3) + 1
        : undefined,
    }];
  });
  return {
    ...summary,
    exons,
    detailState: exons.length || rawExons.length === 0 ? "ready" : "error",
  };
}

function normalizeGene(value: unknown): Gene | null {
  const record = objectValue(value);
  if (!record) return null;
  const id = firstString(record, ["id", "geneId", "gene_id"]);
  const chrom = firstString(record, ["chr", "chrom", "contig"]);
  const start0 = firstNumber(record, ["start0"]);
  const end0 = firstNumber(record, ["end0"]);
  if (!id || !chrom || start0 === undefined || end0 === undefined || end0 <= start0) return null;
  const transcriptRows = Array.isArray(record.transcripts) ? record.transcripts : [];
  const strand = firstString(record, ["strand"]);
  const symbol = firstString(record, ["symbol", "geneSymbol", "gene_symbol"]) ?? id;
  return {
    id: baseId(id),
    versionedId: firstString(record, ["versionedId", "gene_id_versioned"]) ?? id,
    symbol,
    name: firstString(record, ["name", "description", "displayName"]) ?? symbol,
    hgncId: firstString(record, ["hgncId", "hgnc_id"]) ?? "Not assigned",
    biotype: firstString(record, ["biotype"]) ?? "unknown",
    chrom: normalizeChrom(chrom),
    start0,
    end0,
    strand: strand === "-" ? "-" : "+",
    transcripts: transcriptRows
      .map((row) => normalizeTranscriptSummary(row))
      .filter((item): item is Transcript => item !== null),
  };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

export async function loadTranscript(
  identifier: string,
  signal: AbortSignal,
  buildHash: string,
  fallback?: Transcript,
): Promise<Transcript> {
  const payload = await fetchJson(
    `/api/v1/transcripts/${encodeURIComponent(identifier)}`,
    signal,
    `${buildHash}:transcript:${baseId(identifier)}`,
  );
  const normalized = normalizeDetailedTranscript(payload, fallback);
  if (!normalized) throw new ApiError(`Transcript ${identifier} returned an invalid payload.`, 500, "INVALID_TRANSCRIPT");
  return normalized;
}

export async function loadGene(
  identifier: string,
  signal: AbortSignal,
  buildHash: string,
): Promise<Gene> {
  const payload = await fetchJson(
    `/api/v1/genes/${encodeURIComponent(identifier)}`,
    signal,
    `${buildHash}:gene:${baseId(identifier)}`,
  );
  const gene = normalizeGene(payload);
  if (!gene) throw new ApiError(`Gene ${identifier} returned an invalid payload.`, 500, "INVALID_GENE");
  return gene;
}

export async function loadGeneWithTranscripts(
  identifier: string,
  signal: AbortSignal,
  buildHash: string,
): Promise<Gene> {
  const gene = await loadGene(identifier, signal, buildHash);
  const transcripts = await mapLimit(gene.transcripts, 8, async (summary) => {
    try {
      return await loadTranscript(summary.id, signal, buildHash, summary);
    } catch (error) {
      if (signal.aborted) throw error;
      return { ...summary, detailState: "error" as const };
    }
  });
  return { ...gene, transcripts };
}

export async function loadTranscriptFeatures(
  transcript: Transcript,
  sources: readonly FeatureSource[],
  signal: AbortSignal,
  buildHash: string,
): Promise<ProteinFeature[]> {
  const normalizedSources = [...new Set(sources)].sort();
  const query = normalizedSources.length ? `?sources=${encodeURIComponent(normalizedSources.join(","))}` : "";
  const payload = await fetchJson(
    `/api/v1/transcripts/${encodeURIComponent(transcript.id)}/features${query}`,
    signal,
    `${buildHash}:features:${transcript.id}:${normalizedSources.join(",")}`,
  );
  return normalizeFeaturePayload(payload, transcript);
}

export function normalizeFeaturePayload(payload: unknown, transcript: Transcript): ProteinFeature[] {
  const record = objectValue(payload);
  const rows = Array.isArray(record?.features) ? record.features : [];
  const mapping = objectValue(record?.mapping);
  const responseMappingStatus = firstString(mapping ?? {}, ["status", "mappingStatus", "mapping_status"]);
  const mappingReason = firstString(mapping ?? {}, ["reason", "mappingReason", "mapping_reason"]);
  return rows.flatMap((raw): ProteinFeature[] => {
    const item = objectValue(raw);
    if (!item) return [];
    const source = normalizeSource(item.source);
    const aaStart = firstNumber(item, ["aaStart1", "aaStart"]);
    const aaEnd = firstNumber(item, ["aaEnd1", "aaEnd"]);
    const recordId = firstString(item, ["id", "recordId"]);
    if (!source || aaStart === undefined || aaEnd === undefined || !recordId || aaStart < 1 || aaEnd < aaStart) return [];
    const mappingStatus = firstString(item, ["projectionStatus", "mappingStatus"]) ?? responseMappingStatus;
    const segments = mappingStatus === "exact" && Array.isArray(item.segments)
      ? item.segments.flatMap((rawSegment) => {
          const segment = objectValue(rawSegment);
          const start0 = segment ? firstNumber(segment, ["start0"]) : undefined;
          const end0 = segment ? firstNumber(segment, ["end0"]) : undefined;
          if (start0 === undefined || end0 === undefined || end0 <= start0) return [];
          return [{
            start0,
            end0,
            exonRank: firstNumber(segment!, ["exonRank", "exon_rank"]),
            ntStart0: firstNumber(segment!, ["ntStart0", "nt_start0"]),
            ntEnd0: firstNumber(segment!, ["ntEnd0", "nt_end0"]),
          }];
        })
      : [];
    const rawAuditRecord = objectValue(item.rawAudit) ?? objectValue(item.raw_audit);
    const rawAudit = rawAuditRecord ? {
      name: firstString(rawAuditRecord, ["name"]),
      chrom: firstString(rawAuditRecord, ["chr", "chrom"]),
      start1: firstNumber(rawAuditRecord, ["start1"]),
      end1: firstNumber(rawAuditRecord, ["end1"]),
      strand: firstString(rawAuditRecord, ["strand"]),
      notDrawable: firstBoolean(rawAuditRecord, ["notDrawable", "not_drawable"]),
    } : undefined;
    return [{
      recordId,
      transcriptId: transcript.id,
      source,
      featureId: firstString(item, ["accession", "featureId"]) ?? "local-record",
      name: firstString(item, ["name", "altName", "displayName"]) ?? "Source annotation",
      altName: firstString(item, ["altName", "alt_name"]),
      aaStart,
      aaEnd,
      method: firstString(item, ["method"]) ?? "local",
      projectionStatus: mappingStatus,
      mappingReason,
      rawAudit,
      segments,
    }];
  });
}

function normalizeRegionGene(value: unknown): RegionGene | null {
  const record = objectValue(value);
  if (!record) return null;
  const id = firstString(record, ["id", "geneId"]);
  const chrom = firstString(record, ["chr", "chrom", "contig"]);
  const start0 = firstNumber(record, ["start0"]);
  const end0 = firstNumber(record, ["end0"]);
  if (!id || !chrom || start0 === undefined || end0 === undefined || end0 <= start0) return null;
  const strand = firstString(record, ["strand"]);
  return {
    id: baseId(id),
    versionedId: firstString(record, ["versionedId"]) ?? id,
    symbol: firstString(record, ["symbol"]) ?? id,
    hgncId: firstString(record, ["hgncId"]),
    biotype: firstString(record, ["biotype"]) ?? "unknown",
    chrom: normalizeChrom(chrom),
    start0,
    end0,
    strand: strand === "-" ? "-" : "+",
    transcriptCount: firstNumber(record, ["transcriptCount", "transcript_count"]) ?? 0,
    inRequestedRegion: firstBoolean(record, ["inRequestedRegion", "in_requested_region"]),
    lodOverride: firstBoolean(record, ["lodOverride", "lod_override"]),
  };
}

export function normalizeRegionPayload(value: unknown, requested: Locus, requestedDetail: DisplayModeSetting): RegionData {
  const record = objectValue(value);
  if (!record) throw new ApiError("The region response is not a JSON object.", 500, "INVALID_REGION");
  const detailValue = firstString(record, ["detail"]);
  const detail = detailValue === "overview" || detailValue === "compact" || detailValue === "expanded"
    ? detailValue
    : "labeled";
  const densityObject = objectValue(record.density);
  const densityRows = Array.isArray(record.densityBins)
    ? record.densityBins
    : Array.isArray(densityObject?.bins)
      ? densityObject.bins
      : Array.isArray(record.density)
        ? record.density
      : [];
  const density: DensityBin[] = densityRows.flatMap((raw) => {
    const item = objectValue(raw);
    const start0 = item ? firstNumber(item, ["start0"]) : undefined;
    const end0 = item ? firstNumber(item, ["end0"]) : undefined;
    if (start0 === undefined || end0 === undefined || end0 <= start0) return [];
    return [{
      start0,
      end0,
      geneCount: firstNumber(item!, ["geneCount", "gene_count"]) ?? 0,
      transcriptCount: firstNumber(item!, ["transcriptCount", "transcript_count"]) ?? 0,
    }];
  });
  const limitsRecord = objectValue(record.limits) ?? {};
  const chrom = firstString(record, ["chr", "chrom"]) ?? requested.chrom;
  return {
    chrom: normalizeChrom(chrom),
    start0: firstNumber(record, ["start0"]) ?? requested.start0,
    end0: firstNumber(record, ["end0"]) ?? requested.end0,
    requestedDetail,
    detail,
    genes: (Array.isArray(record.genes) ? record.genes : [])
      .map(normalizeRegionGene)
      .filter((item): item is RegionGene => item !== null),
    transcripts: (Array.isArray(record.transcripts) ? record.transcripts : [])
      .map((row) => normalizeTranscriptSummary(row))
      .filter((item): item is Transcript => item !== null),
    density,
    emptyState: firstString(record, ["emptyState", "empty_state"]),
    truncated: record.truncated === true,
    limits: {
      genes: firstNumber(limitsRecord, ["genes"]),
      transcripts: firstNumber(limitsRecord, ["transcripts"]),
      spanBp: firstNumber(limitsRecord, ["spanBp", "span_bp"]),
    },
    cache: objectValue(record.cache) ?? undefined,
  };
}

export async function loadRegion(
  locus: Locus,
  detail: DisplayModeSetting,
  signal: AbortSignal,
  buildHash: string,
  selectedTranscriptIds: readonly string[] = [],
  pinnedTranscriptIds: readonly string[] = [],
): Promise<RegionData> {
  const selected = [...new Set(selectedTranscriptIds)].slice(0, 50);
  const pinned = [...new Set(pinnedTranscriptIds)].slice(0, 50);
  const params = new URLSearchParams({
    chr: locus.chrom,
    start0: String(locus.start0),
    end0: String(locus.end0),
    detail,
  });
  selected.forEach((id) => params.append("selected", id));
  pinned.forEach((id) => params.append("pinned", id));
  const key = `${buildHash}:region:${locus.chrom}:${locus.start0}:${locus.end0}:${detail}:${selected.join(",")}:${pinned.join(",")}`;
  const payload = await fetchJson(`/api/v1/region?${params.toString()}`, signal, key);
  return normalizeRegionPayload(payload, locus, detail);
}

export type SequenceKind = "transcript_full" | "cds" | "protein";

export type PdfReportSection = "summary" | "structure" | "features" | "sequence";
export type PdfStructureScope = "full" | "current_locus";

export interface PdfReportRequest {
  buildHash: string;
  geneId: string;
  transcriptIds: string[];
  sections: PdfReportSection[];
  featureSources: FeatureSource[];
  structureScope: PdfStructureScope;
  locus?: Locus;
  sequenceExcerpt?: {
    kind: SequenceKind;
    start1: number;
    end1: number;
  };
}

export interface PdfReportDownload {
  blob: Blob;
  filename: string;
}

export async function createTranscriptPdf(
  specification: PdfReportRequest,
  signal: AbortSignal,
): Promise<PdfReportDownload> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException("Local PDF generation timed out", "TimeoutError")),
    60_000,
  );
  try {
    const response = await fetch("/api/v1/report/pdf", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/pdf",
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(specification),
    });
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      throw errorDetail(payload, response.status, "/api/v1/report/pdf");
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf")) {
      throw new ApiError("The local service returned a non-PDF report payload.", 500, "INVALID_PDF_RESPONSE");
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const declaredFilename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? "transcript-report.pdf";
    const filename = declaredFilename.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
      || "transcript-report.pdf";
    return { blob: await response.blob(), filename };
  } catch (error) {
    if (controller.signal.aborted) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      throw new ApiError("The local PDF report did not finish within 60 seconds.", 408, "PDF_TIMEOUT");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

export async function loadTranscriptSequence(
  transcriptId: string,
  kind: SequenceKind,
  signal: AbortSignal,
  buildHash?: string,
): Promise<string | null> {
  const payload = await fetchJson(
    `/api/v1/transcripts/${encodeURIComponent(transcriptId)}/sequence?kind=${encodeURIComponent(kind)}`,
    signal,
    buildHash ? `${buildHash}:sequence:${baseId(transcriptId)}:${kind}` : undefined,
  );
  const record = objectValue(payload);
  if (!record) return null;
  if (record.available === false) return null;
  const data = objectValue(record.data);
  const sequence = (typeof record.sequence === "string" ? record.sequence : undefined)
    ?? (typeof data?.sequence === "string" ? data.sequence : undefined);
  return sequence?.replace(/\s+/g, "") || null;
}

export function fallbackManifest(): BuildManifest {
  return FALLBACK_MANIFEST;
}
