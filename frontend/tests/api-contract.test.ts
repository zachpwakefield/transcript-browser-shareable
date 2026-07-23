import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDetailedTranscript, normalizeFeaturePayload, normalizeManifest, normalizeRegionPayload, normalizeSearchPayload } from "../src/api.ts";
import type { Transcript } from "../src/types.ts";

test("manifest normalization preserves the immutable build and verified local reference", () => {
  const manifest = normalizeManifest({
    schemaVersion: "1.0.0",
    buildHash: "sha256-build",
    release: "GENCODE v45",
    ensemblRelease: 111,
    assembly: "GRCh38.p14",
    technicalPreview: false,
    featureSources: [{ name: "InterPro", records: 20 }, { name: "Pfam", records: 6 }, { name: "MobiDB-lite", records: 14 }],
    capabilities: { search: true, region: true },
    reference: { available: true, verified: true, kind: "fasta", url: "/reference/genome.fa" },
    coordinateContract: { machine: "0-based half-open", display: "1-based inclusive" },
  });
  assert.equal(manifest.buildHash, "sha256-build");
  assert.equal(manifest.release, "GENCODE v45 · Ensembl 111");
  assert.equal(manifest.referenceAvailable, true);
  assert.equal(manifest.reference?.url, "/reference/genome.fa");
  assert.deepEqual(manifest.featureSources, ["interpro", "pfam", "mobidblite"]);
});

test("manifest normalization keeps a full transcript package valid without a reference", () => {
  const manifest = normalizeManifest({
    schemaVersion: "1.1.0",
    buildHash: "annotation-only-build",
    release: "GENCODE v45",
    ensemblRelease: 111,
    assembly: "GRCh38.p14",
    technicalPreview: false,
    scope: "full",
    featureSources: ["interpro", "pfam"],
    capabilities: { search: true, region: true, reference_ranges: false },
    reference: { available: false, verified: false },
  });
  assert.equal(manifest.technicalPreview, false);
  assert.equal(manifest.referenceAvailable, false);
  assert.equal(manifest.reference?.url, undefined);
});

test("search normalization retains owning gene/transcript identity for cross-gene jumps", () => {
  const results = normalizeSearchPayload({
    results: [{
      kind: "protein",
      id: "ENSP000001",
      versionedId: "ENSP000001.2",
      resolvedVersion: "ENSP000001.2",
      label: "ENSP000001.2",
      chr: "12",
      start0: 100,
      end0: 250,
      geneId: "ENSG000001",
      geneVersionedId: "ENSG000001.5",
      transcriptId: "ENST000001",
      transcriptVersionedId: "ENST000001.3",
    }],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].chrom, "chr12");
  assert.equal(results[0].geneId, "ENSG000001");
  assert.equal(results[0].transcriptId, "ENST000001");
});

test("region normalization accepts release density bins and selected LOD overrides", () => {
  const region = normalizeRegionPayload({
    chr: "12",
    start0: 0,
    end0: 1_000_000,
    requestedDetail: "auto",
    detail: "compact",
    genes: [{
      id: "ENSG1",
      versionedId: "ENSG1.1",
      symbol: "G1",
      chr: "12",
      start0: 100,
      end0: 500,
      strand: "+",
      biotype: "protein_coding",
      transcriptCount: 3,
      inRequestedRegion: false,
      lodOverride: true,
    }],
    transcripts: [{
      id: "ENST1",
      geneId: "ENSG1",
      versionedId: "ENST1.1",
      name: "G1-201",
      chr: "12",
      start0: 100,
      end0: 500,
      strand: "+",
      biotype: "protein_coding",
    }],
    density: {
      available: true,
      tileSize: 262_144,
      bins: [{ start0: 0, end0: 262_144, geneCount: 4, transcriptCount: 17 }],
    },
    truncated: false,
    emptyState: "No annotated gene in the requested region",
    limits: { genes: 1000, transcripts: 5000 },
  }, { chrom: "chr12", start0: 0, end0: 1_000_000 }, "auto");
  assert.equal(region.detail, "compact");
  assert.equal(region.genes[0].id, "ENSG1");
  assert.equal(region.genes[0].inRequestedRegion, false);
  assert.equal(region.genes[0].lodOverride, true);
  assert.equal(region.emptyState, "No annotated gene in the requested region");
  assert.equal(region.transcripts[0].geneId, "ENSG1");
  assert.deepEqual(region.density[0], {
    start0: 0,
    end0: 262_144,
    geneCount: 4,
    transcriptCount: 17,
  });
});

test("transcript normalization anchors fallback amino-acid shading at the first CDS base", () => {
  const transcript = normalizeDetailedTranscript({
    id: "ENST_TEST",
    versionedId: "ENST_TEST.1",
    geneId: "ENSG_TEST",
    name: "TEST-201",
    start0: 1_000,
    end0: 1_300,
    strand: "+",
    biotype: "protein_coding",
    transcriptLength: 300,
    cdsLength: 30,
    proteinLength: 10,
    exons: [{ rank: 1, id: "ENSE_TEST", start0: 1_000, end0: 1_300 }],
    cdsSegments: [{
      exonRank: 1,
      start0: 1_100,
      end0: 1_130,
      transcriptStart0: 100,
      transcriptEnd0: 130,
      phase: 0,
    }],
  });
  assert.ok(transcript);
  assert.equal(transcript.exons[0].aaStart, 1);
  assert.equal(transcript.exons[0].aaEnd, 10);
});

test("feature normalization preserves projection coordinates and local audit provenance", () => {
  const transcript: Transcript = {
    id: "ENST_TEST", versionedId: "ENST_TEST.1", geneId: "ENSG_TEST", name: "TEST-201",
    proteinId: "ENSP_TEST", versionedProteinId: "ENSP_TEST.1", biotype: "protein_coding",
    start0: 1_000, end0: 1_300, strand: "+", transcriptLength: 300, cdsLength: 300,
    proteinLength: 100, tsl: "Not provided", badges: [], tags: [], exons: [], features: [],
  };
  const features = normalizeFeaturePayload({
    mapping: { status: "exact", reason: "Translation agrees with the local protein FASTA." },
    features: [{
      id: "feature-1", source: "Pfam", accession: "PF00001", name: "Primary name",
      altName: "Alternate name", method: "biomaRt", aaStart1: 2, aaEnd1: 4,
      projectionStatus: "exact",
      segments: [{ start0: 1_103, end0: 1_112, exonRank: 2, ntStart0: 3, ntEnd0: 12 }],
      rawAudit: { name: "raw-domain", chr: "chr1", start1: 2, end1: 4, strand: "+", notDrawable: true },
    }],
  }, transcript);
  assert.equal(features.length, 1);
  assert.equal(features[0].altName, "Alternate name");
  assert.equal(features[0].projectionStatus, "exact");
  assert.match(features[0].mappingReason ?? "", /agrees/);
  assert.deepEqual(features[0].segments[0], {
    start0: 1_103, end0: 1_112, exonRank: 2, ntStart0: 3, ntEnd0: 12,
  });
  assert.deepEqual(features[0].rawAudit, {
    name: "raw-domain", chrom: "chr1", start1: 2, end1: 4, strand: "+", notDrawable: true,
  });
});
