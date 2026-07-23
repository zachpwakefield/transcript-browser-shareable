from __future__ import annotations

from io import BytesIO
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from pypdf import PdfReader

from backend.app.main import create_app
from backend.app.pdf_report import MAX_PDF_TRANSCRIPTS
from backend.app.repository import AnnotationRepository
from backend.tests.test_api import make_package


def report_request(**updates: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "buildHash": "fixture-build-hash",
        "geneId": "ENSG00000185591",
        "transcriptIds": ["ENST00000327443", "ENST00000548560"],
        "sections": ["summary", "structure", "features", "sequence"],
        "featureSources": ["Pfam"],
        "structureScope": "current_locus",
        "locus": {"chrom": "chr12", "start0": 53_300_000, "end0": 53_320_000},
        "sequenceExcerpt": {"kind": "protein", "start1": 1, "end1": 40},
    }
    payload.update(updates)
    return payload


class PdfReportApiTests(unittest.TestCase):
    def test_selected_report_is_a_bounded_downloadable_pdf(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            app = create_app(project_root=root, package_root=package, dev_fixture=True)
            client = TestClient(app, base_url="http://127.0.0.1")

            response = client.post(
                "/api/v1/report/pdf",
                json=report_request(
                    transcriptIds=["ENST00000548560", "ENST00000327443"]
                ),
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers["content-type"], "application/pdf")
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(
                response.headers["content-disposition"],
                'attachment; filename="SP1_2-transcript-report.pdf"',
            )
            self.assertTrue(response.content.startswith(b"%PDF-"))
            self.assertTrue(response.content.rstrip().endswith(b"%%EOF"))
            self.assertGreater(len(response.content), 5_000)
            page_count = len(re.findall(rb"/Type\s*/Page(?!s)", response.content))
            self.assertGreaterEqual(page_count, 3)
            self.assertLessEqual(page_count, 100)
            reader = PdfReader(BytesIO(response.content))
            self.assertEqual(len(reader.pages), page_count)
            extracted = "\n".join(page.extract_text() or "" for page in reader.pages)
            self.assertIn("Transcript summary", extracted)
            self.assertIn("Exon and CDS structure", extracted)
            self.assertIn("Protein annotations", extracted)
            self.assertIn("Sequence excerpt", extracted)
            self.assertIn("M" * 40, extracted)
            self.assertLess(
                extracted.index("ENST00000548560.1"),
                extracted.index("ENST00000327443.9"),
            )

            focused = client.post(
                "/api/v1/report/pdf",
                json=report_request(
                    transcriptIds=["ENST00000548560"],
                    sections=["summary"],
                    featureSources=[],
                    structureScope="full",
                    locus=None,
                    sequenceExcerpt=None,
                ),
            )
            self.assertEqual(focused.status_code, 200, focused.text)
            focused_text = "\n".join(
                page.extract_text() or ""
                for page in PdfReader(BytesIO(focused.content)).pages
            )
            self.assertIn("ENST00000548560.1", focused_text)
            self.assertNotIn("ENST00000327443.9", focused_text)
            self.assertNotIn("Exon and CDS structure", focused_text)
            self.assertNotIn("Protein annotations", focused_text)
            self.assertNotIn("Sequence excerpt", focused_text)
            self.assertTrue(client.get("/api/v1/manifest").json()["capabilities"]["pdfReports"])

    def test_report_rejects_stale_build_invalid_scope_and_sequence_range(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            app = create_app(project_root=root, package_root=package, dev_fixture=True)
            client = TestClient(app, base_url="http://127.0.0.1")

            stale = client.post(
                "/api/v1/report/pdf",
                json=report_request(buildHash="old-build", sections=["summary"]),
            )
            self.assertEqual(stale.status_code, 409)
            self.assertEqual(stale.json()["detail"]["code"], "PDF_BUILD_MISMATCH")

            chromosome = client.post(
                "/api/v1/report/pdf",
                json=report_request(
                    sections=["structure"],
                    sequenceExcerpt=None,
                    locus={"chrom": "chr7", "start0": 100, "end0": 200},
                ),
            )
            self.assertEqual(chromosome.status_code, 400)
            self.assertEqual(
                chromosome.json()["detail"]["code"],
                "PDF_LOCUS_CHROMOSOME_MISMATCH",
            )

            out_of_bounds = client.post(
                "/api/v1/report/pdf",
                json=report_request(
                    sections=["structure"],
                    sequenceExcerpt=None,
                    locus={
                        "chrom": "chr12",
                        "start0": 133_275_300,
                        "end0": 133_275_400,
                    },
                ),
            )
            self.assertEqual(out_of_bounds.status_code, 400)
            self.assertEqual(
                out_of_bounds.json()["detail"]["code"],
                "PDF_LOCUS_OUT_OF_BOUNDS",
            )

            range_error = client.post(
                "/api/v1/report/pdf",
                json=report_request(
                    transcriptIds=["ENST00000548560"],
                    sections=["sequence"],
                    featureSources=[],
                    structureScope="full",
                    locus=None,
                    sequenceExcerpt={"kind": "protein", "start1": 1, "end1": 300},
                ),
            )
            self.assertEqual(range_error.status_code, 400)
            self.assertEqual(
                range_error.json()["detail"]["code"],
                "PDF_SEQUENCE_RANGE_OUT_OF_BOUNDS",
            )

    def test_report_schema_rejects_duplicates_unknown_sources_and_transcript_overflow(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            app = create_app(project_root=root, package_root=package, dev_fixture=True)
            client = TestClient(app, base_url="http://127.0.0.1")

            duplicate = client.post(
                "/api/v1/report/pdf",
                json=report_request(
                    transcriptIds=["ENST00000327443", "ENST00000327443"],
                    sections=["summary"],
                    sequenceExcerpt=None,
                ),
            )
            self.assertEqual(duplicate.status_code, 422)

            resolved_duplicate = client.post(
                "/api/v1/report/pdf",
                json=report_request(
                    transcriptIds=["ENST00000327443", "ENST00000327443.9"],
                    sections=["summary"],
                    sequenceExcerpt=None,
                ),
            )
            self.assertEqual(resolved_duplicate.status_code, 400)
            self.assertEqual(
                resolved_duplicate.json()["detail"]["code"],
                "PDF_DUPLICATE_TRANSCRIPT",
            )

            unknown_source = client.post(
                "/api/v1/report/pdf",
                json=report_request(
                    sections=["features"],
                    sequenceExcerpt=None,
                    featureSources=["remote-source"],
                ),
            )
            self.assertEqual(unknown_source.status_code, 400)
            self.assertEqual(
                unknown_source.json()["detail"]["code"],
                "PDF_UNKNOWN_FEATURE_SOURCE",
            )

            overflow = client.post(
                "/api/v1/report/pdf",
                json=report_request(
                    transcriptIds=[f"ENST{i:011d}" for i in range(MAX_PDF_TRANSCRIPTS + 1)],
                    sections=["summary"],
                    sequenceExcerpt=None,
                ),
            )
            self.assertEqual(overflow.status_code, 422)

    def test_empty_active_feature_sources_do_not_expand_to_all_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = make_package(root)
            app = create_app(project_root=root, package_root=package, dev_fixture=True)
            client = TestClient(app, base_url="http://127.0.0.1")

            with patch.object(
                AnnotationRepository,
                "get_features",
                side_effect=AssertionError("an empty PDF source selection must not query all features"),
            ):
                response = client.post(
                    "/api/v1/report/pdf",
                    json=report_request(
                        transcriptIds=["ENST00000327443"],
                        sections=["features"],
                        featureSources=[],
                        structureScope="full",
                        locus=None,
                        sequenceExcerpt=None,
                    ),
                )

            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers["content-type"], "application/pdf")


if __name__ == "__main__":
    unittest.main()
