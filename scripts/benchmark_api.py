#!/usr/bin/env python3
"""Measure bounded local API latency against a running transcript browser."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import platform
import statistics
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class Measurement:
    name: str
    path: str
    samples: int
    response_bytes: int
    p50_ms: float
    p95_ms: float
    maximum_ms: float
    budget_ms: float
    passed: bool


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise ValueError("percentile requires at least one value")
    ordered = sorted(values)
    rank = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[rank]


def request_json(base_url: str, path: str, timeout: float) -> tuple[Any, int, float]:
    request = Request(base_url.rstrip("/") + path, headers={"Accept": "application/json"})
    started = time.perf_counter_ns()
    with urlopen(request, timeout=timeout) as response:
        body = response.read()
        if response.status != 200:
            raise RuntimeError(f"{path} returned HTTP {response.status}")
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
    return json.loads(body), len(body), elapsed_ms


def measure(
    base_url: str,
    *,
    name: str,
    path: str,
    samples: int,
    warmups: int,
    budget_ms: float,
    timeout: float,
) -> Measurement:
    for _ in range(warmups):
        request_json(base_url, path, timeout)
    values: list[float] = []
    response_bytes = 0
    for _ in range(samples):
        _, response_bytes, elapsed = request_json(base_url, path, timeout)
        values.append(elapsed)
    p95 = percentile(values, 0.95)
    return Measurement(
        name=name,
        path=path,
        samples=samples,
        response_bytes=response_bytes,
        p50_ms=round(statistics.median(values), 3),
        p95_ms=round(p95, 3),
        maximum_ms=round(max(values), 3),
        budget_ms=budget_ms,
        passed=p95 < budget_ms,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--samples", type=int, default=100)
    parser.add_argument("--warmups", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--gene", default="ENSG00000185591", help="Representative stable gene ID")
    parser.add_argument("--chrom", default="chr12")
    parser.add_argument("--start0", type=int, default=53_360_000)
    parser.add_argument("--end0", type=int, default=53_430_000)
    args = parser.parse_args(argv)
    if args.samples < 20 or args.warmups < 0:
        parser.error("--samples must be at least 20 and --warmups cannot be negative")

    try:
        manifest, _, _ = request_json(args.base_url, "/api/v1/manifest", args.timeout)
        search_path = "/api/v1/search?" + urlencode({"q": "SP1", "limit": 20})
        region_path = "/api/v1/region?" + urlencode(
            {
                "chr": args.chrom,
                "start0": args.start0,
                "end0": args.end0,
                "detail": "auto",
            }
        )
        measurements = [
            measure(
                args.base_url,
                name="search autocomplete",
                path=search_path,
                samples=args.samples,
                warmups=args.warmups,
                budget_ms=50.0,
                timeout=args.timeout,
            ),
            measure(
                args.base_url,
                name="typical regional API",
                path=region_path,
                samples=args.samples,
                warmups=args.warmups,
                budget_ms=100.0,
                timeout=args.timeout,
            ),
            measure(
                args.base_url,
                name="warm gene jump API",
                path=f"/api/v1/genes/{args.gene}",
                samples=args.samples,
                warmups=args.warmups,
                budget_ms=300.0,
                timeout=args.timeout,
            ),
        ]
    except (HTTPError, URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"Benchmark failed: {exc}")
        return 2

    report = {
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "base_url": args.base_url,
        "build_hash": manifest.get("buildHash"),
        "release": manifest.get("release"),
        "assembly": manifest.get("assembly"),
        "technical_preview": manifest.get("technicalPreview"),
        "host": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "cache_state": "warm after explicit warm-up requests",
        "measurements": [asdict(item) for item in measurements],
    }
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
        print(f"Wrote {args.output}")
    print(encoded, end="")
    return 0 if all(item.passed for item in measurements) else 1


if __name__ == "__main__":
    raise SystemExit(main())
