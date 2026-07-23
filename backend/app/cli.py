"""Command-line entry point for the localhost-only runtime."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import threading
import webbrowser

import uvicorn

from .errors import StartupValidationError
from .main import create_app


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="transcript-browser",
        description="Serve the immutable local transcript browser on 127.0.0.1.",
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--data-package",
        type=Path,
        help="Override the normal or development-fixture data package directory.",
    )
    parser.add_argument(
        "--dev-fixture",
        action="store_true",
        help="Run the explicitly labeled, scoped SP1 technical-preview package.",
    )
    parser.add_argument(
        "--full-reference-verify",
        action="store_true",
        help=(
            "If an optional whole-genome reference is present, recompute its "
            "SHA-256 artifacts before serving (slow)."
        ),
    )
    parser.add_argument(
        "--full-database-verify",
        action="store_true",
        help=(
            "Run SQLite quick_check before serving. The normal fast startup trusts "
            "the passed immutable build validation report."
        ),
    )
    parser.add_argument("--port", type=int, default=8000, help="Local TCP port (default: 8000).")
    browser = parser.add_mutually_exclusive_group()
    browser.add_argument(
        "--open",
        action="store_true",
        help="Open the local URL after the server begins starting.",
    )
    browser.add_argument(
        "--no-open",
        action="store_true",
        help="Do not open a browser (this is also the default).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not 1 <= args.port <= 65535:
        print("error: --port must be between 1 and 65535", file=sys.stderr)
        return 2
    project_root = args.project_root.expanduser().resolve()
    package_root = args.data_package
    if package_root is not None:
        # Preserve the lexical final component so the runtime loader can reject
        # a symlinked package root before resolution hides it.
        package_root = package_root.expanduser().absolute()
    try:
        app = create_app(
            project_root=project_root,
            package_root=package_root,
            dev_fixture=args.dev_fixture,
            full_reference_verify=args.full_reference_verify,
            full_database_verify=args.full_database_verify,
        )
    except StartupValidationError as exc:
        print(f"startup validation failed: {exc}", file=sys.stderr)
        return 2

    url = f"http://127.0.0.1:{args.port}"
    package = app.state.runtime_package
    mode = "SP1 TECHNICAL PREVIEW" if package.technical_preview else "VERIFIED FULL BUILD"
    print(f"Local Transcript Browser — {mode}")
    print(f"Build: {package.build_hash}")
    print(f"URL:   {url}")
    print("Binding: 127.0.0.1 only")
    if args.open:
        threading.Timer(0.75, lambda: webbrowser.open(url)).start()
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=args.port,
        reload=False,
        access_log=True,
        server_header=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
