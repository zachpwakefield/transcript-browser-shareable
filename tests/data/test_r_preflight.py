from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = PROJECT_ROOT / "r" / "dependencies.lock.tsv"
RENV_LOCK_PATH = PROJECT_ROOT / "r" / "renv.lock"
PREFLIGHT_PATH = PROJECT_ROOT / "r" / "preflight.R"
EXPORTER_PATH = PROJECT_ROOT / "r" / "export_features.R"


class RDependencyPreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rscript = shutil.which("Rscript")
        if cls.rscript is None:
            raise unittest.SkipTest("Rscript is unavailable")

    def _run_preflight(self, lock_path: Path) -> subprocess.CompletedProcess[str]:
        expression = (
            "source(commandArgs(trailingOnly=TRUE)[1]); "
            "versions <- run_dependency_preflight(commandArgs(trailingOnly=TRUE)[2]); "
            "cat(paste(names(versions), versions, sep='=', collapse='\\n'))"
        )
        return subprocess.run(
            [
                self.rscript,
                "-e",
                expression,
                str(PREFLIGHT_PATH),
                str(lock_path),
            ],
            cwd=PROJECT_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_committed_lock_pins_validated_versions(self) -> None:
        with LOCK_PATH.open(newline="", encoding="utf-8") as handle:
            rows = {row["package"]: row["version"] for row in csv.DictReader(handle, delimiter="\t")}
        self.assertEqual(
            rows,
            {"data.table": "1.18.2.1", "jsonlite": "2.0.0"},
        )
        result = self._run_preflight(LOCK_PATH)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.strip().splitlines(),
            ["data.table=1.18.2.1", "jsonlite=2.0.0"],
        )

    def test_supported_r_release_and_renv_lock_are_enforced(self) -> None:
        expression = (
            "source(commandArgs(trailingOnly=TRUE)[1]); "
            "versions <- run_dependency_preflight(commandArgs(trailingOnly=TRUE)[2], "
            "commandArgs(trailingOnly=TRUE)[3]); "
            "cat(as.character(getRversion()))"
        )
        result = subprocess.run(
            [
                self.rscript,
                "-e",
                expression,
                str(PREFLIGHT_PATH),
                str(LOCK_PATH),
                str(RENV_LOCK_PATH),
            ],
            cwd=PROJECT_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "4.5.2")

    def test_mismatch_fails_with_actionable_message(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            mismatched_lock = Path(directory) / "dependencies.lock.tsv"
            mismatched_lock.write_text(
                "package\tversion\n"
                "data.table\t0.0.0-test-mismatch\n"
                "jsonlite\t2.0.0\n",
                encoding="utf-8",
            )
            result = self._run_preflight(mismatched_lock)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "data.table: expected 0.0.0-test-mismatch; found 1.18.2.1",
            result.stderr,
        )
        self.assertIn("renv::install", result.stderr)
        self.assertIn("data.table@0.0.0-test-mismatch", result.stderr)
        self.assertIn("jsonlite@2.0.0", result.stderr)

    def test_export_manifest_records_both_verified_versions(self) -> None:
        configured_cache = os.environ.get("TRANSCRIPT_BROWSER_TEST_CACHE")
        if not configured_cache:
            self.skipTest("Set TRANSCRIPT_BROWSER_TEST_CACHE to run the local-cache export test")
        cache = Path(configured_cache).expanduser()
        if not cache.is_dir():
            self.skipTest("Audited local feature cache is unavailable")
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            transcript_ids = temporary / "transcripts.txt"
            transcript_ids.write_text(
                "ENST00000327443\n"
                "ENST00000426431\n"
                "ENST00000548560\n"
                "ENST00000551969\n",
                encoding="ascii",
            )
            output = temporary / "features"
            result = subprocess.run(
                [
                    self.rscript,
                    str(EXPORTER_PATH),
                    "--input",
                    str(cache),
                    "--output",
                    str(output),
                    "--transcripts",
                    str(transcript_ids),
                ],
                cwd=PROJECT_ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads(
                (output / "feature_export_manifest.json").read_text(encoding="utf-8")
            )
        self.assertEqual(manifest["dependency_lock"], "dependencies.lock.tsv")
        self.assertEqual(manifest["renv_lock"], "renv.lock")
        self.assertEqual(manifest["supported_r_version"], "4.5.2")
        self.assertEqual(manifest["data_table_version"], "1.18.2.1")
        self.assertEqual(manifest["jsonlite_version"], "2.0.0")
        self.assertEqual(
            manifest["dependencies"],
            {"data.table": "1.18.2.1", "jsonlite": "2.0.0"},
        )


if __name__ == "__main__":
    unittest.main()
