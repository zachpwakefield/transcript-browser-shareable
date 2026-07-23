import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ANNOTATION_AUTOSAVE_DELAY_MS,
  LocalAnnotationsEditor,
  validateLocalAnnotationDraft,
} from "../src/components/LocalAnnotationsEditor";
import { WorkspaceEntityMenu } from "../src/components/WorkspaceEntityMenu";
import {
  MAX_FAVORITES,
  MAX_NOTE_CHARACTERS,
  MAX_RECENTS,
  MAX_TAG_CHARACTERS,
  MAX_TAGS_PER_ENTITY,
  createEntityReference,
  type EntityKey,
  type EntityReference,
} from "../src/lib/workspaceStore";

const UPDATED_AT = "2026-07-14T12:00:00.000Z";

function gene(index: number, label = `Gene-${index}`): EntityReference {
  return createEntityReference({
    kind: "gene",
    id: `ENSG${String(index).padStart(11, "0")}`,
    label,
    updatedAt: UPDATED_AT,
  });
}

function transcript(index: number, label = `Transcript-${index}`): EntityReference {
  return createEntityReference({
    kind: "transcript",
    id: `ENST${String(index).padStart(11, "0")}`,
    versionedId: `ENST${String(index).padStart(11, "0")}.2`,
    geneId: "ENSG00000000001",
    geneSymbol: "SP1",
    label,
    updatedAt: UPDATED_AT,
  });
}

test("WorkspaceEntityMenu exposes gene/transcript recents, favorites, navigation, and current toggles", () => {
  const currentGene = gene(1, "SP1");
  const currentTranscript = transcript(1, "SP1-201");
  const html = renderToStaticMarkup(createElement(WorkspaceEntityMenu, {
    recents: [currentTranscript, currentGene],
    favorites: [currentGene],
    currentGene,
    currentTranscript,
    onNavigateEntity: () => undefined,
    onToggleFavorite: () => undefined,
  }));

  assert.match(html, /<details class="workspace-entity-menu"/);
  assert.match(html, /data-favorite-count="1"/);
  assert.match(html, /data-recent-count="2"/);
  assert.match(html, /aria-label="Remove current gene SP1 from favorites"/);
  assert.match(html, /aria-label="Add current transcript SP1-201 to favorites"/);
  assert.match(html, /aria-label="Open recent transcript SP1-201, ENST00000000001\.2"/);
  assert.match(html, /aria-label="Open recent gene SP1, ENSG00000000001"/);
  assert.match(html, /Remove SP1 gene from favorites/);
  assert.match(html, /Add SP1-201 transcript to favorites/);
  assert.match(html, /Transcript · SP1-201/);
});

test("WorkspaceEntityMenu applies workspace persistence bounds before rendering", () => {
  const favorites = Array.from({ length: MAX_FAVORITES + 3 }, (_, index) => transcript(index));
  const recents = Array.from({ length: MAX_RECENTS + 3 }, (_, index) => gene(index));
  const html = renderToStaticMarkup(createElement(WorkspaceEntityMenu, {
    favorites,
    recents,
    onNavigateEntity: () => undefined,
    onToggleFavorite: () => undefined,
  }));

  assert.match(html, new RegExp(`data-favorite-count="${MAX_FAVORITES}"`));
  assert.match(html, new RegExp(`data-recent-count="${MAX_RECENTS}"`));
  assert.match(html, new RegExp(`Transcript-${MAX_FAVORITES - 1}`));
  assert.doesNotMatch(html, new RegExp(`Transcript-${MAX_FAVORITES}(?:<|,|\")`));
  assert.match(html, new RegExp(`Gene-${MAX_RECENTS - 1}`));
  assert.doesNotMatch(html, new RegExp(`Gene-${MAX_RECENTS}(?:<|,|\")`));
});

test("local annotation validation delegates normalization to workspace helpers", () => {
  const valid = validateLocalAnnotationDraft(
    "transcript:ENST00000000001",
    "Private interpretation",
    [" review ", "High-confidence"],
  );
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.annotation?.note, "Private interpretation");
  assert.deepEqual(valid.annotation?.tags, ["review", "High-confidence"]);
  assert.ok(Number.isFinite(Date.parse(valid.annotation?.updatedAt ?? "")));

  const invalid = validateLocalAnnotationDraft(
    "gene:" as EntityKey,
    "🙂".repeat(MAX_NOTE_CHARACTERS + 1),
    [
      "duplicate",
      "DUPLICATE",
      "",
      "x".repeat(MAX_TAG_CHARACTERS + 1),
      ...Array.from({ length: MAX_TAGS_PER_ENTITY - 3 }, (_, index) => `tag-${index}`),
    ],
  );
  assert.equal(invalid.valid, false);
  assert.equal(invalid.annotation, undefined);
  assert.ok(invalid.errors.some((error) => error.includes("valid gene or transcript")));
  assert.ok(invalid.errors.some((error) => error.includes("character limit")));
  assert.ok(invalid.errors.some((error) => error.includes("at most")));
  assert.ok(invalid.errors.some((error) => error.includes("duplicates")));
  assert.ok(invalid.errors.some((error) => error.includes("is empty")));
});

test("LocalAnnotationsEditor renders a controlled, bounded editor and explicit delete", () => {
  const html = renderToStaticMarkup(createElement(LocalAnnotationsEditor, {
    entityKey: "gene:ENSG00000000001",
    entityLabel: "SP1",
    note: "Review this locus",
    tags: ["review", "priority"],
    hasSavedAnnotation: true,
    updatedAt: UPDATED_AT,
    onNoteChange: () => undefined,
    onTagsChange: () => undefined,
    onSave: () => undefined,
    onDelete: () => undefined,
  }));

  assert.match(html, /data-entity-key="gene:ENSG00000000001"/);
  assert.match(html, /data-annotation-status="idle"/);
  assert.match(html, /<textarea[^>]*>Review this locus<\/textarea>/);
  assert.match(html, new RegExp(`17 / ${MAX_NOTE_CHARACTERS.toLocaleString()} characters`));
  assert.match(html, new RegExp(`Local user tags <small>2 / ${MAX_TAGS_PER_ENTITY}</small>`));
  assert.match(html, /aria-label="Tag 1"/);
  assert.match(html, /aria-label="Remove tag review"/);
  assert.match(html, /aria-label="Delete local annotation for SP1"/);
  assert.match(html, />Delete annotation<\/button>/);
  assert.match(html, /Last saved 2026-07-14T12:00:00\.000Z/);
});

test("LocalAnnotationsEditor surfaces invalid controlled drafts and has a 500ms callback autosave contract", () => {
  assert.equal(ANNOTATION_AUTOSAVE_DELAY_MS, 500);
  const html = renderToStaticMarkup(createElement(LocalAnnotationsEditor, {
    entityKey: "transcript:ENST00000000001",
    entityLabel: "SP1-201",
    note: "",
    tags: ["", "valid"],
    hasSavedAnnotation: false,
    onNoteChange: () => undefined,
    onTagsChange: () => undefined,
    onSave: () => undefined,
    onDelete: () => undefined,
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Tag 1 is empty\./);
  assert.match(html, /Delete annotation/);
  assert.match(html, /disabled=""/);

  const source = readFileSync(new URL("../src/components/LocalAnnotationsEditor.tsx", import.meta.url), "utf8");
  assert.match(source, /window\.setTimeout\([\s\S]*ANNOTATION_AUTOSAVE_DELAY_MS/);
  assert.match(source, /window\.clearTimeout/);
  assert.match(source, /saveCallback\.current\(entityKey, annotation\)/);
  assert.match(source, /deleteCallback\.current\(entityKey\)/);
  assert.match(source, /onNoteChange\(event\.target\.value\)/);
  assert.match(source, /onTagsChange\(next\)/);
});
