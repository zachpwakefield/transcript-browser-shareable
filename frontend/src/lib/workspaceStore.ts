import type {
  PdfReportSection,
  PdfStructureScope,
  SequenceKind,
} from "../api";
import {
  FEATURE_CLASSES,
  FEATURE_SOURCES,
  TRANSCRIPT_FLAGS,
  type BrowserViewState,
  type FeatureClass,
  type FeatureSource,
  type TranscriptFlag,
} from "../types";
import { MAX_LOCUS_SPAN_BP } from "./coordinates";
import { MAX_EXPANDED_TRANSCRIPTS } from "./navigation";

export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_STORAGE_KEY = "transcript-browser:workspace:v1";
export const WORKSPACE_WRITE_DEBOUNCE_MS = 400;
export const MAX_WORKSPACE_BYTES = 512 * 1024;
export const MAX_RECENTS = 25;
export const MAX_FAVORITES = 100;
export const MAX_USER_ANNOTATIONS = 500;
export const MAX_NOTE_CHARACTERS = 5_000;
export const MAX_TAGS_PER_ENTITY = 10;
export const MAX_TAG_CHARACTERS = 40;
export const MAX_PDF_PRESET_TRANSCRIPTS = 20;
export const MAX_PDF_PRESET_SEQUENCE_CHARACTERS = 10_000;

const MAX_IDENTIFIER_CHARACTERS = 80;
const MAX_LABEL_CHARACTERS = 240;
const MAX_VIEW_TRANSCRIPT_IDS = 500;
const MAX_VIEW_PINNED_IDS = 50;
const MAX_VIEW_BIOTYPES = 100;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]+$/u;
const SAFE_CHROMOSOME = /^[A-Za-z0-9_.-]+$/u;
const PDF_SECTIONS: readonly PdfReportSection[] = ["summary", "structure", "features", "sequence"];
const PDF_SCOPES = ["selected", "selected_comparison", "selected_pinned"] as const;
const PDF_STRUCTURE_SCOPES: readonly PdfStructureScope[] = ["full", "current_locus"];
const SEQUENCE_KINDS: readonly SequenceKind[] = ["transcript_full", "cds", "protein"];
const ROW_DENSITIES = ["compact", "comfortable"] as const;
const INSPECTOR_TABS = ["gene", "transcript", "feature", "sequence", "table", "compare"] as const;
const DISPLAY_MODES = ["auto", "overview", "compact", "labeled", "expanded"] as const;

export type WorkspaceEntityKind = "gene" | "transcript";
export type EntityKey = `${WorkspaceEntityKind}:${string}`;
export type PdfPresetScope = (typeof PDF_SCOPES)[number];
export type WorkspaceLoadStatus = "missing" | "ready" | "invalid" | "build-mismatch";

export interface EntityReference {
  kind: WorkspaceEntityKind;
  id: string;
  label: string;
  updatedAt: string;
  versionedId?: string;
  geneId?: string;
  geneSymbol?: string;
}

export interface UserAnnotation {
  note: string;
  tags: string[];
  updatedAt: string;
}

export interface PdfPreset {
  buildHash: string;
  scope: PdfPresetScope;
  sections: PdfReportSection[];
  featureSources: FeatureSource[];
  structureScope: PdfStructureScope;
  updatedAt: string;
  sequenceExcerpt?: {
    kind: SequenceKind;
    start1: number;
    end1: number;
  };
}

export interface LocalWorkspaceState {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  buildHash: string;
  restoreLastView: boolean;
  lastView?: BrowserViewState;
  recents: EntityReference[];
  favorites: EntityReference[];
  notes: Partial<Record<EntityKey, UserAnnotation>>;
  lastPdfPreset?: PdfPreset;
}

export interface WorkspaceLoadResult {
  state: LocalWorkspaceState;
  status: WorkspaceLoadStatus;
}

export interface AnnotationMergeResult {
  notes: Partial<Record<EntityKey, UserAnnotation>>;
  added: EntityKey[];
  replaced: EntityKey[];
  preservedLocal: EntityKey[];
}

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function characterCount(value: string): number {
  return [...value].length;
}

function isSafeString(value: unknown, maximum = MAX_IDENTIFIER_CHARACTERS): value is string {
  return typeof value === "string" && value.length > 0 && characterCount(value) <= maximum;
}

function isSafeIdentifier(value: unknown): value is string {
  return isSafeString(value) && SAFE_IDENTIFIER.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function uniqueValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function safeIdentifierArray(value: unknown, maximum: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maximum || !value.every(isSafeIdentifier)) return undefined;
  return uniqueValues(value);
}

function enumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  maximum = allowed.length,
): T[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) return undefined;
  if (!value.every((item): item is T => typeof item === "string" && allowed.includes(item as T))) {
    return undefined;
  }
  return uniqueValues(value);
}

function stableBaseIdentifier(identifier: string): string {
  const match = /^(ENS[A-Z]*\d+)\.\d+$/u.exec(identifier);
  return match?.[1] ?? identifier;
}

function normalizedEntityReference(value: unknown): EntityReference | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind !== "gene" && value.kind !== "transcript") return undefined;
  if (!isSafeIdentifier(value.id) || !isSafeString(value.label, MAX_LABEL_CHARACTERS)) return undefined;
  if (!isIsoTimestamp(value.updatedAt)) return undefined;
  if (value.versionedId !== undefined && !isSafeIdentifier(value.versionedId)) return undefined;
  if (value.geneId !== undefined && !isSafeIdentifier(value.geneId)) return undefined;
  if (value.geneSymbol !== undefined && !isSafeString(value.geneSymbol, MAX_IDENTIFIER_CHARACTERS)) return undefined;
  return {
    kind: value.kind,
    id: stableBaseIdentifier(value.id),
    label: value.label,
    updatedAt: new Date(value.updatedAt).toISOString(),
    ...(value.versionedId ? { versionedId: value.versionedId } : {}),
    ...(value.geneId ? { geneId: stableBaseIdentifier(value.geneId) } : {}),
    ...(value.geneSymbol ? { geneSymbol: value.geneSymbol } : {}),
  };
}

function normalizedReferences(value: unknown, maximum: number): EntityReference[] {
  if (!Array.isArray(value)) return [];
  const result: EntityReference[] = [];
  const seen = new Set<EntityKey>();
  for (const candidate of value) {
    const reference = normalizedEntityReference(candidate);
    if (!reference) continue;
    const key = entityReferenceKey(reference);
    if (seen.has(key)) continue;
    result.push(reference);
    seen.add(key);
    if (result.length === maximum) break;
  }
  return result;
}

function normalizedUserAnnotation(value: unknown): UserAnnotation | undefined {
  if (!isRecord(value) || typeof value.note !== "string" || !Array.isArray(value.tags)) return undefined;
  if (characterCount(value.note) > MAX_NOTE_CHARACTERS || !isIsoTimestamp(value.updatedAt)) return undefined;
  if (value.tags.length > MAX_TAGS_PER_ENTITY || !value.tags.every((tag) => typeof tag === "string")) {
    return undefined;
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of value.tags as string[]) {
    const tag = rawTag.trim();
    const normalized = tag.toLocaleLowerCase();
    if (!tag || characterCount(tag) > MAX_TAG_CHARACTERS || seen.has(normalized)) return undefined;
    tags.push(tag);
    seen.add(normalized);
  }
  return {
    note: value.note,
    tags,
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function normalizedNotes(value: unknown): Partial<Record<EntityKey, UserAnnotation>> {
  if (!isRecord(value)) return {};
  const notes: Partial<Record<EntityKey, UserAnnotation>> = {};
  let count = 0;
  for (const [rawKey, candidate] of Object.entries(value)) {
    const parsedKey = parseEntityKey(rawKey);
    const annotation = normalizedUserAnnotation(candidate);
    if (!parsedKey || !annotation) continue;
    notes[parsedKey] = annotation;
    count += 1;
    if (count === MAX_USER_ANNOTATIONS) break;
  }
  return notes;
}

function normalizedView(value: unknown, currentBuildHash: string): BrowserViewState | undefined {
  if (!isRecord(value) || value.buildHash !== currentBuildHash) return undefined;
  if (!isSafeIdentifier(value.selectedGeneId) || !isSafeIdentifier(value.selectedTranscriptId)) return undefined;
  if (!isRecord(value.locus)) return undefined;
  const { chrom, start0, end0 } = value.locus;
  if (
    typeof chrom !== "string"
    || characterCount(chrom) > 60
    || !SAFE_CHROMOSOME.test(chrom)
    || !Number.isSafeInteger(start0)
    || !Number.isSafeInteger(end0)
    || (start0 as number) < 0
    || (end0 as number) <= (start0 as number)
    || (end0 as number) - (start0 as number) > MAX_LOCUS_SPAN_BP
  ) return undefined;
  const transcriptOrderIds = safeIdentifierArray(value.transcriptOrderIds, MAX_VIEW_TRANSCRIPT_IDS);
  const expandedTranscriptIds = safeIdentifierArray(value.expandedTranscriptIds, MAX_VIEW_TRANSCRIPT_IDS)
    ?.slice(0, MAX_EXPANDED_TRANSCRIPTS);
  const pinnedTranscriptIds = safeIdentifierArray(value.pinnedTranscriptIds, MAX_VIEW_PINNED_IDS);
  const activeSources = enumArray(value.activeSources, FEATURE_SOURCES);
  const activeFeatureClasses = enumArray(value.activeFeatureClasses, FEATURE_CLASSES);
  const activeTranscriptFlags = enumArray(value.activeTranscriptFlags, TRANSCRIPT_FLAGS);
  const excludedTranscriptBiotypes = safeIdentifierArray(value.excludedTranscriptBiotypes, MAX_VIEW_BIOTYPES);
  if (
    !transcriptOrderIds
    || !expandedTranscriptIds
    || !pinnedTranscriptIds
    || !activeSources
    || !activeFeatureClasses
    || !activeTranscriptFlags
    || !excludedTranscriptBiotypes
    || typeof value.canvasKeyboardShortcuts !== "boolean"
    || !ROW_DENSITIES.includes(value.rowDensity as (typeof ROW_DENSITIES)[number])
    || !INSPECTOR_TABS.includes(value.inspectorTab as (typeof INSPECTOR_TABS)[number])
    || !DISPLAY_MODES.includes(value.displayMode as (typeof DISPLAY_MODES)[number])
    || (value.selectedFeatureId !== undefined && !isSafeString(value.selectedFeatureId, 240))
    || (
      value.comparisonTranscriptId !== undefined
      && value.comparisonTranscriptId !== ""
      && !isSafeIdentifier(value.comparisonTranscriptId)
    )
  ) return undefined;

  const cleaned: UnknownRecord = {
    buildHash: currentBuildHash,
    selectedGeneId: value.selectedGeneId,
    locus: { chrom, start0, end0 },
    selectedTranscriptId: value.selectedTranscriptId,
    comparisonTranscriptId: value.comparisonTranscriptId || "",
    transcriptOrderIds,
    expandedTranscriptIds,
    pinnedTranscriptIds,
    activeSources: activeSources as FeatureSource[],
    activeFeatureClasses: activeFeatureClasses as FeatureClass[],
    excludedTranscriptBiotypes,
    activeTranscriptFlags: activeTranscriptFlags as TranscriptFlag[],
    rowDensity: value.rowDensity,
    canvasKeyboardShortcuts: value.canvasKeyboardShortcuts,
    inspectorTab: value.inspectorTab,
    displayMode: value.displayMode,
  };
  if (value.selectedFeatureId) cleaned.selectedFeatureId = value.selectedFeatureId;
  return cleaned as unknown as BrowserViewState;
}

export function validatePdfPreset(value: unknown, currentBuildHash: string): PdfPreset | undefined {
  if (!isRecord(value) || value.buildHash !== currentBuildHash || !isIsoTimestamp(value.updatedAt)) return undefined;
  if (!PDF_SCOPES.includes(value.scope as PdfPresetScope)) return undefined;
  const sections = enumArray(value.sections, PDF_SECTIONS);
  const featureSources = enumArray(value.featureSources, FEATURE_SOURCES);
  if (!sections?.length || !featureSources) return undefined;
  if (!PDF_STRUCTURE_SCOPES.includes(value.structureScope as PdfStructureScope)) return undefined;

  let sequenceExcerpt: PdfPreset["sequenceExcerpt"];
  if (sections.includes("sequence")) {
    if (!isRecord(value.sequenceExcerpt)) return undefined;
    const { kind, start1, end1 } = value.sequenceExcerpt;
    if (
      !SEQUENCE_KINDS.includes(kind as SequenceKind)
      || !Number.isSafeInteger(start1)
      || !Number.isSafeInteger(end1)
      || (start1 as number) < 1
      || (end1 as number) < (start1 as number)
      || (end1 as number) - (start1 as number) + 1 > MAX_PDF_PRESET_SEQUENCE_CHARACTERS
    ) return undefined;
    sequenceExcerpt = { kind: kind as SequenceKind, start1: start1 as number, end1: end1 as number };
  } else if (value.sequenceExcerpt !== undefined) {
    return undefined;
  }

  return {
    buildHash: currentBuildHash,
    scope: value.scope as PdfPresetScope,
    sections,
    featureSources,
    structureScope: value.structureScope as PdfStructureScope,
    updatedAt: new Date(value.updatedAt).toISOString(),
    ...(sequenceExcerpt ? { sequenceExcerpt } : {}),
  };
}

function isValidBuildHash(value: unknown): value is string {
  return isSafeString(value, 160) && SAFE_IDENTIFIER.test(value);
}

export function createEmptyWorkspaceState(buildHash: string): LocalWorkspaceState {
  if (!isValidBuildHash(buildHash)) throw new Error("A valid annotation build hash is required.");
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    buildHash,
    restoreLastView: true,
    recents: [],
    favorites: [],
    notes: {},
  };
}

export function decodeWorkspaceState(raw: string | null, currentBuildHash: string): WorkspaceLoadResult {
  const empty = createEmptyWorkspaceState(currentBuildHash);
  if (raw === null) return { state: empty, status: "missing" };
  if (new TextEncoder().encode(raw).byteLength > MAX_WORKSPACE_BYTES) {
    return { state: empty, status: "invalid" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: empty, status: "invalid" };
  }
  if (!isRecord(value) || value.schemaVersion !== WORKSPACE_SCHEMA_VERSION || !isValidBuildHash(value.buildHash)) {
    return { state: empty, status: "invalid" };
  }
  if (value.buildHash !== currentBuildHash) return { state: empty, status: "build-mismatch" };

  const lastView = normalizedView(value.lastView, currentBuildHash);
  const lastPdfPreset = validatePdfPreset(value.lastPdfPreset, currentBuildHash);
  return {
    status: "ready",
    state: {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      buildHash: currentBuildHash,
      restoreLastView: typeof value.restoreLastView === "boolean" ? value.restoreLastView : true,
      ...(lastView ? { lastView } : {}),
      recents: normalizedReferences(value.recents, MAX_RECENTS),
      favorites: normalizedReferences(value.favorites, MAX_FAVORITES),
      notes: normalizedNotes(value.notes),
      ...(lastPdfPreset ? { lastPdfPreset } : {}),
    },
  };
}

export function parseWorkspaceState(raw: string | null, currentBuildHash: string): LocalWorkspaceState {
  return decodeWorkspaceState(raw, currentBuildHash).state;
}

export function serializeWorkspaceState(state: LocalWorkspaceState): string {
  const candidate = JSON.stringify(state);
  const decoded = decodeWorkspaceState(candidate, state.buildHash);
  if (decoded.status !== "ready") throw new Error("Workspace state is invalid and cannot be saved.");
  const serialized = JSON.stringify(decoded.state);
  if (new TextEncoder().encode(serialized).byteLength > MAX_WORKSPACE_BYTES) {
    throw new Error("Workspace state exceeds the 512 KiB safety limit.");
  }
  return serialized;
}

export function loadWorkspaceState(storage: Pick<WorkspaceStorage, "getItem">, buildHash: string): WorkspaceLoadResult {
  return decodeWorkspaceState(storage.getItem(WORKSPACE_STORAGE_KEY), buildHash);
}

export function saveWorkspaceState(storage: Pick<WorkspaceStorage, "setItem">, state: LocalWorkspaceState): void {
  storage.setItem(WORKSPACE_STORAGE_KEY, serializeWorkspaceState(state));
}

export function clearWorkspaceState(storage: Pick<WorkspaceStorage, "removeItem">): void {
  storage.removeItem(WORKSPACE_STORAGE_KEY);
}

export function createEntityReference(
  input: Omit<EntityReference, "updatedAt"> & { updatedAt?: string },
): EntityReference {
  const normalized = normalizedEntityReference({
    ...input,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  });
  if (!normalized) throw new Error("Entity reference is invalid or exceeds a persistence bound.");
  return normalized;
}

export function entityReferenceKey(reference: Pick<EntityReference, "kind" | "id">): EntityKey {
  return makeEntityKey(reference.kind, reference.id);
}

export function makeEntityKey(kind: WorkspaceEntityKind, identifier: string): EntityKey {
  if ((kind !== "gene" && kind !== "transcript") || !isSafeIdentifier(identifier)) {
    throw new Error("A valid gene or transcript identifier is required.");
  }
  return `${kind}:${stableBaseIdentifier(identifier)}`;
}

export function parseEntityKey(value: string): EntityKey | undefined {
  const separator = value.indexOf(":");
  if (separator < 1) return undefined;
  const kind = value.slice(0, separator);
  const identifier = value.slice(separator + 1);
  if ((kind !== "gene" && kind !== "transcript") || !isSafeIdentifier(identifier)) return undefined;
  return makeEntityKey(kind, identifier);
}

export function addRecentEntity(
  current: readonly EntityReference[],
  reference: EntityReference,
): EntityReference[] {
  const normalized = createEntityReference(reference);
  const key = entityReferenceKey(normalized);
  return [normalized, ...current.filter((item) => entityReferenceKey(item) !== key)].slice(0, MAX_RECENTS);
}

export function addFavoriteEntity(
  current: readonly EntityReference[],
  reference: EntityReference,
): EntityReference[] {
  const normalized = createEntityReference(reference);
  const key = entityReferenceKey(normalized);
  const existingIndex = current.findIndex((item) => entityReferenceKey(item) === key);
  if (existingIndex >= 0) {
    return current.map((item, index) => index === existingIndex ? normalized : item);
  }
  if (current.length >= MAX_FAVORITES) return current.slice(0, MAX_FAVORITES);
  return [...current, normalized];
}

export function removeFavoriteEntity(
  current: readonly EntityReference[],
  kind: WorkspaceEntityKind,
  identifier: string,
): EntityReference[] {
  const key = makeEntityKey(kind, identifier);
  return current.filter((item) => entityReferenceKey(item) !== key);
}

export function toggleFavoriteEntity(
  current: readonly EntityReference[],
  reference: EntityReference,
): EntityReference[] {
  const key = entityReferenceKey(reference);
  return current.some((item) => entityReferenceKey(item) === key)
    ? current.filter((item) => entityReferenceKey(item) !== key)
    : addFavoriteEntity(current, reference);
}

export function createUserAnnotation(
  note: string,
  tags: readonly string[],
  updatedAt = new Date().toISOString(),
): UserAnnotation {
  const annotation = normalizedUserAnnotation({ note, tags: [...tags], updatedAt });
  if (!annotation) throw new Error("User annotation is invalid or exceeds a persistence bound.");
  return annotation;
}

export function setUserAnnotation(
  current: Partial<Record<EntityKey, UserAnnotation>>,
  key: EntityKey,
  annotation: UserAnnotation,
): Partial<Record<EntityKey, UserAnnotation>> {
  const normalizedKey = parseEntityKey(key);
  const normalized = normalizedUserAnnotation(annotation);
  if (!normalizedKey || !normalized) throw new Error("User annotation is invalid or exceeds a persistence bound.");
  const result = normalizedNotes(current);
  if (!(normalizedKey in result) && Object.keys(result).length >= MAX_USER_ANNOTATIONS) {
    throw new Error(`Local notes are limited to ${MAX_USER_ANNOTATIONS} entities.`);
  }
  result[normalizedKey] = normalized;
  return result;
}

export function removeUserAnnotation(
  current: Partial<Record<EntityKey, UserAnnotation>>,
  key: EntityKey,
): Partial<Record<EntityKey, UserAnnotation>> {
  const normalizedKey = parseEntityKey(key);
  if (!normalizedKey) return normalizedNotes(current);
  const result = normalizedNotes(current);
  delete result[normalizedKey];
  return result;
}

function sameAnnotationContent(left: UserAnnotation, right: UserAnnotation): boolean {
  return left.note === right.note
    && left.tags.length === right.tags.length
    && left.tags.every((tag, index) => tag === right.tags[index]);
}

export function mergeImportedAnnotations(
  local: Partial<Record<EntityKey, UserAnnotation>>,
  imported: Partial<Record<EntityKey, UserAnnotation>>,
): AnnotationMergeResult {
  const notes = normalizedNotes(local);
  const incoming = normalizedNotes(imported);
  const added: EntityKey[] = [];
  const replaced: EntityKey[] = [];
  const preservedLocal: EntityKey[] = [];

  for (const [rawKey, importedAnnotation] of Object.entries(incoming)) {
    const key = parseEntityKey(rawKey);
    if (!key || !importedAnnotation) continue;
    const localAnnotation = notes[key];
    if (!localAnnotation) {
      if (Object.keys(notes).length >= MAX_USER_ANNOTATIONS) break;
      notes[key] = importedAnnotation;
      added.push(key);
      continue;
    }
    if (Date.parse(importedAnnotation.updatedAt) > Date.parse(localAnnotation.updatedAt)) {
      notes[key] = importedAnnotation;
      replaced.push(key);
    } else if (!sameAnnotationContent(localAnnotation, importedAnnotation)) {
      preservedLocal.push(key);
    }
  }

  return { notes, added, replaced, preservedLocal };
}

export function withLastView(
  state: LocalWorkspaceState,
  view: BrowserViewState | undefined,
): LocalWorkspaceState {
  if (!view) {
    const { lastView: _discarded, ...rest } = state;
    return rest;
  }
  const normalized = normalizedView(view, state.buildHash);
  if (!normalized) throw new Error("The browser view is invalid or belongs to another annotation build.");
  return { ...state, lastView: normalized };
}

export function withLastPdfPreset(
  state: LocalWorkspaceState,
  preset: PdfPreset | undefined,
): LocalWorkspaceState {
  if (!preset) {
    const { lastPdfPreset: _discarded, ...rest } = state;
    return rest;
  }
  const normalized = validatePdfPreset(preset, state.buildHash);
  if (!normalized) throw new Error("The PDF preset is invalid or belongs to another annotation build.");
  return { ...state, lastPdfPreset: normalized };
}
