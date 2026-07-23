from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stderr

from backend.app.cli import main as cli_main
from backend.app.database import AnnotationDatabase
from backend.app.errors import StartupValidationError
from backend.app.package import (
    _declared_artifact,
    _safe_lexical_child,
    _validate_receipt,
    load_runtime_package,
)


class PackageHelperTests(unittest.TestCase):
    def test_cli_preserves_package_symlink_for_loader_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            actual = root / "actual-package"
            actual.mkdir()
            link = root / "linked-package"
            link.symlink_to(actual, target_is_directory=True)
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                status = cli_main(
                    [
                        "--project-root",
                        str(root),
                        "--data-package",
                        str(link),
                        "--dev-fixture",
                    ]
                )
            self.assertEqual(status, 2)
            self.assertIn("symbolic link", stderr.getvalue())

    def test_runtime_package_root_symlink_is_rejected_before_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            actual = root / "actual-package"
            actual.mkdir()
            link = root / "linked-package"
            link.symlink_to(actual, target_is_directory=True)
            with self.assertRaisesRegex(StartupValidationError, "symbolic link"):
                load_runtime_package(link, dev_fixture=True)

    def test_database_validation_rejects_lexical_symlink_before_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "actual.sqlite"
            target.write_bytes(b"not a database")
            link = root / "annotation.sqlite"
            link.symlink_to(target)

            with self.assertRaisesRegex(StartupValidationError, "symbolic link"):
                AnnotationDatabase(link).validate()

    def test_database_manifest_decodes_canonical_json_scalars(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "annotation.sqlite"
            connection = sqlite3.connect(path)
            connection.execute("CREATE TABLE build_manifest(key TEXT PRIMARY KEY, value TEXT)")
            connection.executemany(
                "INSERT INTO build_manifest VALUES (?,?)",
                [
                    ("schema_version", json.dumps("1.0.0")),
                    ("build_hash", json.dumps("abc123")),
                    ("technical_preview", json.dumps(True)),
                ],
            )
            connection.commit()
            connection.close()
            metadata = AnnotationDatabase(path).build_metadata()
            self.assertEqual(metadata.schema_version, "1.0.0")
            self.assertEqual(metadata.build_hash, "abc123")
            self.assertIs(metadata.values["technical_preview"], True)

    def test_lexical_path_rejects_parent_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "reference"
            root.mkdir()
            with self.assertRaises(StartupValidationError):
                _safe_lexical_child(root, "../secret.fa")

    def test_lexical_path_rejects_intermediate_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "reference"
            outside = base / "outside"
            root.mkdir()
            outside.mkdir()
            (outside / "manifest.json").write_text("{}", encoding="utf-8")
            (root / "nested").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(StartupValidationError, "symbolic-link parent"):
                _safe_lexical_child(root, "nested/manifest.json")

    def test_declared_external_symlink_and_receipt_are_exact(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "reference"
            root.mkdir()
            target = Path(temp) / "whole.fa"
            target.write_bytes(b"ACGT")
            (root / "genome.fa").symlink_to(target)
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            artifact = _declared_artifact(
                root,
                {
                    "public_name": "genome.fa",
                    "link_path": "genome.fa",
                    "target_path": str(target),
                    "sha256": digest,
                    "size": target.stat().st_size,
                },
                label="test FASTA",
            )
            self.assertEqual(artifact.path, target.resolve())
            stat = target.stat()
            receipt = root / "verification_receipt.json"
            receipt.write_text(
                json.dumps(
                    {
                        "records": {
                            "fasta": {
                                "path": str(target),
                                "lexical_path": "genome.fa",
                                "sha256": digest,
                                "size": stat.st_size,
                                "mtime_ns": stat.st_mtime_ns,
                                "inode": stat.st_ino,
                                "device": stat.st_dev,
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            _validate_receipt(
                receipt,
                {"genome.fa": target},
                {"genome.fa": digest},
                external_artifacts=frozenset({"genome.fa"}),
                full_verify=True,
            )
            # APFS device IDs can change across a remount even when the
            # referenced file identity and bytes are unchanged.  Receipts from
            # older builds may still contain ``device``; that field must not
            # make a valid external reference fail to launch.
            receipt_payload = json.loads(receipt.read_text(encoding="utf-8"))
            receipt_payload["records"]["fasta"]["device"] = stat.st_dev + 1
            receipt.write_text(json.dumps(receipt_payload), encoding="utf-8")
            _validate_receipt(
                receipt,
                {"genome.fa": target},
                {"genome.fa": digest},
                external_artifacts=frozenset({"genome.fa"}),
                full_verify=False,
            )
            target.write_bytes(b"TGCA")
            with self.assertRaises(StartupValidationError):
                _validate_receipt(
                    receipt,
                    {"genome.fa": target},
                    {"genome.fa": digest},
                    external_artifacts=frozenset({"genome.fa"}),
                    full_verify=False,
                )

    def test_internal_artifact_receipt_survives_copy_but_detects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source"
            copied = Path(temp) / "copied"
            source.mkdir()
            artifact = source / "GRCh38.p14.primary.chrom.sizes"
            artifact.write_text("chr1\t248956422\n", encoding="utf-8")
            digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
            stat = artifact.stat()
            receipt = source / "verification_receipt.json"
            receipt.write_text(
                json.dumps(
                    {
                        "files": {
                            artifact.name: {
                                "path": artifact.name,
                                "sha256": digest,
                                "size": stat.st_size,
                                "mtime_ns": stat.st_mtime_ns,
                                "inode": stat.st_ino,
                                "device": stat.st_dev,
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            shutil.copytree(source, copied)
            copied_artifact = copied / artifact.name
            self.assertNotEqual(copied_artifact.stat().st_ino, stat.st_ino)
            _validate_receipt(
                copied / receipt.name,
                {artifact.name: copied_artifact},
                {artifact.name: digest},
                external_artifacts=frozenset(),
                full_verify=False,
            )
            copied_artifact.write_text("chr1\t248956421\n", encoding="utf-8")
            with self.assertRaises(StartupValidationError):
                _validate_receipt(
                    copied / receipt.name,
                    {artifact.name: copied_artifact},
                    {artifact.name: digest},
                    external_artifacts=frozenset(),
                    full_verify=False,
                )


if __name__ == "__main__":
    unittest.main()
