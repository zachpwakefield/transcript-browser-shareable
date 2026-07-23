#!/usr/bin/env python3
"""Compare two completed build receipts using canonical, layout-independent data."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("first", type=Path, help="First build receipt directory")
    parser.add_argument("second", type=Path, help="Second build package directory")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    first_manifest_path = args.first / "manifest.json"
    second_manifest_path = args.second / "manifest.json"
    first_report_path = args.first / "validation_report.json"
    second_report_path = args.second / "validation_report.json"
    first_manifest = read_json(first_manifest_path)
    second_manifest = read_json(second_manifest_path)
    first_report = read_json(first_report_path)
    second_report = read_json(second_report_path)
    first_metrics = read_json(args.first / "build_metrics.json")
    second_metrics = read_json(args.second / "build_metrics.json")

    checks = {
        "manifest_bytes_identical": first_manifest_path.read_bytes()
        == second_manifest_path.read_bytes(),
        "validation_report_bytes_identical": first_report_path.read_bytes()
        == second_report_path.read_bytes(),
        "build_hash_identical": first_manifest["build_hash"]
        == second_manifest["build_hash"],
        "schema_version_identical": first_manifest["schema_version"]
        == second_manifest["schema_version"],
        "builder_version_identical": first_manifest["builder_version"]
        == second_manifest["builder_version"],
        "row_counts_identical": first_manifest["counts"] == second_manifest["counts"],
        "canonical_table_hashes_identical": first_manifest["content_hashes"]
        == second_manifest["content_hashes"],
        "both_validation_reports_passed": bool(first_report["passed"])
        and bool(second_report["passed"]),
    }
    passed = all(checks.values())
    payload = {
        "gate": "full-canonical-content-determinism",
        "passed": passed,
        "verified_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "comparison_contract": (
            "Canonical ordered table hashes, row counts, manifest, and validation report "
            "must match. Operational metrics and SQLite page layout are intentionally excluded."
        ),
        "checks": checks,
        "build_hash": second_manifest["build_hash"],
        "schema_version": second_manifest["schema_version"],
        "builder_version": second_manifest["builder_version"],
        "canonical_table_hashes": second_manifest["content_hashes"],
        "row_counts": second_manifest["counts"],
        "first_run": {
            "manifest_sha256": digest(first_manifest_path),
            "validation_report_sha256": digest(first_report_path),
            "recorded_at": first_metrics["recorded_at"],
            "total_seconds": first_metrics["stages_seconds"]["total"],
        },
        "second_run": {
            "manifest_sha256": digest(second_manifest_path),
            "validation_report_sha256": digest(second_report_path),
            "recorded_at": second_metrics["recorded_at"],
            "total_seconds": second_metrics["stages_seconds"]["total"],
        },
        "verifier_sha256": digest(Path(__file__)),
    }
    args.output.write_text(
        json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
