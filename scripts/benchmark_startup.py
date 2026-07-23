#!/usr/bin/env python3
"""Measure fresh-process server readiness for an existing full data package."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import socket
import subprocess
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def wait_for_health(url: str, process: subprocess.Popen[bytes], timeout: float) -> float:
    started = time.perf_counter_ns()
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"server exited with code {process.returncode}")
        try:
            with urlopen(url, timeout=0.25) as response:
                body: Any = json.loads(response.read())
                if response.status == 200 and body.get("status") == "ok":
                    return (time.perf_counter_ns() - started) / 1_000_000
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
        time.sleep(0.02)
    raise TimeoutError(f"server was not ready within {timeout}s; last error: {last_error}")


def main(argv: list[str] | None = None) -> int:
    project_default = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=project_default)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if args.runs < 3:
        parser.error("--runs must be at least 3")
    root = args.project_root.expanduser().resolve()
    python = root / ".venv" / "bin" / "python"
    if not python.is_file():
        parser.error(f"local runtime is missing: {python}; run ./run_local.sh once")

    samples: list[float] = []
    for index in range(args.runs):
        port = available_port()
        process = subprocess.Popen(
            [str(python), "-m", "backend.app.cli", "--port", str(port), "--no-open"],
            cwd=root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            elapsed = wait_for_health(
                f"http://127.0.0.1:{port}/api/v1/health", process, args.timeout
            )
            samples.append(elapsed)
            print(f"run {index + 1}/{args.runs}: {elapsed:.3f} ms")
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)

    p95 = percentile(samples, 0.95)
    report = {
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "method": "fresh server process; dependencies and data package already present; OS file cache not purged",
        "runs": len(samples),
        "samples_ms": [round(value, 3) for value in samples],
        "median_ms": round(percentile(samples, 0.5), 3),
        "p95_ms": round(p95, 3),
        "maximum_ms": round(max(samples), 3),
        "budget_ms": 2000.0,
        "passed": p95 < 2000.0,
    }
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
        print(f"Wrote {args.output}")
    print(encoded, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
