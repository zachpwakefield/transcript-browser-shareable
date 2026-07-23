import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VIEW_STATE } from "../src/data/sp1.ts";
import {
  MAX_SESSION_BYTES,
  SESSION_FORMAT,
  encodeSession,
  parsePortableSession,
  parseSession,
} from "../src/lib/session.ts";
import {
  encodeViewState,
  hasExplicitViewState,
  parseViewState,
} from "../src/lib/urlState.ts";
import { chooseInitialView } from "../src/lib/viewRestore.ts";
import { MAX_EXPANDED_TRANSCRIPTS } from "../src/lib/navigation.ts";
import {
  MAX_USER_ANNOTATIONS,
  createEmptyWorkspaceState,
  createUserAnnotation,
  makeEntityKey,
  type EntityKey,
  type UserAnnotation,
} from "../src/lib/workspaceStore.ts";
import type { BrowserViewState } from "../src/types.ts";

const BUILD = DEFAULT_VIEW_STATE.buildHash;

function view(overrides: Partial<BrowserViewState> = {}): BrowserViewState {
  return { ...DEFAULT_VIEW_STATE, selectedFeatureId: undefined, ...overrides };
}

function v1Session(state: BrowserViewState): string {
  return JSON.stringify({
    format: SESSION_FORMAT,
    version: 1,
    buildHash: state.buildHash,
    urlState: encodeViewState(state),
  });
}

test("explicit view URL state always wins over automatic last-view restoration", () => {
  const saved = view({
    selectedGeneId: "ENSG00000000002",
    selectedTranscriptId: "ENST00000000002",
    comparisonTranscriptId: "ENST00000000003",
  });
  const explicit = view({
    selectedGeneId: "ENSG00000000004",
    selectedTranscriptId: "ENST00000000004",
    comparisonTranscriptId: "",
  });
  const workspace = { ...createEmptyWorkspaceState(BUILD), lastView: saved };

  const search = encodeViewState(explicit);
  assert.equal(hasExplicitViewState(search), true);
  assert.deepEqual(chooseInitialView(search, explicit, workspace), {
    view: explicit,
    restoredLastView: false,
  });

  // Unrelated query parameters do not suppress restoration because they do not
  // describe browser state.
  assert.equal(hasExplicitViewState("?supportPanel=1"), false);
  assert.deepEqual(chooseInitialView("?supportPanel=1", explicit, workspace), {
    view: saved,
    restoredLastView: true,
  });
});

test("restore-disabled and no-last-view workspaces keep the URL/default view", () => {
  const current = view({ selectedGeneId: "ENSG00000000004" });
  const saved = view({ selectedGeneId: "ENSG00000000005" });
  const disabled = {
    ...createEmptyWorkspaceState(BUILD),
    restoreLastView: false,
    lastView: saved,
  };
  assert.deepEqual(chooseInitialView("", current, disabled), {
    view: current,
    restoredLastView: false,
  });

  const noLast = createEmptyWorkspaceState(BUILD);
  assert.deepEqual(chooseInitialView("", current, noLast), {
    view: current,
    restoredLastView: false,
  });
  assert.deepEqual(chooseInitialView("", current, { ...noLast, lastView: saved }), {
    view: saved,
    restoredLastView: true,
  });
});

test("comparison transcript state round-trips through compareTx URL state", () => {
  const state = view({
    selectedTranscriptId: "ENST00000327443",
    comparisonTranscriptId: "ENST00000426431",
    inspectorTab: "compare",
  });
  const encoded = encodeViewState(state);
  assert.match(encoded, /(?:^|&)compareTx=ENST00000426431(?:&|$)/);
  assert.equal(hasExplicitViewState("?compareTx=ENST00000426431"), true);
  assert.deepEqual(parseViewState(encoded, DEFAULT_VIEW_STATE), state);

  const withoutComparison = view({ comparisonTranscriptId: "", inspectorTab: "transcript" });
  const encodedEmpty = encodeViewState(withoutComparison);
  assert.doesNotMatch(encodedEmpty, /compareTx=/);
  assert.deepEqual(parseViewState(encodedEmpty, DEFAULT_VIEW_STATE), withoutComparison);
});

test("multiple expansions round-trip while imported URL demand remains bounded", () => {
  const expandedTranscriptIds = [
    "ENST00000327443",
    "ENST00000426431",
    "ENST00000548560",
  ];
  const state = view({ expandedTranscriptIds, displayMode: "expanded" });
  assert.deepEqual(parseViewState(encodeViewState(state), DEFAULT_VIEW_STATE).expandedTranscriptIds, expandedTranscriptIds);
  assert.deepEqual(parseViewState("?mode=expanded&expanded=", DEFAULT_VIEW_STATE).expandedTranscriptIds, []);

  const oversized = Array.from({ length: MAX_EXPANDED_TRANSCRIPTS + 7 }, (_, index) => `ENST${String(index).padStart(11, "0")}`);
  const parsed = parseViewState(`?mode=expanded&expanded=${oversized.join(",")}`, DEFAULT_VIEW_STATE);
  assert.deepEqual(parsed.expandedTranscriptIds, oversized.slice(0, MAX_EXPANDED_TRANSCRIPTS));
});

test("comparison state and annotations round-trip through v2 while v1 remains readable", () => {
  const state = view({
    selectedTranscriptId: "ENST00000327443",
    comparisonTranscriptId: "ENST00000426431",
    inspectorTab: "compare",
    pinnedTranscriptIds: ["ENST00000548560"],
  });
  const key = makeEntityKey("transcript", state.selectedTranscriptId);
  const annotations: Partial<Record<EntityKey, UserAnnotation>> = {
    [key]: createUserAnnotation(
      "Local interpretation, not source evidence.",
      ["reviewed", "candidate"],
      "2026-07-14T12:00:00.000Z",
    ),
  };

  const encodedV2 = encodeSession(state, annotations);
  const parsedV2 = parsePortableSession(encodedV2, DEFAULT_VIEW_STATE, BUILD);
  assert.deepEqual(parsedV2, { view: state, annotations });
  assert.deepEqual(parseSession(encodedV2, DEFAULT_VIEW_STATE, BUILD), state);

  const parsedV1 = parsePortableSession(v1Session(state), DEFAULT_VIEW_STATE, BUILD);
  assert.deepEqual(parsedV1, { view: state, annotations: {} });

  // A pre-comparison v1 URL inherits the empty compatibility default rather
  // than inventing a comparison transcript.
  const oldUrl = new URLSearchParams(encodeViewState(state).slice(1));
  oldUrl.delete("compareTx");
  const oldV1 = JSON.stringify({
    format: SESSION_FORMAT,
    version: 1,
    buildHash: BUILD,
    urlState: `?${oldUrl.toString()}`,
  });
  assert.equal(parsePortableSession(oldV1, DEFAULT_VIEW_STATE, BUILD).view.comparisonTranscriptId, "");
});

test("portable-session annotations reject invalid keys, values, and entity overflow", async (t) => {
  const state = view();
  const base = {
    format: SESSION_FORMAT,
    version: 2,
    buildHash: BUILD,
    urlState: encodeViewState(state),
  };
  const validTimestamp = "2026-07-14T12:00:00.000Z";
  const cases: Array<{ name: string; annotations: unknown; pattern: RegExp }> = [
    {
      name: "non-object annotation collection",
      annotations: [],
      pattern: /annotations must be one object/,
    },
    {
      name: "unsupported entity key",
      annotations: { "protein:ENSP00000000001": { note: "x", tags: [], updatedAt: validTimestamp } },
      pattern: /invalid local annotation/,
    },
    {
      name: "oversized note",
      annotations: { "gene:ENSG00000000001": { note: "x".repeat(5_001), tags: [], updatedAt: validTimestamp } },
      pattern: /persistence bound/,
    },
    {
      name: "too many tags",
      annotations: {
        "gene:ENSG00000000001": {
          note: "x",
          tags: Array.from({ length: 11 }, (_, index) => `tag-${index}`),
          updatedAt: validTimestamp,
        },
      },
      pattern: /persistence bound/,
    },
    {
      name: "invalid timestamp",
      annotations: { "gene:ENSG00000000001": { note: "x", tags: [], updatedAt: "tomorrow" } },
      pattern: /persistence bound/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      assert.throws(
        () => parsePortableSession(JSON.stringify({ ...base, annotations: item.annotations }), DEFAULT_VIEW_STATE, BUILD),
        item.pattern,
      );
    });
  }

  const tooMany = Object.fromEntries(Array.from({ length: MAX_USER_ANNOTATIONS + 1 }, (_, index) => [
    `transcript:ENST${String(index).padStart(11, "0")}`,
    { note: "", tags: [], updatedAt: validTimestamp },
  ]));
  assert.throws(
    () => parsePortableSession(JSON.stringify({ ...base, annotations: tooMany }), DEFAULT_VIEW_STATE, BUILD),
    new RegExp(`${MAX_USER_ANNOTATIONS}-entity limit`),
  );
});

test("portable sessions enforce declared/encoded build agreement and the 512 KiB byte bound", () => {
  const state = view({ comparisonTranscriptId: "ENST00000426431" });
  const encoded = encodeSession(state);
  assert.throws(
    () => parsePortableSession(encoded, DEFAULT_VIEW_STATE, "different-build"),
    /Session requires build/,
  );

  const mismatchedUrl = encodeViewState({ ...state, buildHash: "different-build" });
  assert.throws(
    () => parsePortableSession(JSON.stringify({
      format: SESSION_FORMAT,
      version: 2,
      buildHash: BUILD,
      urlState: mismatchedUrl,
      annotations: {},
    }), DEFAULT_VIEW_STATE, BUILD),
    /metadata and encoded view disagree/,
  );

  assert.equal(MAX_SESSION_BYTES, 512 * 1024);
  const oversized = JSON.stringify({
    format: SESSION_FORMAT,
    version: 2,
    buildHash: BUILD,
    urlState: encodeViewState(state),
    annotations: {},
    padding: "x".repeat(MAX_SESSION_BYTES),
  });
  assert.ok(new TextEncoder().encode(oversized).byteLength > MAX_SESSION_BYTES);
  assert.throws(
    () => parsePortableSession(oversized, DEFAULT_VIEW_STATE, BUILD),
    /512 KiB safety limit/,
  );
});
