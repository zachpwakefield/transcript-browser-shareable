import assert from "node:assert/strict";
import test from "node:test";
import { exactSearchMatches, resolveSubmittedSearch } from "../src/lib/searchResolution";
import type { SearchResult } from "../src/types";

function result(overrides: Partial<SearchResult> & Pick<SearchResult, "kind" | "id" | "label">): SearchResult {
  return {
    chrom: "chr4",
    start0: 100,
    end0: 200,
    ...overrides,
  };
}

test("a unique exact gene symbol wins over child-entity prefix results", () => {
  const gene = result({
    kind: "gene",
    id: "ENSG00000145362",
    versionedId: "ENSG00000145362.15",
    label: "ANK2 · ENSG00000145362.15 · chr4:1-2",
    symbol: "ANK2",
  });
  const transcripts = Array.from({ length: 19 }, (_, index) => result({
    kind: "transcript",
    id: `ENST00000000${String(index).padStart(3, "0")}`,
    label: `ANK2-${201 + index} · ENST00000000${String(index).padStart(3, "0")}.1`,
    symbol: "ANK2",
    geneId: gene.id,
  }));
  const results = [gene, ...transcripts];

  assert.deepEqual(exactSearchMatches("ANK2", results), [gene]);
  assert.deepEqual(resolveSubmittedSearch("ANK2", results), { kind: "navigate", result: gene });
});

test("duplicate exact gene symbols remain ambiguous", () => {
  const first = result({ kind: "gene", id: "ENSG00000000001", label: "DUP", symbol: "DUP" });
  const second = result({ kind: "gene", id: "ENSG00000000002", label: "DUP", symbol: "DUP", chrom: "chr7" });
  const child = result({ kind: "transcript", id: "ENST00000000001", label: "DUP-201", symbol: "DUP" });

  assert.deepEqual(resolveSubmittedSearch("DUP", [first, second, child]), {
    kind: "ambiguous-gene",
    count: 2,
  });
});

test("an exact stable transcript ID still navigates directly", () => {
  const transcript = result({
    kind: "transcript",
    id: "ENST00000357077",
    versionedId: "ENST00000357077.9",
    label: "ANK2-202 · ENST00000357077.9",
    symbol: "ANK2",
  });
  const prefix = result({
    kind: "transcript",
    id: "ENST00000357078",
    versionedId: "ENST00000357078.1",
    label: "ANK2-203 · ENST00000357078.1",
    symbol: "ANK2",
  });

  assert.deepEqual(resolveSubmittedSearch("ENST00000357077.9", [transcript, prefix]), {
    kind: "navigate",
    result: transcript,
  });
});

test("a prefix-only query does not guess a gene", () => {
  const gene = result({ kind: "gene", id: "ENSG00000145362", label: "ANK2", symbol: "ANK2" });
  const transcript = result({ kind: "transcript", id: "ENST00000357077", label: "ANK2-202", symbol: "ANK2" });

  assert.deepEqual(resolveSubmittedSearch("ANK", [gene, transcript]), { kind: "choose", count: 2 });
});

test("an exact versioned gene ID navigates despite other prefix results", () => {
  const gene = result({
    kind: "gene",
    id: "ENSG00000145362",
    versionedId: "ENSG00000145362.15",
    label: "ANK2",
    symbol: "ANK2",
  });
  const other = result({ kind: "gene", id: "ENSG00000145362999", label: "OTHER", symbol: "OTHER" });

  assert.deepEqual(resolveSubmittedSearch("ENSG00000145362.15", [gene, other]), {
    kind: "navigate",
    result: gene,
  });
});
