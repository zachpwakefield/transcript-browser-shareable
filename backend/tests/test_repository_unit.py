from __future__ import annotations

import unittest
from typing import Any, Sequence

from backend.app.repository import AnnotationRepository


class _RecordingSearchDatabase:
    def __init__(self) -> None:
        self.fts_parameters: tuple[Any, ...] | None = None

    def table_exists(self, table: str) -> bool:
        return table == "search_fts"

    def fetch_all(
        self, sql: str, parameters: Sequence[Any] = ()
    ) -> list[dict[str, Any]]:
        if "FROM search_entity" in sql:
            # Force this non-prefix query onto the FTS supplement path.
            return []
        if "FROM search_fts" in sql:
            self.fts_parameters = tuple(parameters)
            return [
                {
                    "entity_type": "gene",
                    "entity_id": "ENSG00000185591",
                    "label": "Zinc finger transcription factor SP1",
                    "priority": 0,
                    "exact_rank": 1,
                    "term_norm": "",
                }
            ]
        raise AssertionError(f"Unexpected query: {sql}")


class _SearchRepository(AnnotationRepository):
    def _search_result(
        self, entity_type: str, entity_id: str, label: str
    ) -> dict[str, Any] | None:
        return {"kind": entity_type, "id": entity_id, "label": label}


class SearchRepositoryTests(unittest.TestCase):
    def test_multi_token_fts_query_quotes_tokens_and_drops_match_punctuation(self) -> None:
        database = _RecordingSearchDatabase()
        repository = _SearchRepository(database)  # type: ignore[arg-type]

        result = repository.search('zinc-finger") OR secret*', limit=5)

        self.assertEqual(result["results"][0]["id"], "ENSG00000185591")
        self.assertIsNotNone(database.fts_parameters)
        self.assertEqual(
            database.fts_parameters,
            ('"zinc"* AND "finger"* AND "or"* AND "secret"*', 40),
        )


if __name__ == "__main__":
    unittest.main()
