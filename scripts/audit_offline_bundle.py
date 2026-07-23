#!/usr/bin/env python3
"""Fail when the production frontend declares an external runtime resource.

This is a static release gate, not a replacement for the browser network-log
gate.  It catches the common ways an accidentally added CDN, remote font,
analytics client, websocket, or absolute API URL can enter the built bundle.
"""

from __future__ import annotations

import argparse
from html.parser import HTMLParser
from pathlib import Path
import re
import sys


EXTERNAL_SCHEME = re.compile(r"^(?:https?:)?//", re.IGNORECASE)
CSS_EXTERNAL = re.compile(
    r"(?:@import\s+(?:url\()?|url\()\s*['\"]?(?P<url>(?:https?:)?//[^)'\"\s]+)",
    re.IGNORECASE,
)
JS_NETWORK_EXTERNAL = re.compile(
    r"(?:fetch\s*\(|new\s+(?:WebSocket|EventSource)\s*\(|\.open\s*\(\s*['\"](?:GET|POST|PUT|PATCH|DELETE)['\"]\s*,)"
    r"\s*['\"](?P<url>(?:https?:|wss?:)?//[^'\"]+)",
    re.IGNORECASE,
)


class ResourceParser(HTMLParser):
    """Collect resource-bearing attributes from production HTML."""

    RESOURCE_ATTRIBUTES = {
        "a": ("href",),
        "audio": ("src",),
        "form": ("action",),
        "iframe": ("src",),
        "img": ("src", "srcset"),
        "link": ("href",),
        "script": ("src",),
        "source": ("src", "srcset"),
        "video": ("src", "poster"),
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.resources: list[tuple[str, str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        wanted = self.RESOURCE_ATTRIBUTES.get(tag, ())
        for name, value in attrs:
            if name in wanted and value:
                for candidate in value.split(",") if name == "srcset" else (value,):
                    url = candidate.strip().split(maxsplit=1)[0]
                    self.resources.append((tag, name, url))


def audit(dist: Path) -> list[str]:
    problems: list[str] = []
    index = dist / "index.html"
    if not index.is_file():
        return [f"production entry point is missing: {index}"]

    parser = ResourceParser()
    parser.feed(index.read_text(encoding="utf-8"))
    for tag, attribute, url in parser.resources:
        if EXTERNAL_SCHEME.match(url):
            problems.append(f"index.html: external {tag}[{attribute}] resource: {url}")

    for path in sorted(dist.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".css", ".js", ".mjs"}:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        relative = path.relative_to(dist)
        if path.suffix.lower() == ".css":
            for match in CSS_EXTERNAL.finditer(text):
                problems.append(f"{relative}: external CSS resource: {match.group('url')}")
        else:
            for match in JS_NETWORK_EXTERNAL.finditer(text):
                problems.append(f"{relative}: external JavaScript network target: {match.group('url')}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "dist",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "frontend" / "dist",
    )
    args = parser.parse_args(argv)
    dist = args.dist.expanduser().resolve()
    problems = audit(dist)
    if problems:
        print("Offline bundle audit failed:", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1
    print(f"Offline bundle audit passed: {dist}")
    print("No external HTML/CSS resources or absolute JavaScript network targets detected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
