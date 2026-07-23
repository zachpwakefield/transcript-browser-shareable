import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VIEW_STATE } from "../src/data/sp1.ts";
import { MAX_EXPANDED_TRANSCRIPTS } from "../src/lib/navigation.ts";
import {
  MAX_FAVORITES,
  MAX_NOTE_CHARACTERS,
  MAX_RECENTS,
  MAX_TAG_CHARACTERS,
  MAX_TAGS_PER_ENTITY,
  WORKSPACE_STORAGE_KEY,
  addFavoriteEntity,
  addRecentEntity,
  clearWorkspaceState,
  createEmptyWorkspaceState,
  createEntityReference,
  createUserAnnotation,
  decodeWorkspaceState,
  loadWorkspaceState,
  makeEntityKey,
  mergeImportedAnnotations,
  parseWorkspaceState,
  saveWorkspaceState,
  serializeWorkspaceState,
  setUserAnnotation,
  toggleFavoriteEntity,
  validatePdfPreset,
  withLastPdfPreset,
  withLastView,
  type EntityReference,
  type PdfPreset,
  type UserAnnotation,
  type WorkspaceStorage,
} from "../src/lib/workspaceStore.ts";

const BUILD = DEFAULT_VIEW_STATE.buildHash;

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

function reference(index: number, kind: "gene" | "transcript" = "transcript"): EntityReference {
  return createEntityReference({
    kind,
    id: kind === "gene" ? `ENSG${String(index).padStart(11, "0")}` : `ENST${String(index).padStart(11, "0")}`,
    label: `${kind} ${index}`,
    geneId: kind === "transcript" ? "ENSG00000000001" : undefined,
    geneSymbol: "EXAMPLE",
    updatedAt: timestamp(index % 60),
  });
}

test("workspace state round-trips a validated, build-scoped view and PDF preset", () => {
  const base = createEmptyWorkspaceState(BUILD);
  const noteKey = makeEntityKey("transcript", "ENST00000327443.2");
  const note = createUserAnnotation("Candidate isoform", ["reviewed", "candidate"], timestamp(1));
  const preset: PdfPreset = {
    buildHash: BUILD,
    scope: "selected_comparison",
    sections: ["summary", "structure", "features"],
    featureSources: ["interpro", "pfam"],
    structureScope: "full",
    updatedAt: timestamp(2),
  };
  const state = withLastPdfPreset(withLastView({
    ...base,
    restoreLastView: false,
    recents: [reference(1)],
    favorites: [reference(2)],
    notes: setUserAnnotation({}, noteKey, note),
  }, { ...DEFAULT_VIEW_STATE, comparisonTranscriptId: "" }), preset);

  const serialized = serializeWorkspaceState(state);
  const loaded = decodeWorkspaceState(serialized, BUILD);
  assert.equal(loaded.status, "ready");
  assert.deepEqual(loaded.state, state);
  assert.equal(parseWorkspaceState(serialized, BUILD).lastView?.comparisonTranscriptId, "");
  assert.equal(Object.keys(loaded.state.notes)[0], "transcript:ENST00000327443");
});

test("persisted multi-expansion state is validated and capped before restoration", () => {
  const expandedTranscriptIds = Array.from(
    { length: MAX_EXPANDED_TRANSCRIPTS + 4 },
    (_, index) => `ENST${String(index).padStart(11, "0")}`,
  );
  const payload = {
    ...createEmptyWorkspaceState(BUILD),
    lastView: { ...DEFAULT_VIEW_STATE, expandedTranscriptIds },
  };
  const loaded = decodeWorkspaceState(JSON.stringify(payload), BUILD);
  assert.equal(loaded.status, "ready");
  assert.deepEqual(loaded.state.lastView?.expandedTranscriptIds, expandedTranscriptIds.slice(0, MAX_EXPANDED_TRANSCRIPTS));
});

test("missing, corrupt, unsupported, oversized, and mismatched workspaces fail to an empty current-build state", () => {
  assert.equal(decodeWorkspaceState(null, BUILD).status, "missing");
  assert.equal(decodeWorkspaceState("{", BUILD).status, "invalid");
  assert.equal(decodeWorkspaceState(JSON.stringify({ schemaVersion: 2, buildHash: BUILD }), BUILD).status, "invalid");
  assert.equal(decodeWorkspaceState("x".repeat(513 * 1024), BUILD).status, "invalid");

  const mismatch = decodeWorkspaceState(JSON.stringify({ schemaVersion: 1, buildHash: "other-build" }), BUILD);
  assert.equal(mismatch.status, "build-mismatch");
  assert.deepEqual(mismatch.state, createEmptyWorkspaceState(BUILD));
});

test("valid top-level workspaces salvage bounded valid entries and discard invalid nested data", () => {
  const recents = Array.from({ length: MAX_RECENTS + 8 }, (_, index) => reference(index));
  recents.splice(1, 0, { ...recents[0], label: "duplicate" });
  const favorites = Array.from({ length: MAX_FAVORITES + 8 }, (_, index) => reference(index, "gene"));
  const validKey = makeEntityKey("gene", "ENSG00000000001");
  const invalidKey = makeEntityKey("transcript", "ENST00000000002");
  const payload = {
    schemaVersion: 1,
    buildHash: BUILD,
    restoreLastView: "yes",
    lastView: { ...DEFAULT_VIEW_STATE, selectedGeneId: "contains spaces" },
    recents,
    favorites,
    notes: {
      [validKey]: createUserAnnotation("valid", ["tag"], timestamp(1)),
      [invalidKey]: { note: "x".repeat(MAX_NOTE_CHARACTERS + 1), tags: [], updatedAt: timestamp(2) },
      "bad-key": createUserAnnotation("ignored", [], timestamp(3)),
    },
    lastPdfPreset: { buildHash: BUILD, scope: "unbounded" },
  };
  const loaded = decodeWorkspaceState(JSON.stringify(payload), BUILD);
  assert.equal(loaded.status, "ready");
  assert.equal(loaded.state.restoreLastView, true);
  assert.equal(loaded.state.lastView, undefined);
  assert.equal(loaded.state.recents.length, MAX_RECENTS);
  assert.equal(loaded.state.recents[0].label, recents[0].label);
  assert.equal(loaded.state.favorites.length, MAX_FAVORITES);
  assert.deepEqual(Object.keys(loaded.state.notes), [validKey]);
  assert.equal(loaded.state.lastPdfPreset, undefined);
});

test("recents move to the front while favorites retain insertion order and both remain bounded", () => {
  let recents: EntityReference[] = [];
  for (let index = 0; index < MAX_RECENTS + 5; index += 1) recents = addRecentEntity(recents, reference(index));
  assert.equal(recents.length, MAX_RECENTS);
  assert.equal(recents[0].id, reference(MAX_RECENTS + 4).id);
  const revisited = { ...recents.at(-1)!, label: "revisited", updatedAt: timestamp(59) };
  recents = addRecentEntity(recents, revisited);
  assert.equal(recents[0].label, "revisited");
  assert.equal(new Set(recents.map((item) => item.id)).size, recents.length);

  let favorites: EntityReference[] = [];
  for (let index = 0; index < MAX_FAVORITES + 5; index += 1) favorites = addFavoriteEntity(favorites, reference(index));
  assert.equal(favorites.length, MAX_FAVORITES);
  const originalSecondId = favorites[1].id;
  favorites = addFavoriteEntity(favorites, { ...favorites[1], label: "updated" });
  assert.equal(favorites[1].id, originalSecondId);
  assert.equal(favorites[1].label, "updated");
  favorites = toggleFavoriteEntity(favorites, favorites[1]);
  assert.equal(favorites.some((item) => item.id === originalSecondId), false);
});

test("entity references deduplicate versioned Ensembl identifiers by stable base ID", () => {
  const first = createEntityReference({
    kind: "transcript",
    id: "ENST00000327443.1",
    versionedId: "ENST00000327443.1",
    label: "first",
    updatedAt: timestamp(1),
  });
  const second = createEntityReference({
    kind: "transcript",
    id: "ENST00000327443.2",
    versionedId: "ENST00000327443.2",
    label: "second",
    updatedAt: timestamp(2),
  });
  const recents = addRecentEntity(addRecentEntity([], first), second);
  assert.equal(recents.length, 1);
  assert.equal(recents[0].id, "ENST00000327443");
  assert.equal(recents[0].label, "second");
});

test("user annotation validation enforces note and tag limits without truncating content", () => {
  assert.equal(createUserAnnotation("x".repeat(MAX_NOTE_CHARACTERS), ["x".repeat(MAX_TAG_CHARACTERS)]).note.length, MAX_NOTE_CHARACTERS);
  assert.throws(() => createUserAnnotation("x".repeat(MAX_NOTE_CHARACTERS + 1), []), /persistence bound/);
  assert.throws(
    () => createUserAnnotation("note", Array.from({ length: MAX_TAGS_PER_ENTITY + 1 }, (_, index) => `tag${index}`)),
    /persistence bound/,
  );
  assert.throws(() => createUserAnnotation("note", ["x".repeat(MAX_TAG_CHARACTERS + 1)]), /persistence bound/);
  assert.throws(() => createUserAnnotation("note", ["same", " SAME "]), /persistence bound/);
  assert.throws(() => createUserAnnotation("note", [], "tomorrow"), /persistence bound/);
});

test("imported annotations add missing and newer values but explicitly preserve newer local content", () => {
  const preservedKey = makeEntityKey("gene", "ENSG00000000001");
  const replacedKey = makeEntityKey("transcript", "ENST00000000002");
  const addedKey = makeEntityKey("transcript", "ENST00000000003");
  const local: Partial<Record<typeof preservedKey | typeof replacedKey, UserAnnotation>> = {
    [preservedKey]: createUserAnnotation("newer local", ["local"], timestamp(5)),
    [replacedKey]: createUserAnnotation("older local", [], timestamp(1)),
  };
  const imported = {
    [preservedKey]: createUserAnnotation("older import", [], timestamp(2)),
    [replacedKey]: createUserAnnotation("newer import", ["imported"], timestamp(6)),
    [addedKey]: createUserAnnotation("new entity", [], timestamp(3)),
  };
  const merged = mergeImportedAnnotations(local, imported);
  assert.equal(merged.notes[preservedKey]?.note, "newer local");
  assert.equal(merged.notes[replacedKey]?.note, "newer import");
  assert.equal(merged.notes[addedKey]?.note, "new entity");
  assert.deepEqual(merged.preservedLocal, [preservedKey]);
  assert.deepEqual(merged.replaced, [replacedKey]);
  assert.deepEqual(merged.added, [addedKey]);
});

test("PDF presets are build-scoped and enforce existing section, source, and sequence shapes", () => {
  const valid = {
    buildHash: BUILD,
    scope: "selected_pinned",
    sections: ["summary", "sequence"],
    featureSources: ["interpro"],
    structureScope: "current_locus",
    sequenceExcerpt: { kind: "protein", start1: 1, end1: 10_000 },
    updatedAt: timestamp(1),
  };
  assert.deepEqual(validatePdfPreset(valid, BUILD), valid);
  assert.equal(validatePdfPreset({ ...valid, buildHash: "other-build" }, BUILD), undefined);
  assert.equal(validatePdfPreset({ ...valid, sections: ["unknown"] }, BUILD), undefined);
  assert.equal(validatePdfPreset({ ...valid, featureSources: ["unknown"] }, BUILD), undefined);
  assert.equal(
    validatePdfPreset({ ...valid, sequenceExcerpt: { kind: "protein", start1: 1, end1: 10_001 } }, BUILD),
    undefined,
  );
  assert.equal(validatePdfPreset({ ...valid, sections: ["summary"] }, BUILD), undefined);
});

test("storage adapters use one namespaced key and clear it explicitly", () => {
  const values = new Map<string, string>();
  const storage: WorkspaceStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const state = createEmptyWorkspaceState(BUILD);
  saveWorkspaceState(storage, state);
  assert.equal(values.has(WORKSPACE_STORAGE_KEY), true);
  assert.deepEqual(loadWorkspaceState(storage, BUILD), { status: "ready", state });
  clearWorkspaceState(storage);
  assert.equal(values.has(WORKSPACE_STORAGE_KEY), false);
});
