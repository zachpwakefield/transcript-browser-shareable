"""Bounded, text-extractable transcript PDF reports.

The report is generated entirely from the verified local package.  It uses
ReportLab's standard fonts and vector primitives, so no browser screenshot,
remote asset, or genome registry participates in the export.
"""

from __future__ import annotations

from datetime import datetime
from html import escape
from io import BytesIO
import math
import re
from typing import Any, Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    Flowable,
    LongTable,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


MAX_PDF_TRANSCRIPTS = 20
MAX_PDF_FEATURE_ROWS = 2_000
MAX_PDF_SEQUENCE_CHARS = 20_000
MAX_PDF_SEQUENCE_EXCERPT = 10_000
MAX_PDF_PAGES = 100
MAX_PDF_BYTES = 25 * 1024 * 1024

PdfSection = Literal["summary", "structure", "features", "sequence"]
SequenceKind = Literal["transcript_full", "cds", "protein"]
StructureScope = Literal["full", "current_locus"]


class PdfLocus(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    chrom: str = Field(min_length=1, max_length=64)
    start0: int = Field(ge=0)
    end0: int = Field(gt=0)

    @model_validator(mode="after")
    def valid_interval(self) -> "PdfLocus":
        if self.end0 <= self.start0:
            raise ValueError("locus end0 must be greater than start0")
        return self


class PdfSequenceExcerpt(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    kind: SequenceKind
    start1: int = Field(ge=1)
    end1: int = Field(ge=1)

    @model_validator(mode="after")
    def valid_range(self) -> "PdfSequenceExcerpt":
        if self.end1 < self.start1:
            raise ValueError("sequence end1 must be greater than or equal to start1")
        if self.end1 - self.start1 + 1 > MAX_PDF_SEQUENCE_EXCERPT:
            raise ValueError(
                f"one sequence excerpt may contain at most {MAX_PDF_SEQUENCE_EXCERPT:,} characters"
            )
        return self


class PdfReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    build_hash: str = Field(alias="buildHash", min_length=1, max_length=128)
    gene_id: str = Field(alias="geneId", min_length=1, max_length=128)
    transcript_ids: list[str] = Field(
        alias="transcriptIds", min_length=1, max_length=MAX_PDF_TRANSCRIPTS
    )
    sections: list[PdfSection] = Field(min_length=1, max_length=4)
    feature_sources: list[str] = Field(
        alias="featureSources", default_factory=list, max_length=7
    )
    structure_scope: StructureScope = Field(alias="structureScope", default="full")
    locus: PdfLocus | None = None
    sequence_excerpt: PdfSequenceExcerpt | None = Field(
        alias="sequenceExcerpt", default=None
    )

    @model_validator(mode="after")
    def coherent_request(self) -> "PdfReportRequest":
        if len(set(self.transcript_ids)) != len(self.transcript_ids):
            raise ValueError("transcriptIds must not contain duplicates")
        if len(set(self.sections)) != len(self.sections):
            raise ValueError("sections must not contain duplicates")
        normalized_sources = [item.casefold() for item in self.feature_sources]
        if len(set(normalized_sources)) != len(normalized_sources):
            raise ValueError("featureSources must not contain duplicates")
        for identifier in self.transcript_ids:
            if len(identifier) > 128 or not re.fullmatch(r"[A-Za-z0-9_.:-]+", identifier):
                raise ValueError("transcriptIds contains an invalid identifier")
        for source in self.feature_sources:
            if len(source) > 80 or not re.fullmatch(r"[A-Za-z0-9_.:-]+", source):
                raise ValueError("featureSources contains an invalid source")
        if self.structure_scope == "current_locus" and self.locus is None:
            raise ValueError("current_locus structure scope requires locus")
        if "sequence" in self.sections and self.sequence_excerpt is None:
            raise ValueError("the sequence section requires sequenceExcerpt")
        return self


class PdfReportLimitError(ValueError):
    """The requested report would exceed an explicit export bound."""


def _plain(value: Any) -> str:
    """Normalize dynamic text to the standard-font WinAnsi repertoire."""

    text = "" if value is None else str(value)
    text = (
        text.replace("\u00a0", " ")
        .replace("\u2010", "-")
        .replace("\u2011", "-")
        .replace("\u2012", "-")
        .replace("\u2013", "-")
        .replace("\u2014", "-")
        .replace("\u2212", "-")
        .replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2026", "...")
    )
    return text.encode("cp1252", errors="replace").decode("cp1252")


def _paragraph_text(value: Any) -> str:
    return escape(_plain(value), quote=True)


def _display_locus(chrom: str, start0: int, end0: int) -> str:
    return f"{_plain(chrom)}:{int(start0) + 1:,}-{int(end0):,}"


def _overlaps(start0: int, end0: int, item: dict[str, Any]) -> bool:
    raw_start = item.get("start0")
    raw_end = item.get("end0")
    return (
        raw_start is not None
        and raw_end is not None
        and int(raw_start) < end0
        and int(raw_end) > start0
    )


class TranscriptStructureFlowable(Flowable):
    """One shared-scale transcript model drawn with selectable-text captions."""

    def __init__(
        self,
        transcript: dict[str, Any],
        domain_start0: int,
        domain_end0: int,
    ) -> None:
        super().__init__()
        self.transcript = transcript
        self.domain_start0 = domain_start0
        self.domain_end0 = max(domain_start0 + 1, domain_end0)
        self.width = 0.0
        self.height = 72.0

    def wrap(self, avail_width: float, avail_height: float) -> tuple[float, float]:
        self.width = avail_width
        return avail_width, self.height

    def _x(self, coordinate: int) -> float:
        fraction = (coordinate - self.domain_start0) / (
            self.domain_end0 - self.domain_start0
        )
        return max(0.0, min(self.width, fraction * self.width))

    def draw(self) -> None:
        drawing = self.canv
        baseline_y = 33.0
        transcript_start = int(self.transcript.get("start0") or 0)
        transcript_end = int(self.transcript.get("end0") or transcript_start + 1)
        if transcript_end <= self.domain_start0 or transcript_start >= self.domain_end0:
            drawing.setFillColor(colors.HexColor("#68756e"))
            drawing.setFont("Helvetica-Oblique", 8)
            drawing.drawString(0, baseline_y, "Transcript lies outside this structure interval.")
            return

        drawing.setStrokeColor(colors.HexColor("#68756e"))
        drawing.setLineWidth(0.7)
        start_x = self._x(max(transcript_start, self.domain_start0))
        end_x = self._x(min(transcript_end, self.domain_end0))
        drawing.line(start_x, baseline_y, end_x, baseline_y)

        drawing.setStrokeColor(colors.HexColor("#214f45"))
        drawing.setFillColor(colors.HexColor("#dce6df"))
        for exon in self.transcript.get("exons") or []:
            if not _overlaps(self.domain_start0, self.domain_end0, exon):
                continue
            exon_start = max(int(exon["start0"]), self.domain_start0)
            exon_end = min(int(exon["end0"]), self.domain_end0)
            x0 = self._x(exon_start)
            x1 = self._x(exon_end)
            width = max(1.5, x1 - x0)
            width = min(width, max(0.0, self.width - x0))
            drawing.rect(x0, baseline_y - 7, width, 14, stroke=1, fill=1)

        drawing.setFillColor(colors.HexColor("#1f6e62"))
        drawing.setStrokeColor(colors.HexColor("#1f6e62"))
        for segment in self.transcript.get("cdsSegments") or []:
            if not _overlaps(self.domain_start0, self.domain_end0, segment):
                continue
            segment_start = max(int(segment["start0"]), self.domain_start0)
            segment_end = min(int(segment["end0"]), self.domain_end0)
            x0 = self._x(segment_start)
            x1 = self._x(segment_end)
            width = max(1.5, x1 - x0)
            width = min(width, max(0.0, self.width - x0))
            drawing.rect(x0, baseline_y - 7, width, 14, stroke=0, fill=1)

        drawing.setFillColor(colors.HexColor("#214f45"))
        strand = self.transcript.get("strand")
        if strand == "-":
            x = start_x
            drawing.line(x + 7, baseline_y + 4, x, baseline_y)
            drawing.line(x + 7, baseline_y - 4, x, baseline_y)
        else:
            x = end_x
            drawing.line(x - 7, baseline_y + 4, x, baseline_y)
            drawing.line(x - 7, baseline_y - 4, x, baseline_y)

        drawing.setFillColor(colors.HexColor("#5f6b64"))
        drawing.setFont("Helvetica", 7)
        drawing.drawString(
            0,
            7,
            _plain(
                _display_locus(
                    str(self.transcript.get("chr") or ""),
                    self.domain_start0,
                    self.domain_end0,
                )
            ),
        )
        drawing.drawRightString(
            self.width,
            7,
            "shared genomic scale - 1-based inclusive labels",
        )


class NumberedCanvas(canvas.Canvas):
    def __init__(
        self,
        *args: Any,
        header_label: str,
        build_hash: str,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._saved_page_states: list[dict[str, Any]] = []
        self._header_label = _plain(header_label)
        self._build_hash = _plain(build_hash)

    def showPage(self) -> None:  # noqa: N802 - ReportLab API
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self) -> None:
        page_count = len(self._saved_page_states)
        for page_number, state in enumerate(self._saved_page_states, start=1):
            self.__dict__.update(state)
            self._draw_header_footer(page_number, page_count)
            super().showPage()
        super().save()

    def _draw_header_footer(self, page_number: int, page_count: int) -> None:
        width, height = letter
        self.saveState()
        self.setStrokeColor(colors.HexColor("#cbd1cb"))
        self.setLineWidth(0.4)
        self.line(42, height - 32, width - 42, height - 32)
        self.setFillColor(colors.HexColor("#536159"))
        self.setFont("Helvetica-Bold", 7)
        self.drawString(42, height - 24, self._header_label)
        self.setFont("Helvetica", 7)
        self.drawRightString(width - 42, height - 24, "Local, text-extractable PDF")
        self.line(42, 31, width - 42, 31)
        self.drawString(42, 20, f"Build {self._build_hash[:16]}")
        self.drawCentredString(width / 2, 20, "Machine coordinates: 0-based half-open")
        self.drawRightString(width - 42, 20, f"Page {page_number} of {page_count}")
        self.restoreState()


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "ReportTitle",
            parent=base["Title"],
            fontName="Helvetica-Bold",
            fontSize=23,
            leading=27,
            textColor=colors.HexColor("#173f36"),
            spaceAfter=10,
            alignment=TA_LEFT,
        ),
        "eyebrow": ParagraphStyle(
            "ReportEyebrow",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=8,
            leading=10,
            textColor=colors.HexColor("#1f6e62"),
            spaceAfter=5,
        ),
        "heading": ParagraphStyle(
            "ReportHeading",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=14,
            leading=17,
            textColor=colors.HexColor("#173f36"),
            spaceBefore=8,
            spaceAfter=7,
        ),
        "subheading": ParagraphStyle(
            "ReportSubheading",
            parent=base["Heading3"],
            fontName="Helvetica-Bold",
            fontSize=10,
            leading=13,
            textColor=colors.HexColor("#315b50"),
            spaceBefore=7,
            spaceAfter=5,
        ),
        "body": ParagraphStyle(
            "ReportBody",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8.5,
            leading=12,
            textColor=colors.HexColor("#33443c"),
            spaceAfter=6,
        ),
        "small": ParagraphStyle(
            "ReportSmall",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=7,
            leading=9.5,
            textColor=colors.HexColor("#5f6b64"),
        ),
        "table": ParagraphStyle(
            "ReportTable",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=6.6,
            leading=8.3,
            textColor=colors.HexColor("#33443c"),
        ),
        "table_header": ParagraphStyle(
            "ReportTableHeader",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=6.7,
            leading=8.3,
            textColor=colors.white,
        ),
        "sequence": ParagraphStyle(
            "ReportSequence",
            parent=base["Code"],
            fontName="Courier",
            fontSize=6.6,
            leading=8.2,
            textColor=colors.HexColor("#263c33"),
            leftIndent=5,
            rightIndent=5,
            borderColor=colors.HexColor("#d7ddd8"),
            borderWidth=0.4,
            borderPadding=4,
            backColor=colors.HexColor("#f8faf7"),
            spaceAfter=2,
        ),
    }


def _cell(value: Any, style: ParagraphStyle) -> Paragraph:
    return Paragraph(_paragraph_text(value), style)


def _table_style(*, header: bool = True) -> TableStyle:
    commands: list[tuple[Any, ...]] = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#d7ddd8")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ROWBACKGROUNDS", (0, 1 if header else 0), (-1, -1), [
            colors.white,
            colors.HexColor("#f6f8f5"),
        ]),
    ]
    if header:
        commands.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#315b50")))
    return TableStyle(commands)


def _fact_table(
    rows: Sequence[tuple[str, Any]],
    styles: dict[str, ParagraphStyle],
) -> Table:
    data = [
        [
            Paragraph(f"<b>{_paragraph_text(label)}</b>", styles["small"]),
            _cell(value if value not in (None, "") else "Not available", styles["small"]),
        ]
        for label, value in rows
    ]
    table = Table(data, colWidths=[1.55 * inch, 5.25 * inch], hAlign="LEFT")
    table.setStyle(_table_style(header=False))
    return table


def _long_table(
    headers: Sequence[str],
    rows: Sequence[Sequence[Any]],
    widths: Sequence[float],
    styles: dict[str, ParagraphStyle],
) -> LongTable:
    data: list[list[Paragraph]] = [
        [_cell(header, styles["table_header"]) for header in headers]
    ]
    data.extend(
        [[_cell(value, styles["table"]) for value in row] for row in rows]
    )
    table = LongTable(
        data,
        colWidths=list(widths),
        repeatRows=1,
        hAlign="LEFT",
        splitByRow=1,
    )
    table.setStyle(_table_style(header=True))
    return table


def _transcript_flags(transcript: dict[str, Any]) -> str:
    flags = [
        "MANE Select" if transcript.get("isManeSelect") else None,
        "MANE Plus Clinical" if transcript.get("isManePlusClinical") else None,
        "Ensembl canonical" if transcript.get("isEnsemblCanonical") else None,
        _plain(transcript.get("appris")) if transcript.get("appris") else None,
        "GENCODE Basic" if transcript.get("isBasic") else None,
        _plain(transcript.get("ccdsId")) if transcript.get("ccdsId") else None,
    ]
    flags.extend(_plain(item) for item in transcript.get("tags") or [])
    unique = [item for index, item in enumerate(flags) if item and item not in flags[:index]]
    return ", ".join(unique) or "No stored flags"


def _exon_rows(
    transcript: dict[str, Any],
    domain: tuple[int, int] | None,
) -> list[list[Any]]:
    cds_by_exon: dict[int, list[dict[str, Any]]] = {}
    for segment in transcript.get("cdsSegments") or []:
        rank = int(segment.get("exonRank") or 0)
        cds_by_exon.setdefault(rank, []).append(segment)
    mapping = transcript.get("translationMapping") or {}
    cds_origin = int(mapping.get("cdsStart0") or 0)
    rows: list[list[Any]] = []
    for exon in transcript.get("exons") or []:
        if domain is not None and not _overlaps(domain[0], domain[1], exon):
            continue
        rank = int(exon.get("rank") or 0)
        segments = cds_by_exon.get(rank, [])
        if segments:
            cds_start = min(int(item["start0"]) for item in segments)
            cds_end = max(int(item["end0"]) for item in segments)
            transcript_starts = [
                int(item["transcriptStart0"])
                for item in segments
                if item.get("transcriptStart0") is not None
            ]
            transcript_ends = [
                int(item["transcriptEnd0"])
                for item in segments
                if item.get("transcriptEnd0") is not None
            ]
            aa_span = "Not available"
            if transcript_starts and transcript_ends:
                aa_start = math.floor((min(transcript_starts) - cds_origin) / 3) + 1
                aa_end = math.floor((max(transcript_ends) - cds_origin - 1) / 3) + 1
                aa_span = f"{aa_start:,}-{aa_end:,}"
            cds_label = _display_locus(
                str(transcript.get("chr") or ""), cds_start, cds_end
            )
            phases = sorted(
                {str(item["phase"]) for item in segments if item.get("phase") is not None}
            )
            phase = ", ".join(phases) or "Not available"
        else:
            cds_label = "Non-coding in this exon"
            phase = "-"
            aa_span = "-"
        rows.append(
            [
                rank,
                exon.get("versionedId") or exon.get("id"),
                _display_locus(
                    str(transcript.get("chr") or ""),
                    int(exon["start0"]),
                    int(exon["end0"]),
                ),
                f"{int(exon['end0']) - int(exon['start0']):,}",
                cds_label,
                phase,
                aa_span,
            ]
        )
    return rows


def _feature_rows(features: Sequence[dict[str, Any]]) -> list[list[Any]]:
    rows: list[list[Any]] = []
    for feature in features:
        segments = feature.get("segments") or []
        status = _plain(feature.get("projectionStatus") or "unresolved")
        projection = (
            f"{status}; {len(segments)} genomic piece{'s' if len(segments) != 1 else ''}"
            if segments
            else f"{status}; amino-acid lane only"
        )
        rows.append(
            [
                feature.get("source"),
                feature.get("accession") or feature.get("id"),
                feature.get("name") or "Source annotation",
                f"{int(feature.get('aaStart1') or 0):,}-{int(feature.get('aaEnd1') or 0):,}",
                feature.get("method") or "local",
                projection,
            ]
        )
    return rows


def build_pdf_report(
    *,
    manifest: dict[str, Any],
    gene: dict[str, Any],
    items: Sequence[dict[str, Any]],
    sections: Sequence[PdfSection],
    feature_sources: Sequence[str],
    structure_scope: StructureScope,
    locus: PdfLocus | None,
    sequence_excerpt: PdfSequenceExcerpt | None,
    generated_at: datetime,
) -> bytes:
    if not items or len(items) > MAX_PDF_TRANSCRIPTS:
        raise PdfReportLimitError(
            f"A PDF report must contain 1-{MAX_PDF_TRANSCRIPTS} transcripts."
        )
    feature_count = sum(len(item.get("features") or []) for item in items)
    if feature_count > MAX_PDF_FEATURE_ROWS:
        raise PdfReportLimitError(
            f"PDF feature tables exceed the {MAX_PDF_FEATURE_ROWS:,}-row report limit."
        )

    if structure_scope == "current_locus" and locus is not None:
        domain_start0, domain_end0 = locus.start0, locus.end0
    else:
        domain_start0 = min(int(item["transcript"]["start0"]) for item in items)
        domain_end0 = max(int(item["transcript"]["end0"]) for item in items)
    domain = (domain_start0, domain_end0)

    styles = _styles()
    output = BytesIO()
    symbol = _plain(gene.get("symbol") or gene.get("id") or "Gene")
    build_hash = _plain(manifest.get("buildHash") or manifest.get("build_hash") or "unknown")
    report = SimpleDocTemplate(
        output,
        pagesize=letter,
        rightMargin=42,
        leftMargin=42,
        topMargin=45,
        bottomMargin=42,
        title=f"{symbol} transcript report",
        author="Local Transcript Browser",
        subject="Selected transcript structures, annotations, and sequence excerpts",
        pageCompression=1,
    )
    story: list[Flowable] = []
    story.append(Spacer(1, 0.28 * inch))
    story.append(Paragraph("LOCAL TRANSCRIPT BROWSER", styles["eyebrow"]))
    story.append(Paragraph(f"{_paragraph_text(symbol)} transcript report", styles["title"]))
    story.append(
        Paragraph(
            "A bounded report assembled from the verified local annotation package. "
            "All report text is selectable; transcript models are vector graphics, not screenshots.",
            styles["body"],
        )
    )
    section_labels = {
        "summary": "Transcript summary",
        "structure": "Exon/CDS structure",
        "features": "Protein annotations",
        "sequence": "Sequence excerpt",
    }
    structure_label = (
        f"Current locus {_display_locus(locus.chrom, locus.start0, locus.end0)}"
        if structure_scope == "current_locus" and locus is not None
        else f"Selected-transcript union {_display_locus(str(gene.get('chr') or ''), domain_start0, domain_end0)}"
    )
    story.append(
        _fact_table(
            [
                ("Gene", f"{symbol} - {gene.get('versionedId') or gene.get('id')}"),
                ("Release", manifest.get("release") or "Not available"),
                ("Assembly", manifest.get("assembly") or "Not available"),
                ("Build hash", build_hash),
                ("Generated", generated_at.astimezone().isoformat(timespec="seconds")),
                ("Transcript order", f"{len(items)} selected rows in the current visual order"),
                ("Sections", ", ".join(section_labels[item] for item in sections)),
                ("Structure interval", structure_label),
                ("Active feature sources", ", ".join(feature_sources) or "None selected"),
                ("Displayed coordinates", "1-based inclusive"),
            ],
            styles,
        )
    )
    story.append(Spacer(1, 10))
    story.append(Paragraph("Included transcripts", styles["subheading"]))
    included_rows = [
        [
            index,
            item["transcript"].get("name") or item["transcript"].get("id"),
            item["transcript"].get("versionedId") or item["transcript"].get("id"),
            item["transcript"].get("proteinVersionedId") or "No translated product",
        ]
        for index, item in enumerate(items, start=1)
    ]
    story.append(
        _long_table(
            ["Order", "Transcript", "Stable ID", "Protein"],
            included_rows,
            [0.48 * inch, 1.35 * inch, 2.35 * inch, 2.62 * inch],
            styles,
        )
    )
    story.append(Spacer(1, 8))
    story.append(
        Paragraph(
            "Standard PDF fonts are used for offline portability. Unsupported glyphs are replaced "
            "with a question mark. JSON/TSV exports remain the machine-readable companion.",
            styles["small"],
        )
    )

    for order, item in enumerate(items, start=1):
        transcript = item["transcript"]
        story.append(PageBreak())
        story.append(
            Paragraph(
                f"TRANSCRIPT {order} OF {len(items)}",
                styles["eyebrow"],
            )
        )
        story.append(
            Paragraph(
                _paragraph_text(transcript.get("name") or transcript.get("versionedId")),
                styles["title"],
            )
        )
        story.append(
            Paragraph(
                f"{_paragraph_text(transcript.get('versionedId') or transcript.get('id'))} "
                f"- {_paragraph_text(_display_locus(str(transcript.get('chr') or ''), int(transcript.get('start0') or 0), int(transcript.get('end0') or 1)))} "
                f"- {_paragraph_text(transcript.get('strand') or '?')} strand",
                styles["body"],
            )
        )

        if "summary" in sections:
            story.append(Paragraph("Transcript summary", styles["heading"]))
            story.append(
                _fact_table(
                    [
                        ("Transcript ID", transcript.get("versionedId") or transcript.get("id")),
                        ("Protein ID", transcript.get("proteinVersionedId") or "No translated product"),
                        ("Biotype", transcript.get("biotype")),
                        ("Genomic locus", _display_locus(str(transcript.get("chr") or ""), int(transcript.get("start0") or 0), int(transcript.get("end0") or 1))),
                        ("Strand", transcript.get("strand")),
                        ("Transcript length", f"{int(transcript.get('transcriptLength') or 0):,} nt"),
                        ("CDS length", f"{int(transcript.get('cdsLength') or 0):,} nt"),
                        ("Protein length", f"{int(transcript.get('proteinLength') or 0):,} aa" if int(transcript.get("proteinLength") or 0) else "No translated product"),
                        ("Annotation level", transcript.get("annotationLevel")),
                        ("Transcript support level", transcript.get("tsl")),
                        ("Flags and tags", _transcript_flags(transcript)),
                    ],
                    styles,
                )
            )

        if "structure" in sections:
            story.append(Paragraph("Exon and CDS structure", styles["heading"]))
            story.append(
                Paragraph(
                    "Outlined blocks are exons; dark blocks are CDS intersections. The baseline "
                    "and arrow show transcript span and strand. Every selected transcript uses the same genomic scale.",
                    styles["body"],
                )
            )
            story.append(
                TranscriptStructureFlowable(transcript, domain_start0, domain_end0)
            )
            exon_domain = domain if structure_scope == "current_locus" else None
            rows = _exon_rows(transcript, exon_domain)
            if structure_scope == "current_locus":
                story.append(
                    Paragraph(
                        "The table contains exons overlapping the requested locus; each row retains the full exon coordinate.",
                        styles["small"],
                    )
                )
            if rows:
                story.append(
                    _long_table(
                        ["Rank", "Exon ID", "Genomic range", "Length", "CDS range", "Phase", "AA span"],
                        rows,
                        [0.36 * inch, 1.22 * inch, 1.43 * inch, 0.48 * inch, 1.43 * inch, 0.42 * inch, 0.56 * inch],
                        styles,
                    )
                )
            else:
                story.append(Paragraph("No exon rows overlap this structure interval.", styles["body"]))

        if "features" in sections:
            story.append(Paragraph("Protein annotations", styles["heading"]))
            features = item.get("features") or []
            if features:
                story.append(
                    Paragraph(
                        "Rows retain local source identity and amino-acid coordinates. Only exact "
                        "translation mappings receive genomic pieces; partial/unresolved rows remain amino-acid-only.",
                        styles["body"],
                    )
                )
                story.append(
                    _long_table(
                        ["Source", "Accession", "Name", "AA", "Method", "Projection"],
                        _feature_rows(features),
                        [0.62 * inch, 1.0 * inch, 1.58 * inch, 0.55 * inch, 0.72 * inch, 1.58 * inch],
                        styles,
                    )
                )
            else:
                story.append(
                    Paragraph("No protein annotations exist in the selected local sources.", styles["body"])
                )

        if "sequence" in sections and sequence_excerpt is not None:
            story.append(Paragraph("Sequence excerpt", styles["heading"]))
            sequence_payload = item.get("sequence") or {}
            if not sequence_payload.get("available") or not sequence_payload.get("sequence"):
                story.append(
                    Paragraph(
                        f"{_paragraph_text(sequence_excerpt.kind)} sequence is not available for this transcript.",
                        styles["body"],
                    )
                )
            else:
                sequence = str(sequence_payload["sequence"])
                start1 = sequence_excerpt.start1
                end1 = sequence_excerpt.end1
                excerpt = sequence[start1 - 1 : end1]
                if sequence_excerpt.kind == "protein":
                    orientation = "N-to-C; amino-acid residues"
                else:
                    orientation = "5'-to-3'; nucleotide positions"
                story.append(
                    Paragraph(
                        f"{_paragraph_text(sequence_excerpt.kind)} - {orientation} {start1:,}-{end1:,} "
                        f"of {len(sequence):,}. The excerpt is exact and is not silently clipped.",
                        styles["body"],
                    )
                )
                for offset in range(0, len(excerpt), 60):
                    chunk = _plain(excerpt[offset : offset + 60])
                    line_start = start1 + offset
                    line_end = line_start + len(chunk) - 1
                    story.append(
                        Preformatted(
                            f"{line_start:>8,}  {chunk}  {line_end:,}",
                            styles["sequence"],
                        )
                    )

    report.build(
        story,
        canvasmaker=lambda *args, **kwargs: NumberedCanvas(
            *args,
            header_label=f"{symbol} transcript report",
            build_hash=build_hash,
            **kwargs,
        ),
    )
    body = output.getvalue()
    page_count = len(re.findall(rb"/Type\s*/Page(?!s)", body))
    if page_count > MAX_PDF_PAGES:
        raise PdfReportLimitError(
            f"PDF generation exceeded the {MAX_PDF_PAGES}-page limit."
        )
    if len(body) > MAX_PDF_BYTES:
        raise PdfReportLimitError(
            f"PDF generation exceeded the {MAX_PDF_BYTES // (1024 * 1024)} MiB limit."
        )
    return body
