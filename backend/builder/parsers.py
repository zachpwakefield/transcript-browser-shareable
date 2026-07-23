"""Streaming parsers and coordinate-independent validation helpers."""

from __future__ import annotations

import gzip
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


@dataclass(frozen=True)
class FastaRecord:
    header: str
    sequence: str


def file_digest(path: Path, algorithm: str, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def split_versioned_id(value: str | None) -> tuple[str | None, int | None, str | None]:
    if not value:
        return None, None, None
    base, separator, suffix = value.rpartition(".")
    if separator and base and suffix.isdigit():
        return base, int(suffix), value
    return value, None, value


def parse_gtf_attributes(raw: str) -> dict[str, list[str]]:
    """Parse GTF attributes without discarding repeated keys such as ``tag``."""

    result: dict[str, list[str]] = {}
    for item in raw.strip().rstrip(";").split(";"):
        item = item.strip()
        if not item:
            continue
        key, separator, value = item.partition(" ")
        if not separator:
            continue
        result.setdefault(key, []).append(value.strip().strip('"'))
    return result


def first(attributes: dict[str, list[str]], key: str) -> str | None:
    values = attributes.get(key)
    return values[0] if values else None


def stream_fasta(path: Path) -> Iterator[FastaRecord]:
    opener = gzip.open if path.suffix == ".gz" else open
    header: str | None = None
    chunks: list[str] = []
    with opener(path, "rt", encoding="ascii") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if header is not None:
                    yield FastaRecord(header, "".join(chunks).upper())
                header = line[1:]
                chunks = []
            else:
                if header is None:
                    raise ValueError(f"Sequence before FASTA header in {path}")
                chunks.append(line)
    if header is not None:
        yield FastaRecord(header, "".join(chunks).upper())


def parse_transcript_fasta_header(header: str) -> dict[str, object]:
    fields = header.split("|")
    transcript_base, transcript_version, transcript_versioned = split_versioned_id(fields[0])
    gene_base, gene_version, gene_versioned = split_versioned_id(fields[1] if len(fields) > 1 else None)
    result: dict[str, object] = {
        "transcript_id": transcript_base,
        "transcript_version": transcript_version,
        "transcript_id_versioned": transcript_versioned,
        "gene_id": gene_base,
        "gene_version": gene_version,
        "gene_id_versioned": gene_versioned,
        "transcript_name": fields[4] if len(fields) > 4 else None,
        "gene_symbol": fields[5] if len(fields) > 5 else None,
    }
    for field in fields[6:]:
        if field.isdigit() and "declared_length" not in result:
            result["declared_length"] = int(field)
        elif field.startswith("CDS:"):
            start_text, end_text = field[4:].split("-", 1)
            result["cds_start0"] = int(start_text) - 1
            result["cds_end0"] = int(end_text)
    return result


def parse_protein_fasta_header(header: str) -> dict[str, object]:
    fields = header.split("|")
    protein_base, protein_version, protein_versioned = split_versioned_id(fields[0])
    transcript_base, transcript_version, transcript_versioned = split_versioned_id(
        fields[1] if len(fields) > 1 else None
    )
    declared_length = None
    if fields and fields[-1].isdigit():
        declared_length = int(fields[-1])
    return {
        "protein_id": protein_base,
        "protein_version": protein_version,
        "protein_id_versioned": protein_versioned,
        "transcript_id": transcript_base,
        "transcript_version": transcript_version,
        "transcript_id_versioned": transcript_versioned,
        "declared_length": declared_length,
    }


def ucsc_bin(start0: int, end0: int) -> int:
    """Smallest UCSC hierarchical bin containing a half-open interval."""

    if start0 < 0 or end0 <= start0:
        raise ValueError(f"Invalid interval [{start0}, {end0})")
    end = end0 - 1
    if start0 >> 17 == end >> 17:
        return 4_681 + (start0 >> 17)
    if start0 >> 20 == end >> 20:
        return 585 + (start0 >> 20)
    if start0 >> 23 == end >> 23:
        return 73 + (start0 >> 23)
    if start0 >> 26 == end >> 26:
        return 9 + (start0 >> 26)
    if start0 >> 29 == end >> 29:
        return 1 + (start0 >> 29)
    return 0


CODON_TABLE = {
    # Phenylalanine / leucine
    "TTT": "F", "TTC": "F", "TTA": "L", "TTG": "L",
    "CTT": "L", "CTC": "L", "CTA": "L", "CTG": "L",
    # Isoleucine / methionine / valine
    "ATT": "I", "ATC": "I", "ATA": "I", "ATG": "M",
    "GTT": "V", "GTC": "V", "GTA": "V", "GTG": "V",
    # Serine / proline / threonine / alanine
    "TCT": "S", "TCC": "S", "TCA": "S", "TCG": "S",
    "CCT": "P", "CCC": "P", "CCA": "P", "CCG": "P",
    "ACT": "T", "ACC": "T", "ACA": "T", "ACG": "T",
    "GCT": "A", "GCC": "A", "GCA": "A", "GCG": "A",
    # Tyrosine / stop / histidine / glutamine / asparagine / lysine
    "TAT": "Y", "TAC": "Y", "TAA": "*", "TAG": "*",
    "CAT": "H", "CAC": "H", "CAA": "Q", "CAG": "Q",
    "AAT": "N", "AAC": "N", "AAA": "K", "AAG": "K",
    "GAT": "D", "GAC": "D", "GAA": "E", "GAG": "E",
    # Cysteine / tryptophan / arginine / serine / glycine
    "TGT": "C", "TGC": "C", "TGA": "*", "TGG": "W",
    "CGT": "R", "CGC": "R", "CGA": "R", "CGG": "R",
    "AGT": "S", "AGC": "S", "AGA": "R", "AGG": "R",
    "GGT": "G", "GGC": "G", "GGA": "G", "GGG": "G",
}


def translate_dna(sequence: str) -> str:
    sequence = sequence.upper().replace("U", "T")
    return "".join(
        CODON_TABLE.get(sequence[index : index + 3], "X")
        for index in range(0, len(sequence) - 2, 3)
    )


def proteins_equivalent(translated: str, supplied: str) -> bool:
    """Compare translations while allowing terminal stops and Sec-as-TGA."""

    left = translated
    right = supplied
    # A stop marker may be present in only one representation. Do not blindly
    # rstrip it: a same-length terminal TGA can represent selenocysteine (U),
    # and removing that residue would incorrectly classify the mapping.
    if left.endswith("*") and len(left) == len(right) + 1:
        left = left[:-1]
    if right.endswith("*") and len(right) == len(left) + 1:
        right = right[:-1]
    if left.endswith("*") and right.endswith("*"):
        left = left[:-1]
        right = right[:-1]
    if len(left) != len(right):
        return False
    return all(a == b or {a, b} == {"*", "U"} for a, b in zip(left, right))


RAW_SPAN_RE = re.compile(
    r"(?P<chrom>chr(?:[0-9]{1,2}|X|Y|M))[:_](?P<start>[0-9,]+)-(?P<end>[0-9,]+)"
)


def parse_raw_bounding_span(name: str) -> tuple[str | None, int | None, int | None]:
    match = RAW_SPAN_RE.search(name or "")
    if not match:
        return None, None, None
    return (
        match.group("chrom"),
        int(match.group("start").replace(",", "")),
        int(match.group("end").replace(",", "")),
    )
