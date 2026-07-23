"""SQLite schema and deterministic post-ingestion transforms."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from array import array
from pathlib import Path

from .constants import DENSITY_TILE_SIZES
from .parsers import ucsc_bin


SCHEMA_SQL = """
CREATE TABLE build_manifest (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE contig (
    name TEXT PRIMARY KEY,
    length INTEGER NOT NULL CHECK(length > 0),
    display_order INTEGER NOT NULL UNIQUE,
    is_primary INTEGER NOT NULL DEFAULT 1 CHECK(is_primary IN (0, 1)),
    fasta_name TEXT NOT NULL UNIQUE
) WITHOUT ROWID;

CREATE TABLE contig_alias (
    alias TEXT PRIMARY KEY,
    contig_name TEXT NOT NULL REFERENCES contig(name)
) WITHOUT ROWID;

CREATE TABLE gene (
    gene_id TEXT PRIMARY KEY,
    gene_id_versioned TEXT NOT NULL UNIQUE,
    gene_version INTEGER,
    symbol TEXT NOT NULL,
    hgnc_id TEXT,
    havana_gene_id TEXT,
    havana_gene_id_versioned TEXT,
    havana_gene_version INTEGER,
    biotype TEXT NOT NULL,
    contig TEXT NOT NULL REFERENCES contig(name),
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL CHECK(strand IN ('+', '-')),
    bin INTEGER NOT NULL,
    level INTEGER,
    CHECK(start0 >= 0 AND end0 > start0)
) WITHOUT ROWID;

CREATE TABLE gene_tag (
    gene_id TEXT NOT NULL REFERENCES gene(gene_id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    PRIMARY KEY (gene_id, tag, ordinal)
) WITHOUT ROWID;

CREATE TABLE transcript (
    transcript_id TEXT PRIMARY KEY,
    transcript_id_versioned TEXT NOT NULL UNIQUE,
    transcript_version INTEGER,
    gene_id TEXT NOT NULL REFERENCES gene(gene_id),
    transcript_name TEXT NOT NULL,
    biotype TEXT NOT NULL,
    havana_transcript_id TEXT,
    havana_transcript_id_versioned TEXT,
    havana_transcript_version INTEGER,
    protein_id TEXT,
    protein_id_versioned TEXT,
    protein_version INTEGER,
    contig TEXT NOT NULL REFERENCES contig(name),
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL CHECK(strand IN ('+', '-')),
    bin INTEGER NOT NULL,
    transcript_length INTEGER,
    cds_length INTEGER,
    protein_length INTEGER,
    level INTEGER,
    tsl TEXT,
    ccds_id TEXT,
    appris TEXT,
    is_basic INTEGER NOT NULL DEFAULT 0 CHECK(is_basic IN (0, 1)),
    is_mane_select INTEGER NOT NULL DEFAULT 0 CHECK(is_mane_select IN (0, 1)),
    is_mane_plus_clinical INTEGER NOT NULL DEFAULT 0 CHECK(is_mane_plus_clinical IN (0, 1)),
    is_ensembl_canonical INTEGER NOT NULL DEFAULT 0 CHECK(is_ensembl_canonical IN (0, 1)),
    CHECK(start0 >= 0 AND end0 > start0)
) WITHOUT ROWID;

CREATE TABLE transcript_tag (
    transcript_id TEXT NOT NULL REFERENCES transcript(transcript_id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    PRIMARY KEY (transcript_id, tag, ordinal)
) WITHOUT ROWID;

CREATE TABLE exon (
    transcript_id TEXT NOT NULL REFERENCES transcript(transcript_id) ON DELETE CASCADE,
    exon_rank INTEGER NOT NULL CHECK(exon_rank > 0),
    exon_id TEXT,
    exon_id_versioned TEXT,
    exon_version INTEGER,
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL CHECK(strand IN ('+', '-')),
    phase INTEGER,
    transcript_start0 INTEGER,
    transcript_end0 INTEGER,
    bin INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, exon_rank),
    CHECK(start0 >= 0 AND end0 > start0)
) WITHOUT ROWID;

CREATE TABLE cds_segment (
    transcript_id TEXT NOT NULL REFERENCES transcript(transcript_id) ON DELETE CASCADE,
    segment_rank INTEGER NOT NULL CHECK(segment_rank > 0),
    exon_rank INTEGER NOT NULL,
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL CHECK(strand IN ('+', '-')),
    phase INTEGER,
    transcript_start0 INTEGER NOT NULL,
    transcript_end0 INTEGER NOT NULL,
    coding_start0 INTEGER,
    coding_end0 INTEGER,
    bin INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, segment_rank),
    FOREIGN KEY (transcript_id, exon_rank) REFERENCES exon(transcript_id, exon_rank),
    CHECK(start0 >= 0 AND end0 > start0)
) WITHOUT ROWID;

CREATE TABLE utr_segment (
    transcript_id TEXT NOT NULL REFERENCES transcript(transcript_id) ON DELETE CASCADE,
    segment_rank INTEGER NOT NULL CHECK(segment_rank > 0),
    exon_rank INTEGER NOT NULL,
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL CHECK(strand IN ('+', '-')),
    phase INTEGER,
    transcript_start0 INTEGER NOT NULL,
    transcript_end0 INTEGER NOT NULL,
    bin INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, segment_rank),
    FOREIGN KEY (transcript_id, exon_rank) REFERENCES exon(transcript_id, exon_rank),
    CHECK(start0 >= 0 AND end0 > start0)
) WITHOUT ROWID;

CREATE TABLE codon_segment (
    transcript_id TEXT NOT NULL REFERENCES transcript(transcript_id) ON DELETE CASCADE,
    codon_type TEXT NOT NULL CHECK(codon_type IN ('start_codon', 'stop_codon')),
    segment_rank INTEGER NOT NULL CHECK(segment_rank > 0),
    exon_rank INTEGER NOT NULL,
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL CHECK(strand IN ('+', '-')),
    phase INTEGER,
    bin INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, codon_type, segment_rank),
    FOREIGN KEY (transcript_id, exon_rank) REFERENCES exon(transcript_id, exon_rank)
) WITHOUT ROWID;

CREATE TABLE selenocysteine_segment (
    transcript_id TEXT NOT NULL REFERENCES transcript(transcript_id) ON DELETE CASCADE,
    segment_rank INTEGER NOT NULL CHECK(segment_rank > 0),
    exon_rank INTEGER NOT NULL,
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL CHECK(strand IN ('+', '-')),
    phase INTEGER,
    bin INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, segment_rank),
    FOREIGN KEY (transcript_id, exon_rank) REFERENCES exon(transcript_id, exon_rank)
) WITHOUT ROWID;

CREATE TABLE translation_mapping (
    transcript_id TEXT PRIMARY KEY REFERENCES transcript(transcript_id) ON DELETE CASCADE,
    cds_start0 INTEGER,
    cds_end0 INTEGER,
    status TEXT NOT NULL CHECK(status IN ('exact', 'partial', 'unresolved')),
    reason TEXT NOT NULL,
    validated_nt_length INTEGER,
    protein_length INTEGER
) WITHOUT ROWID;

CREATE TABLE sequence (
    transcript_id TEXT NOT NULL REFERENCES transcript(transcript_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('transcript_full', 'cds', 'protein')),
    sequence TEXT NOT NULL,
    length INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (transcript_id, kind),
    CHECK(length = length(sequence))
) WITHOUT ROWID;

CREATE TABLE protein_feature (
    feature_id TEXT PRIMARY KEY,
    source_record_hash TEXT NOT NULL,
    duplicate_ordinal INTEGER NOT NULL CHECK(duplicate_ordinal > 0),
    transcript_id TEXT NOT NULL REFERENCES transcript(transcript_id) ON DELETE CASCADE,
    raw_transcript_id TEXT NOT NULL,
    protein_id TEXT,
    protein_id_versioned TEXT,
    protein_version INTEGER,
    raw_peptide_id TEXT,
    source TEXT NOT NULL,
    database_name TEXT,
    accession TEXT,
    display_name TEXT,
    alt_name TEXT,
    method TEXT,
    aa_start1 INTEGER NOT NULL,
    aa_end1 INTEGER NOT NULL,
    raw_name TEXT,
    raw_chr TEXT,
    raw_start1 INTEGER,
    raw_end1 INTEGER,
    raw_strand TEXT,
    CHECK(aa_start1 >= 1 AND aa_end1 >= aa_start1),
    UNIQUE(source_record_hash, duplicate_ordinal)
) WITHOUT ROWID;

CREATE TABLE protein_feature_segment (
    feature_id TEXT NOT NULL REFERENCES protein_feature(feature_id) ON DELETE CASCADE,
    segment_rank INTEGER NOT NULL CHECK(segment_rank > 0),
    exon_rank INTEGER NOT NULL,
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    nt_start0 INTEGER NOT NULL,
    nt_end0 INTEGER NOT NULL,
    bin INTEGER NOT NULL,
    PRIMARY KEY (feature_id, segment_rank),
    CHECK(start0 >= 0 AND end0 > start0),
    CHECK(nt_start0 >= 0 AND nt_end0 > nt_start0)
) WITHOUT ROWID;

CREATE TABLE search_entity (
    search_id INTEGER PRIMARY KEY,
    term TEXT NOT NULL,
    term_norm TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    label TEXT NOT NULL,
    priority INTEGER NOT NULL,
    UNIQUE(term_norm, entity_type, entity_id)
);

CREATE VIRTUAL TABLE search_fts USING fts5(
    term,
    label,
    entity_type UNINDEXED,
    entity_id UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE density_tile (
    contig TEXT NOT NULL REFERENCES contig(name),
    tile_size INTEGER NOT NULL CHECK(tile_size > 0),
    tile_start0 INTEGER NOT NULL CHECK(tile_start0 >= 0),
    tile_end0 INTEGER NOT NULL CHECK(tile_end0 > tile_start0),
    gene_count INTEGER NOT NULL CHECK(gene_count >= 0),
    transcript_count INTEGER NOT NULL CHECK(transcript_count >= 0),
    PRIMARY KEY (contig, tile_size, tile_start0)
) WITHOUT ROWID;

CREATE TABLE _cds_raw (
    transcript_id TEXT NOT NULL,
    exon_rank INTEGER NOT NULL,
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL,
    phase INTEGER
);
CREATE TABLE _utr_raw (
    transcript_id TEXT NOT NULL,
    exon_rank INTEGER NOT NULL,
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL,
    phase INTEGER
);
CREATE TABLE _codon_raw (
    transcript_id TEXT NOT NULL,
    codon_type TEXT NOT NULL,
    exon_rank INTEGER NOT NULL,
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL,
    phase INTEGER
);
CREATE TABLE _selenocysteine_raw (
    transcript_id TEXT NOT NULL,
    exon_rank INTEGER NOT NULL,
    start0 INTEGER NOT NULL,
    end0 INTEGER NOT NULL,
    strand TEXT NOT NULL,
    phase INTEGER
);
"""


INDEX_SQL = """
CREATE INDEX gene_region_idx ON gene(contig, bin, start0, end0);
CREATE INDEX gene_symbol_idx ON gene(symbol COLLATE NOCASE);
CREATE INDEX transcript_gene_idx ON transcript(gene_id);
CREATE INDEX transcript_region_idx ON transcript(contig, bin, start0, end0);
CREATE INDEX transcript_name_idx ON transcript(transcript_name COLLATE NOCASE);
CREATE INDEX transcript_protein_idx ON transcript(protein_id);
CREATE INDEX exon_region_idx ON exon(bin, start0, end0);
CREATE INDEX cds_region_idx ON cds_segment(bin, start0, end0);
CREATE INDEX feature_transcript_source_idx ON protein_feature(transcript_id, source);
CREATE INDEX feature_aa_idx ON protein_feature(transcript_id, aa_start1, aa_end1);
CREATE INDEX feature_segment_region_idx ON protein_feature_segment(bin, start0, end0);
CREATE INDEX search_exact_idx ON search_entity(term_norm, priority, entity_type);
CREATE INDEX density_tile_region_idx
    ON density_tile(contig, tile_size, tile_start0, tile_end0);
ANALYZE;
"""


def connect_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.create_function("ucsc_bin", 2, ucsc_bin, deterministic=True)
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA journal_mode=OFF")
    connection.execute("PRAGMA synchronous=OFF")
    connection.execute("PRAGMA temp_store=MEMORY")
    connection.execute("PRAGMA cache_size=-131072")
    return connection


def create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA_SQL)


def _update_exon_transcript_coordinates(connection: sqlite3.Connection) -> None:
    updates: list[tuple[int, int, str, int]] = []
    active_transcript: str | None = None
    offset = 0
    cursor = connection.execute(
        "SELECT transcript_id, exon_rank, start0, end0 "
        "FROM exon ORDER BY transcript_id, exon_rank"
    )
    for row in cursor:
        if row["transcript_id"] != active_transcript:
            active_transcript = row["transcript_id"]
            offset = 0
        length = row["end0"] - row["start0"]
        updates.append((offset, offset + length, row["transcript_id"], row["exon_rank"]))
        offset += length
        if len(updates) >= 20_000:
            connection.executemany(
                "UPDATE exon SET transcript_start0=?, transcript_end0=? "
                "WHERE transcript_id=? AND exon_rank=?",
                updates,
            )
            updates.clear()
    if updates:
        connection.executemany(
            "UPDATE exon SET transcript_start0=?, transcript_end0=? "
            "WHERE transcript_id=? AND exon_rank=?",
            updates,
        )


def finalize_gtf_geometry(connection: sqlite3.Connection) -> None:
    _update_exon_transcript_coordinates(connection)

    connection.executescript(
        """
        INSERT INTO cds_segment(
            transcript_id, segment_rank, exon_rank, start0, end0, strand, phase,
            transcript_start0, transcript_end0, coding_start0, coding_end0, bin
        )
        SELECT
            raw.transcript_id,
            row_number() OVER (
                PARTITION BY raw.transcript_id
                ORDER BY raw.exon_rank,
                    CASE WHEN raw.strand='+' THEN raw.start0 ELSE -raw.start0 END
            ),
            raw.exon_rank,
            raw.start0,
            raw.end0,
            raw.strand,
            raw.phase,
            exon.transcript_start0 + CASE
                WHEN raw.strand='+' THEN raw.start0 - exon.start0
                ELSE exon.end0 - raw.end0
            END,
            exon.transcript_start0 + CASE
                WHEN raw.strand='+' THEN raw.end0 - exon.start0
                ELSE exon.end0 - raw.start0
            END,
            NULL,
            NULL,
            ucsc_bin(raw.start0, raw.end0)
        FROM _cds_raw AS raw
        JOIN exon USING(transcript_id, exon_rank);

        INSERT INTO utr_segment(
            transcript_id, segment_rank, exon_rank, start0, end0, strand, phase,
            transcript_start0, transcript_end0, bin
        )
        SELECT
            raw.transcript_id,
            row_number() OVER (
                PARTITION BY raw.transcript_id
                ORDER BY raw.exon_rank,
                    CASE WHEN raw.strand='+' THEN raw.start0 ELSE -raw.start0 END
            ),
            raw.exon_rank,
            raw.start0,
            raw.end0,
            raw.strand,
            raw.phase,
            exon.transcript_start0 + CASE
                WHEN raw.strand='+' THEN raw.start0 - exon.start0
                ELSE exon.end0 - raw.end0
            END,
            exon.transcript_start0 + CASE
                WHEN raw.strand='+' THEN raw.end0 - exon.start0
                ELSE exon.end0 - raw.start0
            END,
            ucsc_bin(raw.start0, raw.end0)
        FROM _utr_raw AS raw
        JOIN exon USING(transcript_id, exon_rank);

        INSERT INTO codon_segment(
            transcript_id, codon_type, segment_rank, exon_rank, start0, end0,
            strand, phase, bin
        )
        SELECT
            raw.transcript_id,
            raw.codon_type,
            row_number() OVER (
                PARTITION BY raw.transcript_id, raw.codon_type
                ORDER BY raw.exon_rank,
                    CASE WHEN raw.strand='+' THEN raw.start0 ELSE -raw.start0 END
            ),
            raw.exon_rank,
            raw.start0,
            raw.end0,
            raw.strand,
            raw.phase,
            ucsc_bin(raw.start0, raw.end0)
        FROM _codon_raw AS raw;

        INSERT INTO selenocysteine_segment(
            transcript_id, segment_rank, exon_rank, start0, end0, strand, phase, bin
        )
        SELECT
            raw.transcript_id,
            row_number() OVER (
                PARTITION BY raw.transcript_id
                ORDER BY raw.exon_rank,
                    CASE WHEN raw.strand='+' THEN raw.start0 ELSE -raw.start0 END
            ),
            raw.exon_rank,
            raw.start0,
            raw.end0,
            raw.strand,
            raw.phase,
            ucsc_bin(raw.start0, raw.end0)
        FROM _selenocysteine_raw AS raw;

        UPDATE transcript
        SET transcript_length = (
            SELECT SUM(end0 - start0) FROM exon WHERE exon.transcript_id=transcript.transcript_id
        ),
        cds_length = (
            SELECT SUM(end0 - start0) FROM cds_segment
            WHERE cds_segment.transcript_id=transcript.transcript_id
        );

        DROP TABLE _cds_raw;
        DROP TABLE _utr_raw;
        DROP TABLE _codon_raw;
        DROP TABLE _selenocysteine_raw;
        """
    )


def populate_density_tiles(connection: sqlite3.Connection) -> int:
    """Materialize complete overlap-count tiles at the pinned density levels.

    An entity contributes to every half-open tile it overlaps.  Difference
    arrays keep this linear in entity count plus output tile count and avoid an
    interval join that would make full-build memory and runtime unpredictable.
    """

    contigs = {
        row["name"]: row["length"]
        for row in connection.execute("SELECT name,length FROM contig ORDER BY display_order")
    }
    deltas: dict[tuple[str, int], tuple[array, array]] = {}
    for contig, length in contigs.items():
        for tile_size in DENSITY_TILE_SIZES:
            tile_count = (length + tile_size - 1) // tile_size
            deltas[(contig, tile_size)] = (
                array("q", [0]) * (tile_count + 1),
                array("q", [0]) * (tile_count + 1),
            )

    def accumulate(table: str, dimension: int) -> None:
        for row in connection.execute(
            f"SELECT contig,start0,end0 FROM {table} ORDER BY contig,start0,end0"
        ):
            for tile_size in DENSITY_TILE_SIZES:
                delta = deltas[(row["contig"], tile_size)][dimension]
                first_tile = row["start0"] // tile_size
                last_tile = (row["end0"] - 1) // tile_size
                delta[first_tile] += 1
                delta[last_tile + 1] -= 1

    accumulate("gene", 0)
    accumulate("transcript", 1)

    rows: list[tuple[str, int, int, int, int, int]] = []
    inserted = 0
    for contig, length in contigs.items():
        for tile_size in DENSITY_TILE_SIZES:
            gene_delta, transcript_delta = deltas[(contig, tile_size)]
            gene_count = 0
            transcript_count = 0
            for tile_index in range(len(gene_delta) - 1):
                gene_count += gene_delta[tile_index]
                transcript_count += transcript_delta[tile_index]
                tile_start0 = tile_index * tile_size
                rows.append(
                    (
                        contig,
                        tile_size,
                        tile_start0,
                        min(tile_start0 + tile_size, length),
                        gene_count,
                        transcript_count,
                    )
                )
                if len(rows) >= 20_000:
                    connection.executemany(
                        "INSERT INTO density_tile(contig,tile_size,tile_start0,tile_end0,"
                        "gene_count,transcript_count) VALUES(?,?,?,?,?,?)",
                        rows,
                    )
                    inserted += len(rows)
                    rows.clear()
    if rows:
        connection.executemany(
            "INSERT INTO density_tile(contig,tile_size,tile_start0,tile_end0,"
            "gene_count,transcript_count) VALUES(?,?,?,?,?,?)",
            rows,
        )
        inserted += len(rows)
    return inserted

def populate_search(connection: sqlite3.Connection) -> None:
    def add(term: str | None, entity_type: str, entity_id: str, label: str, priority: int) -> None:
        if not term:
            return
        connection.execute(
            "INSERT OR IGNORE INTO search_entity"
            "(term, term_norm, entity_type, entity_id, label, priority) VALUES(?,?,?,?,?,?)",
            (term, term.casefold(), entity_type, entity_id, label, priority),
        )

    for row in connection.execute(
        "SELECT gene_id, gene_id_versioned, symbol, havana_gene_id, "
        "havana_gene_id_versioned, contig, start0, end0 FROM gene ORDER BY gene_id"
    ):
        label = f"{row['symbol']} · {row['gene_id_versioned']} · {row['contig']}:{row['start0'] + 1}-{row['end0']}"
        add(row["symbol"], "gene", row["gene_id"], label, 100)
        add(row["gene_id"], "gene", row["gene_id"], label, 95)
        add(row["gene_id_versioned"], "gene", row["gene_id"], label, 98)
        add(row["havana_gene_id"], "gene", row["gene_id"], label, 74)
        add(row["havana_gene_id_versioned"], "gene", row["gene_id"], label, 75)

    for row in connection.execute(
        "SELECT transcript_id, transcript_id_versioned, transcript_name, protein_id, "
        "protein_id_versioned, havana_transcript_id, havana_transcript_id_versioned "
        "FROM transcript ORDER BY transcript_id"
    ):
        label = f"{row['transcript_name']} · {row['transcript_id_versioned']}"
        add(row["transcript_name"], "transcript", row["transcript_id"], label, 90)
        add(row["transcript_id"], "transcript", row["transcript_id"], label, 92)
        add(row["transcript_id_versioned"], "transcript", row["transcript_id"], label, 94)
        add(row["protein_id"], "protein", row["transcript_id"], label, 88)
        add(row["protein_id_versioned"], "protein", row["transcript_id"], label, 89)
        add(row["havana_transcript_id"], "transcript", row["transcript_id"], label, 74)
        add(row["havana_transcript_id_versioned"], "transcript", row["transcript_id"], label, 75)

    for row in connection.execute(
        "SELECT DISTINCT exon_id, exon_id_versioned FROM exon "
        "WHERE exon_id IS NOT NULL ORDER BY exon_id, exon_id_versioned"
    ):
        label = row["exon_id_versioned"] or row["exon_id"]
        add(row["exon_id"], "exon", row["exon_id"], label, 70)
        add(row["exon_id_versioned"], "exon", row["exon_id"], label, 72)

    connection.execute("DELETE FROM search_fts")
    connection.execute(
        "INSERT INTO search_fts(rowid, term, label, entity_type, entity_id) "
        "SELECT search_id, term, label, entity_type, entity_id FROM search_entity ORDER BY search_id"
    )


def create_indexes(connection: sqlite3.Connection) -> None:
    connection.executescript(INDEX_SQL)


HASHED_TABLES = (
    "contig",
    "contig_alias",
    "gene",
    "gene_tag",
    "transcript",
    "transcript_tag",
    "exon",
    "cds_segment",
    "utr_segment",
    "codon_segment",
    "selenocysteine_segment",
    "translation_mapping",
    "sequence",
    "protein_feature",
    "protein_feature_segment",
    "density_tile",
    "search_entity",
)


def canonical_table_hashes(connection: sqlite3.Connection) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for table in HASHED_TABLES:
        table_info = list(connection.execute(f"PRAGMA table_info({table})"))
        columns = [row["name"] for row in table_info]
        if not columns:
            continue
        quoted = ",".join(f'"{column}"' for column in columns)
        primary_key = [
            row["name"]
            for row in sorted(table_info, key=lambda item: item["pk"])
            if row["pk"]
        ]
        # Canonical rows include every column, but sorting by the declared key
        # avoids materializing long sequence/blob columns in SQLite's sorter.
        order_columns = primary_key or columns
        order = ",".join(f'"{column}"' for column in order_columns)
        digest = hashlib.sha256()
        for row in connection.execute(f"SELECT {quoted} FROM {table} ORDER BY {order}"):
            payload = json.dumps(list(row), ensure_ascii=True, separators=(",", ":"))
            digest.update(payload.encode("utf-8"))
            digest.update(b"\n")
        hashes[table] = digest.hexdigest()
    return hashes
