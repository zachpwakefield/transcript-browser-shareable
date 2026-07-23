"""Immutable SQLite access and schema validation.

The annotation database is created by the offline builder.  Runtime code opens it
with both SQLite's immutable URI flag and ``PRAGMA query_only`` and never executes
schema or data mutations.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import sqlite3
import json
from typing import Any, Iterator, Mapping, Sequence
from urllib.parse import quote

from .constants import EXPECTED_SCHEMA_VERSION, REQUIRED_TABLE_COLUMNS
from .errors import StartupValidationError


def _immutable_sqlite_uri(path: Path) -> str:
    # Keep path separators readable while quoting URI-significant characters.
    encoded = quote(path.resolve().as_posix(), safe="/")
    return f"file:{encoded}?mode=ro&immutable=1"


@dataclass(frozen=True)
class DatabaseMetadata:
    schema_version: str
    build_hash: str
    values: Mapping[str, Any]


class AnnotationDatabase:
    """Small read-only database wrapper with parameterized-query helpers."""

    def __init__(self, path: Path):
        # Preserve the lexical final component so validation can reject a
        # symlink before resolution hides that fact. Package roots are resolved
        # separately by the runtime loader.
        self.lexical_path = path.absolute()
        self.path = self.lexical_path.resolve()
        self._uri = _immutable_sqlite_uri(self.path)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(
            self._uri,
            uri=True,
            check_same_thread=False,
            timeout=2.0,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 2000")
        try:
            yield connection
        finally:
            connection.close()

    def fetch_one(
        self, sql: str, parameters: Sequence[Any] = ()
    ) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(sql, tuple(parameters)).fetchone()
        return dict(row) if row is not None else None

    def fetch_all(
        self, sql: str, parameters: Sequence[Any] = ()
    ) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(sql, tuple(parameters)).fetchall()
        return [dict(row) for row in rows]

    def table_exists(self, table: str) -> bool:
        row = self.fetch_one(
            "SELECT 1 AS present FROM sqlite_master "
            "WHERE type IN ('table', 'view') AND name = ? LIMIT 1",
            (table,),
        )
        return row is not None

    def table_columns(self, table: str) -> frozenset[str]:
        # Table names come only from the hard-coded schema contract above.
        with self.connect() as connection:
            rows = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
        return frozenset(str(row[1]) for row in rows)

    def build_metadata(self) -> DatabaseMetadata:
        rows = self.fetch_all("SELECT key, value FROM build_manifest ORDER BY key")
        values: dict[str, Any] = {}
        for row in rows:
            raw = row["value"]
            try:
                values[str(row["key"])] = json.loads(str(raw))
            except (json.JSONDecodeError, TypeError):
                values[str(row["key"])] = str(raw)
        schema_version = str(values.get("schema_version", ""))
        build_hash = str(values.get("build_hash", ""))
        return DatabaseMetadata(schema_version, build_hash, values)

    def validate(self, *, full_integrity: bool = False) -> DatabaseMetadata:
        if self.lexical_path.is_symlink():
            raise StartupValidationError(
                "Annotation database must be a regular file, not a symbolic link."
            )
        if not self.lexical_path.is_file():
            raise StartupValidationError(
                f"Annotation database is missing: {self.lexical_path}"
            )

        try:
            with self.connect() as connection:
                # Opening the schema is a bounded startup check. A complete
                # quick_check scans the full annotation database and would make
                # the normal server-ready budget depend on database size; the
                # deterministic builder already performs that release gate.
                connection.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()
                quick_check = (
                    connection.execute("PRAGMA quick_check").fetchone()
                    if full_integrity
                    else None
                )
        except sqlite3.Error as exc:
            raise StartupValidationError(
                f"Cannot open the annotation database read-only: {exc}"
            ) from exc

        if full_integrity and (
            quick_check is None or str(quick_check[0]).lower() != "ok"
        ):
            result = "unknown" if quick_check is None else str(quick_check[0])
            raise StartupValidationError(
                f"SQLite integrity validation failed: {result}"
            )

        missing_tables: list[str] = []
        bad_columns: list[str] = []
        for table, required in REQUIRED_TABLE_COLUMNS.items():
            if not self.table_exists(table):
                missing_tables.append(table)
                continue
            actual = self.table_columns(table)
            missing = sorted(required - actual)
            if missing:
                bad_columns.append(f"{table}({', '.join(missing)})")

        if missing_tables or bad_columns:
            details: list[str] = []
            if missing_tables:
                details.append("missing tables: " + ", ".join(sorted(missing_tables)))
            if bad_columns:
                details.append("missing columns: " + "; ".join(bad_columns))
            raise StartupValidationError(
                "Annotation database schema is incompatible; " + "; ".join(details)
            )

        metadata = self.build_metadata()
        if metadata.schema_version != EXPECTED_SCHEMA_VERSION:
            raise StartupValidationError(
                "Annotation database schema version "
                f"{metadata.schema_version or '<missing>'} is not supported; "
                f"expected {EXPECTED_SCHEMA_VERSION}. Rebuild the annotations."
            )
        if not metadata.build_hash:
            raise StartupValidationError(
                "Annotation database build_manifest has no build_hash."
            )
        return metadata
