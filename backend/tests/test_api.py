from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from fastapi.testclient import TestClient

from backend.app.errors import StartupValidationError
from backend.app.main import CONTENT_SECURITY_POLICY, create_app
from backend.app.repository import _feature_json


SCHEMA = """
CREATE TABLE build_manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE contig (name TEXT PRIMARY KEY, length INTEGER, display_order INTEGER, is_primary INTEGER);
CREATE TABLE contig_alias (alias TEXT PRIMARY KEY, contig_name TEXT);
CREATE TABLE gene (gene_id TEXT PRIMARY KEY, gene_id_versioned TEXT, gene_version INTEGER, havana_gene_id TEXT, havana_gene_id_versioned TEXT, havana_gene_version INTEGER, symbol TEXT, hgnc_id TEXT, biotype TEXT, contig TEXT, start0 INTEGER, end0 INTEGER, strand TEXT, bin INTEGER);
CREATE TABLE gene_tag (gene_id TEXT, tag TEXT, ordinal INTEGER, PRIMARY KEY(gene_id, tag, ordinal));
CREATE TABLE transcript (transcript_id TEXT PRIMARY KEY, transcript_id_versioned TEXT, transcript_version INTEGER, havana_transcript_id TEXT, havana_transcript_id_versioned TEXT, havana_transcript_version INTEGER, gene_id TEXT, transcript_name TEXT, biotype TEXT, protein_id TEXT, protein_id_versioned TEXT, contig TEXT, start0 INTEGER, end0 INTEGER, strand TEXT, bin INTEGER, transcript_length INTEGER, cds_length INTEGER, protein_length INTEGER, level INTEGER, tsl TEXT, ccds_id TEXT, appris TEXT, is_basic INTEGER NOT NULL DEFAULT 0, is_mane_select INTEGER NOT NULL DEFAULT 0, is_mane_plus_clinical INTEGER NOT NULL DEFAULT 0, is_ensembl_canonical INTEGER NOT NULL DEFAULT 0);
CREATE TABLE transcript_tag (transcript_id TEXT, tag TEXT, PRIMARY KEY(transcript_id, tag));
CREATE TABLE exon (transcript_id TEXT, exon_rank INTEGER, exon_id TEXT, exon_id_versioned TEXT, start0 INTEGER, end0 INTEGER, PRIMARY KEY(transcript_id, exon_rank));
CREATE TABLE cds_segment (transcript_id TEXT, segment_rank INTEGER, exon_rank INTEGER, start0 INTEGER, end0 INTEGER, transcript_start0 INTEGER, transcript_end0 INTEGER, phase INTEGER, PRIMARY KEY(transcript_id, segment_rank));
CREATE TABLE utr_segment (transcript_id TEXT, segment_rank INTEGER, exon_rank INTEGER, start0 INTEGER, end0 INTEGER, PRIMARY KEY(transcript_id, segment_rank));
CREATE TABLE translation_mapping (transcript_id TEXT PRIMARY KEY, cds_start0 INTEGER, cds_end0 INTEGER, status TEXT, reason TEXT);
CREATE TABLE sequence (transcript_id TEXT, kind TEXT, sequence TEXT, PRIMARY KEY(transcript_id, kind));
CREATE TABLE protein_feature (feature_id TEXT PRIMARY KEY, transcript_id TEXT, protein_id TEXT, source TEXT, accession TEXT, display_name TEXT, alt_name TEXT, method TEXT, aa_start1 INTEGER, aa_end1 INTEGER, raw_name TEXT, raw_chr TEXT, raw_start1 INTEGER, raw_end1 INTEGER, raw_strand TEXT);
CREATE TABLE protein_feature_segment (feature_id TEXT, segment_rank INTEGER, exon_rank INTEGER, start0 INTEGER, end0 INTEGER, nt_start0 INTEGER, nt_end0 INTEGER, PRIMARY KEY(feature_id, segment_rank));
CREATE TABLE search_entity (term_norm TEXT, entity_type TEXT, entity_id TEXT, label TEXT, priority INTEGER);
CREATE VIRTUAL TABLE search_fts USING fts5(label, terms, entity_type UNINDEXED, entity_id UNINDEXED);
CREATE TABLE density_tile (contig TEXT, tile_size INTEGER, tile_start0 INTEGER, tile_end0 INTEGER, gene_count INTEGER, transcript_count INTEGER, PRIMARY KEY(contig, tile_size, tile_start0));
"""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_db(path: Path, *, technical_preview: bool) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(SCHEMA)
    values = {
        "schema_version": "1.1.0",
        "build_hash": "fixture-build-hash",
        "release": "GENCODE v45",
        "ensembl_release": "111",
        "assembly": "GRCh38.p14",
        "technical_preview": "true" if technical_preview else "false",
    }
    connection.executemany(
        "INSERT INTO build_manifest(key,value) VALUES (?,?)", values.items()
    )
    connection.execute("INSERT INTO contig VALUES ('chr12',133275309,12,1)")
    connection.executemany(
        "INSERT INTO contig_alias VALUES (?,?)", [("12", "chr12"), ("CHR12", "chr12")]
    )
    connection.execute(
        "INSERT INTO gene(gene_id,gene_id_versioned,gene_version,symbol,hgnc_id,"
        "biotype,contig,start0,end0,strand,bin) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            "ENSG00000185591",
            "ENSG00000185591.8",
            8,
            "SP1",
            "HGNC:11205",
            "protein_coding",
            "chr12",
            53_300_000,
            53_400_000,
            "+",
            635,
        ),
    )
    connection.execute(
        "INSERT INTO gene_tag VALUES (?,?,?)",
        ("ENSG00000185591", "overlapping_locus", 1),
    )
    transcripts = [
        ("ENST00000327443", "ENST00000327443.9", 9, "SP1-201", "ENSP00000329357", "ENSP00000329357.4", 785),
        ("ENST00000548560", "ENST00000548560.1", 1, "SP1-203", "ENSP00000458133", "ENSP00000458133.1", 230),
    ]
    for index, (tid, versioned, version, name, pid, pver, plen) in enumerate(transcripts):
        start = 53_300_000 + index * 10_000
        connection.execute(
            "INSERT INTO transcript(transcript_id,transcript_id_versioned,transcript_version,"
            "gene_id,transcript_name,biotype,protein_id,protein_id_versioned,contig,start0,"
            "end0,strand,bin,transcript_length,cds_length,protein_length,level,tsl) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (tid, versioned, version, "ENSG00000185591", name, "protein_coding", pid, pver, "chr12", start, start + 1000, "+", 4_681 + (start >> 17), plen * 3 + 100, plen * 3, plen, 2, "1"),
        )
        connection.execute("INSERT INTO transcript_tag VALUES (?,?)", (tid, "basic"))
        connection.execute("INSERT INTO exon VALUES (?,?,?,?,?,?)", (tid, 1, f"ENSE{index+1:011d}", f"ENSE{index+1:011d}.1", start, start + 1000))
        connection.execute("INSERT INTO cds_segment VALUES (?,?,?,?,?,?,?,?)", (tid, 1, 1, start + 100, start + 700, 100, 700, 0))
        connection.execute("INSERT INTO utr_segment VALUES (?,?,?,?,?)", (tid, 1, 1, start, start + 100))
        connection.execute("INSERT INTO translation_mapping VALUES (?,?,?,?,?)", (tid, 100, 100 + plen * 3, "exact", None))
        connection.execute("INSERT INTO sequence VALUES (?,?,?)", (tid, "protein", "M" * plen))
    connection.execute("INSERT INTO transcript_tag VALUES (?,?)", ("ENST00000327443", "MANE_Select"))
    connection.execute(
        "INSERT INTO protein_feature VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("PF-SP1-1", "ENST00000327443", "ENSP00000329357", "Pfam", "PF00096", "C2H2 zinc finger", None, "biomaRt", 620, 645, "chr12:1-2", "chr12", 1, 2, "+"),
    )
    connection.executemany(
        "INSERT INTO protein_feature_segment VALUES (?,?,?,?,?,?,?)",
        [
            ("PF-SP1-1", 1, 1, 53_300_500, 53_300_530, 1857, 1887),
            ("PF-SP1-1", 2, 2, 53_300_700, 53_300_748, 1887, 1935),
        ],
    )
    search_rows = [
        ("SP1", "gene", "ENSG00000185591", "SP1", 100),
        ("SP1-201", "transcript", "ENST00000327443", "SP1-201", 80),
        ("ENST00000327443.9", "transcript", "ENST00000327443", "ENST00000327443.9", 100),
        ("ENSP00000329357.4", "protein", "ENSP00000329357", "ENSP00000329357.4", 100),
    ]
    connection.executemany(
        "INSERT INTO search_entity VALUES (?,?,?,?,?)",
        [(row[0].lower(), *row[1:]) for row in search_rows],
    )
    connection.executemany(
        "INSERT INTO search_fts(label,terms,entity_type,entity_id) VALUES (?,?,?,?)",
        [(row[3], row[0], row[1], row[2]) for row in search_rows],
    )
    for tile_size in (16_384, 65_536, 262_144, 1_048_576):
        tile_start0 = (53_300_000 // tile_size) * tile_size
        connection.execute(
            "INSERT INTO density_tile VALUES (?,?,?,?,?,?)",
            ("chr12", tile_size, tile_start0, min(133_275_309, tile_start0 + tile_size), 1, 2),
        )
    connection.commit()
    connection.close()


def write_manifest(package: Path, *, technical_preview: bool, reference: dict | None = None) -> None:
    scope = "sp1" if technical_preview else "full"
    counts = {"gene": 1, "transcript": 2, "density_tile": 4}
    content_hashes = {
        key: hashlib.sha256(f"fixture:{key}".encode("ascii")).hexdigest()
        for key in counts
    }
    manifest = {
        "schema_version": "1.1.0",
        "build_hash": "fixture-build-hash",
        "release": "GENCODE v45",
        "ensembl_release": 111,
        "assembly": "GRCh38.p14",
        "technical_preview": technical_preview,
        "scope": scope,
        "counts": counts,
        "content_hashes": content_hashes,
        "capabilities": {"full_annotation": not technical_preview},
        "feature_sources": ["Pfam"],
        "reference": reference or {"available": False},
    }
    (package / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    if not technical_preview:
        (package / "validation_report.json").write_text(
            json.dumps(
                {
                    "passed": True,
                    "build_hash": "fixture-build-hash",
                    "schema_version": "1.1.0",
                    "scope": scope,
                    "counts": counts,
                    "content_hashes": content_hashes,
                }
            ),
            encoding="utf-8",
        )


def make_package(root: Path, *, technical_preview: bool = True) -> Path:
    package = root / "package"
    package.mkdir()
    write_db(package / "annotation.sqlite", technical_preview=technical_preview)
    write_manifest(package, technical_preview=technical_preview)
    return package


class ApiTests(unittest.TestCase):
    def test_core_api_etag_bounds_and_empty_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            app = create_app(project_root=root, package_root=package, dev_fixture=True)
            client = TestClient(app, base_url="http://127.0.0.1")

            manifest = client.get("/api/v1/manifest")
            self.assertEqual(manifest.status_code, 200)
            self.assertEqual(
                manifest.headers["content-security-policy"], CONTENT_SECURITY_POLICY
            )
            self.assertTrue(manifest.json()["technicalPreview"])
            self.assertFalse(manifest.json()["reference"]["available"])
            self.assertTrue(manifest.json()["capabilities"]["density"])
            self.assertEqual(
                manifest.json()["densityTileLevels"],
                [16_384, 65_536, 262_144, 1_048_576],
            )
            self.assertEqual(
                client.get("/api/v1/health", headers={"Host": "localhost"}).status_code,
                200,
            )
            rejected_host = client.get(
                "/api/v1/health", headers={"Host": "attacker.example"}
            )
            self.assertEqual(rejected_host.status_code, 400)
            self.assertEqual(rejected_host.text, "Invalid host header")
            self.assertEqual(client.get("/api/docs").status_code, 404)
            openapi = client.get("/api/openapi.json")
            self.assertEqual(openapi.status_code, 200)
            self.assertNotIn("/reference/{public_name}", openapi.json()["paths"])
            cached = client.get(
                "/api/v1/manifest", headers={"If-None-Match": manifest.headers["etag"]}
            )
            self.assertEqual(cached.status_code, 304)

            search = client.get("/api/v1/search", params={"q": "SP1"})
            self.assertEqual(search.json()["results"][0]["id"], "ENSG00000185591")
            self.assertIn("gene", search.json()["groups"])
            self.assertEqual(
                search.json()["results"][0]["resolvedVersion"],
                "ENSG00000185591.8",
            )
            coordinate = client.get("/api/v1/search", params={"q": "12:1-10"})
            self.assertEqual(coordinate.json()["results"][0]["start0"], 0)
            self.assertEqual(coordinate.json()["results"][0]["end0"], 10)
            whitespace = client.get("/api/v1/search", params={"q": "   "})
            self.assertEqual(whitespace.status_code, 400)
            self.assertEqual(
                whitespace.json()["detail"]["code"], "QUERY_CONTRACT_ERROR"
            )

            gene = client.get("/api/v1/genes/ENSG00000185591.8")
            self.assertEqual(gene.status_code, 200)
            self.assertEqual(gene.json()["tags"], ["overlapping_locus"])
            self.assertEqual(gene.json()["transcripts"][0]["name"], "SP1-201")
            self.assertEqual(
                gene.json()["transcripts"][0]["sequences"]["protein"],
                {"available": True, "length": 785},
            )
            self.assertEqual(
                gene.json()["transcripts"][0]["sequences"]["cds"],
                {"available": False, "length": 0},
            )
            sequence = client.get(
                "/api/v1/transcripts/ENST00000548560.1/sequence",
                params={"kind": "protein"},
            )
            self.assertEqual(sequence.json()["length"], 230)
            empty = client.get("/api/v1/transcripts/ENST00000548560/features")
            self.assertEqual(empty.json()["features"], [])
            self.assertIn("No features", empty.json()["emptyState"])

            too_wide = client.get(
                "/api/v1/region",
                params={"chr": "chr12", "start0": 0, "end0": 25_000_001},
            )
            self.assertEqual(too_wide.status_code, 413)

    def test_region_lod_density_pagination_overrides_and_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            app = create_app(project_root=root, package_root=package, dev_fixture=True)
            client = TestClient(app, base_url="http://127.0.0.1")

            page = client.get(
                "/api/v1/region",
                params=[
                    ("chr", "chr12"),
                    ("start0", "53290000"),
                    ("end0", "53320000"),
                    ("detail", "labeled"),
                    ("transcriptLimit", "1"),
                    ("selected", "ENST00000548560.1"),
                    ("bpPerPixel", "31"),
                ],
            )
            self.assertEqual(page.status_code, 200)
            payload = page.json()
            self.assertTrue(payload["pagination"]["transcripts"]["hasMore"])
            self.assertEqual(payload["pagination"]["transcripts"]["returned"], 1)
            self.assertEqual(payload["pagination"]["transcripts"]["overrideCount"], 1)
            self.assertEqual(
                {item["id"] for item in payload["transcripts"]},
                {"ENST00000327443", "ENST00000548560"},
            )
            selected = next(
                item
                for item in payload["transcripts"]
                if item["id"] == "ENST00000548560"
            )
            self.assertTrue(selected["lodOverride"])
            self.assertEqual(selected["geneSymbol"], "SP1")
            self.assertEqual(payload["cacheKey"]["bpPerPixelBucket"], 32.0)

            compact = client.get(
                "/api/v1/region",
                params={
                    "chr": "chr12",
                    "start0": 53_000_000,
                    "end0": 54_000_000,
                    "detail": "compact",
                },
            ).json()
            self.assertEqual(compact["transcriptPolicy"], "selected-and-pinned-only")
            self.assertEqual(compact["transcripts"], [])

            overview = client.get(
                "/api/v1/region",
                params=[
                    ("chr", "chr12"),
                    ("start0", "50000000"),
                    ("end0", "60000000"),
                    ("detail", "auto"),
                    ("pinned", "ENSP00000329357.4"),
                ],
            ).json()
            self.assertEqual(overview["detail"], "overview")
            self.assertTrue(overview["density"]["available"])
            self.assertGreater(len(overview["density"]["bins"]), 0)
            self.assertEqual(
                overview["overrides"]["resolvedTranscriptIds"],
                ["ENST00000327443"],
            )
            self.assertEqual(len(overview["transcripts"]), 1)

            # The database overfetch remains available for panning, while the
            # requested-interval flag preserves exact half-open boundaries.
            boundary = client.get(
                "/api/v1/region",
                params={
                    "chr": "chr12",
                    "start0": 53_299_000,
                    "end0": 53_300_000,
                    "detail": "labeled",
                },
            ).json()
            self.assertEqual(boundary["emptyState"], "No annotated gene in the requested region")
            self.assertFalse(
                next(item for item in boundary["genes"] if item["id"] == "ENSG00000185591")[
                    "inRequestedRegion"
                ]
            )

            exported = client.get(
                "/api/v1/export",
                params={
                    "entity": "region",
                    "format": "json",
                    "chr": "chr12",
                    "start0": 53_299_000,
                    "end0": 53_300_000,
                },
            )
            self.assertEqual(exported.status_code, 200)
            self.assertEqual(exported.json()["genes"], [])
            self.assertEqual(exported.json()["transcripts"], [])
            exported_tsv = client.get(
                "/api/v1/export",
                params={
                    "entity": "region",
                    "format": "tsv",
                    "chr": "chr12",
                    "start0": 53_299_000,
                    "end0": 53_300_000,
                },
            )
            self.assertEqual(exported_tsv.status_code, 200)
            self.assertEqual(exported_tsv.content, b"")

    def test_search_identity_etag_and_local_security_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            app = create_app(project_root=root, package_root=package, dev_fixture=True)
            client = TestClient(app, base_url="http://127.0.0.1")

            protein = client.get(
                "/api/v1/search", params={"q": "ENSP00000329357.4"}
            ).json()["results"][0]
            self.assertEqual(protein["geneId"], "ENSG00000185591")
            self.assertEqual(protein["transcriptId"], "ENST00000327443")
            self.assertEqual(protein["resolvedVersion"], "ENSP00000329357.4")

            for exon_id in ("ENSE00000000001", "ENSE00000000001.1"):
                exon = client.get(
                    "/api/v1/search", params={"q": exon_id}
                ).json()["results"][0]
                self.assertEqual(exon["kind"], "exon")
                self.assertEqual(exon["id"], "ENSE00000000001")
                self.assertEqual(exon["resolvedVersion"], "ENSE00000000001.1")
                self.assertEqual(exon["geneId"], "ENSG00000185591")
                self.assertEqual(exon["transcriptId"], "ENST00000327443")

            first = client.get(
                "/api/v1/region",
                params={
                    "chr": "chr12",
                    "start0": 53_300_000,
                    "end0": 53_320_000,
                    "detail": "labeled",
                },
            )
            cached = client.get(
                str(first.request.url).replace("http://127.0.0.1", ""),
                headers={"If-None-Match": first.headers["etag"]},
            )
            self.assertEqual(cached.status_code, 304)
            overview = client.get(
                "/api/v1/region",
                params={
                    "chr": "chr12",
                    "start0": 53_300_000,
                    "end0": 53_320_000,
                    "detail": "overview",
                },
            )
            self.assertNotEqual(first.headers["etag"], overview.headers["etag"])

            post = client.post("/api/v1/region")
            options = client.options("/api/v1/health")
            self.assertEqual(post.status_code, 405)
            self.assertEqual(options.status_code, 405)
            self.assertNotIn("access-control-allow-origin", first.headers)
            self.assertEqual(first.headers["cross-origin-resource-policy"], "same-origin")
            self.assertIn("camera=()", first.headers["permissions-policy"])

    def test_duplicate_symbol_results_remain_disambiguated(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            connection = sqlite3.connect(package / "annotation.sqlite")
            start0 = 70_000_000
            connection.execute(
                "INSERT INTO gene(gene_id,gene_id_versioned,gene_version,symbol,hgnc_id,"
                "biotype,contig,start0,end0,strand,bin) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "ENSG00000999999",
                    "ENSG00000999999.2",
                    2,
                    "SP1",
                    "HGNC:99999",
                    "lncRNA",
                    "chr12",
                    start0,
                    start0 + 500,
                    "-",
                    4_681 + (start0 >> 17),
                ),
            )
            connection.execute(
                "INSERT INTO search_entity VALUES (?,?,?,?,?)",
                (
                    "sp1",
                    "gene",
                    "ENSG00000999999",
                    "SP1 · ENSG00000999999.2 · chr12:70000001-70000500",
                    100,
                ),
            )
            connection.commit()
            connection.close()

            app = create_app(project_root=root, package_root=package, dev_fixture=True)
            client = TestClient(app, base_url="http://127.0.0.1")
            payload = client.get(
                "/api/v1/search", params={"q": "SP1", "limit": 20}
            ).json()
            genes = [item for item in payload["results"] if item["kind"] == "gene"]
            self.assertEqual(
                {item["id"] for item in genes},
                {"ENSG00000185591", "ENSG00000999999"},
            )
            contexts = {
                (item["versionedId"], item["chr"], item["biotype"])
                for item in genes
            }
            self.assertEqual(len(contexts), 2)

    def test_paginated_overfetch_does_not_create_false_empty_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            connection = sqlite3.connect(package / "annotation.sqlite")
            margin_start0 = 53_290_000
            connection.execute(
                "INSERT INTO gene(gene_id,gene_id_versioned,gene_version,symbol,hgnc_id,"
                "biotype,contig,start0,end0,strand,bin) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "ENSG00000999998",
                    "ENSG00000999998.1",
                    1,
                    "MARGIN",
                    None,
                    "lncRNA",
                    "chr12",
                    margin_start0,
                    margin_start0 + 5_000,
                    "+",
                    4_681 + (margin_start0 >> 17),
                ),
            )
            connection.commit()
            connection.close()

            app = create_app(project_root=root, package_root=package, dev_fixture=True)
            client = TestClient(app, base_url="http://127.0.0.1")
            first_page = client.get(
                "/api/v1/region",
                params={
                    "chr": "chr12",
                    "start0": 53_300_000,
                    "end0": 53_310_000,
                    "detail": "labeled",
                    "geneLimit": 1,
                },
            ).json()
            self.assertTrue(first_page["truncated"])
            self.assertEqual(len(first_page["genes"]), 1)
            self.assertFalse(first_page["genes"][0]["inRequestedRegion"])
            self.assertIsNone(first_page["emptyState"])

            second_page = client.get(
                "/api/v1/region",
                params={
                    "chr": "chr12",
                    "start0": 53_300_000,
                    "end0": 53_310_000,
                    "detail": "labeled",
                    "geneLimit": 1,
                    "geneOffset": 1,
                },
            ).json()
            self.assertTrue(second_page["genes"][0]["inRequestedRegion"])

    def test_partial_mapping_never_exposes_genomic_segments(self) -> None:
        row = {
            "feature_id": "f",
            "transcript_id": "t",
            "strand": "+",
            "aa_start1": 1,
            "aa_end1": 2,
        }
        segment = {"segment_rank": 1, "start0": 10, "end0": 16}
        self.assertEqual(_feature_json(row, [segment], "partial")["segments"], [])
        self.assertEqual(len(_feature_json(row, [segment], "exact")["segments"]), 1)

    def test_normal_mode_refuses_technical_preview(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            with self.assertRaises(StartupValidationError):
                create_app(project_root=root, package_root=package, dev_fixture=False)

    def test_normal_mode_refuses_nonpreview_partial_package(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root, technical_preview=False)
            manifest_path = package / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["scope"] = "sp1"
            manifest["capabilities"]["full_annotation"] = False
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            report_path = package / "validation_report.json"
            report = json.loads(report_path.read_text(encoding="utf-8"))
            report["scope"] = "sp1"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            with self.assertRaisesRegex(StartupValidationError, "scope=full"):
                create_app(project_root=root, package_root=package, dev_fixture=False)

    def test_normal_mode_refuses_validation_report_without_content_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root, technical_preview=False)
            report_path = package / "validation_report.json"
            report = json.loads(report_path.read_text(encoding="utf-8"))
            report.pop("content_hashes")
            report_path.write_text(json.dumps(report), encoding="utf-8")
            with self.assertRaisesRegex(
                StartupValidationError, "require non-empty content_hashes"
            ):
                create_app(project_root=root, package_root=package, dev_fixture=False)

    def test_startup_refuses_consistently_mislabeled_gencode_release(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            connection = sqlite3.connect(package / "annotation.sqlite")
            connection.execute(
                "UPDATE build_manifest SET value = ? WHERE key = 'release'",
                ("GENCODE v44",),
            )
            connection.commit()
            connection.close()
            manifest_path = package / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["release"] = "GENCODE v44"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaisesRegex(StartupValidationError, "expected GENCODE v45"):
                create_app(project_root=root, package_root=package, dev_fixture=True)

    def test_startup_refuses_schema_missing_required_biological_flags(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            connection = sqlite3.connect(package / "annotation.sqlite")
            connection.execute("ALTER TABLE transcript DROP COLUMN is_mane_select")
            connection.commit()
            connection.close()

            with self.assertRaisesRegex(
                StartupValidationError, r"transcript\(is_mane_select\)"
            ):
                create_app(project_root=root, package_root=package, dev_fixture=True)

    def test_verified_external_reference_range_and_spa_containment(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root, technical_preview=False)
            reference = package / "reference"
            reference.mkdir()
            external = root / "external"
            external.mkdir()
            fasta_target = external / "whole.fa"
            index_target = external / "whole.fa.fai"
            fasta_target.write_bytes(b"ACGTACGTACGTACGT")
            index_target.write_text("chr12\t16\t0\t16\t17\n", encoding="utf-8")
            (reference / "genome.fa").symlink_to(fasta_target)
            (reference / "genome.fa.fai").symlink_to(index_target)
            chrom = reference / "GRCh38.p14.primary.chrom.sizes"
            aliases = reference / "chrom_aliases.tsv"
            chrom.write_text("chr12\t133275309\n", encoding="utf-8")
            aliases.write_text("12\tchr12\n", encoding="utf-8")
            declarations = {
                "fasta": {"public_name": "genome.fa", "link_path": "genome.fa", "target_path": str(fasta_target), "sha256": sha256(fasta_target), "size": fasta_target.stat().st_size},
                "index": {"public_name": "genome.fa.fai", "link_path": "genome.fa.fai", "target_path": str(index_target), "sha256": sha256(index_target), "size": index_target.stat().st_size},
                "chrom_sizes": {"public_name": chrom.name, "path": chrom.name, "sha256": sha256(chrom), "size": chrom.stat().st_size},
                "aliases": {"public_name": aliases.name, "path": aliases.name, "sha256": sha256(aliases), "size": aliases.stat().st_size},
            }
            records = []
            actual = {
                "genome.fa": fasta_target,
                "genome.fa.fai": index_target,
                chrom.name: chrom,
                aliases.name: aliases,
            }
            for name, path in actual.items():
                stat = path.stat()
                records.append({"path": name, "sha256": sha256(path), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "inode": stat.st_ino, "device": stat.st_dev})
            (reference / "verification_receipt.json").write_text(json.dumps({"files": records}), encoding="utf-8")
            ref_manifest = {"verified": True, "verification_receipt": "verification_receipt.json", **declarations}
            (reference / "reference_manifest.json").write_text(json.dumps(ref_manifest), encoding="utf-8")
            write_manifest(
                package,
                technical_preview=False,
                reference={"available": True, "verified": True, "manifest": "reference/reference_manifest.json"},
            )
            frontend = root / "frontend-dist"
            frontend.mkdir()
            (frontend / "index.html").write_text("<h1>safe</h1>", encoding="utf-8")
            secret = root / "secret.txt"
            secret.write_text("do not serve", encoding="utf-8")

            app = create_app(project_root=root, package_root=package, frontend_dist=frontend)
            client = TestClient(app, base_url="http://127.0.0.1")
            response = client.get("/reference/genome.fa", headers={"Range": "bytes=2-5"})
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.content, b"GTAC")
            self.assertEqual(response.headers["content-range"], "bytes 2-5/16")
            not_modified = client.get(
                "/reference/genome.fa",
                headers={
                    "Range": "bytes=2-5",
                    "If-None-Match": response.headers["etag"],
                },
            )
            self.assertEqual(not_modified.status_code, 304)
            self.assertEqual(not_modified.content, b"")
            mismatch = client.get(
                "/reference/genome.fa",
                headers={"Range": "bytes=2-5", "If-Range": '"not-current"'},
            )
            self.assertEqual(mismatch.status_code, 200)
            self.assertEqual(mismatch.content, b"ACGTACGTACGTACGT")
            matching = client.head(
                "/reference/genome.fa",
                headers={"Range": "bytes=2-5", "If-Range": response.headers["etag"]},
            )
            self.assertEqual(matching.status_code, 206)
            self.assertEqual(matching.headers["content-length"], "4")
            api_reference = client.get("/api/v1/manifest").json()["reference"]
            self.assertEqual(api_reference["faiUrl"], "/reference/genome.fa.fai")
            self.assertNotIn("gziUrl", api_reference)
            traversal = client.get("/%2e%2e/secret.txt")
            self.assertNotEqual(traversal.text, "do not serve")


if __name__ == "__main__":
    unittest.main()
