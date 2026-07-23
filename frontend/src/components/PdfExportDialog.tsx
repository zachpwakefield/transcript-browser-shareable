import { useEffect, useMemo, useRef, useState } from "react";
import {
  createTranscriptPdf,
  type PdfReportSection,
  type PdfStructureScope,
  type SequenceKind,
} from "../api";
import type { FeatureSource, Gene, Locus, Transcript } from "../types";
import { createPdfPreset } from "../lib/pdfPreset";
import type { PdfPreset, PdfPresetScope } from "../lib/workspaceStore";

export const MAX_PDF_TRANSCRIPTS = 20;
export const MAX_PDF_SEQUENCE_CHARS = 20_000;
export const MAX_PDF_SEQUENCE_EXCERPT = 10_000;

const PDF_SECTIONS: Array<{ id: PdfReportSection; label: string; description: string }> = [
  { id: "summary", label: "Transcript summary", description: "Stable IDs, coordinates, lengths, flags, and tags" },
  { id: "structure", label: "Exon and CDS structure", description: "Shared-scale vector model plus an exon/CDS table" },
  { id: "features", label: "Protein annotations", description: "Active-source feature rows and projection status" },
  { id: "sequence", label: "Sequence excerpt", description: "An exact 1-based transcript, CDS, or protein interval" },
];

interface PdfExportDialogProps {
  open: boolean;
  gene: Gene;
  transcripts: Transcript[];
  selectedTranscriptId: string;
  comparisonTranscriptId: string;
  pinnedTranscriptIds: string[];
  activeSources: FeatureSource[];
  locus: Locus;
  buildHash: string;
  onClose: () => void;
  onMessage: (message: string) => void;
  onPresetSaved: (preset: PdfPreset) => void;
}

export function transcriptSequenceLength(transcript: Transcript, kind: SequenceKind): number {
  const stored = transcript.sequences?.[kind];
  if (stored) return stored.available ? stored.length : 0;
  if (kind === "protein") return transcript.proteinLength;
  if (kind === "cds") return transcript.fastaCdsSpanLength ?? transcript.cdsLength;
  return transcript.transcriptLength;
}

export function orderedPdfTranscriptIds(transcripts: readonly Transcript[], ids: Iterable<string>): string[] {
  const requested = new Set(ids);
  return transcripts.filter((transcript) => requested.has(transcript.id)).map((transcript) => transcript.id);
}

export function PdfExportDialog({
  open,
  gene,
  transcripts,
  selectedTranscriptId,
  comparisonTranscriptId,
  pinnedTranscriptIds,
  activeSources,
  locus,
  buildHash,
  onClose,
  onMessage,
  onPresetSaved,
}: PdfExportDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const busyRef = useRef(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [presetScope, setPresetScope] = useState<PdfPresetScope | undefined>("selected");
  const [sections, setSections] = useState<PdfReportSection[]>(["summary", "structure", "features"]);
  const [structureScope, setStructureScope] = useState<PdfStructureScope>("full");
  const [sequenceKind, setSequenceKind] = useState<SequenceKind>("protein");
  const [sequenceStart, setSequenceStart] = useState("1");
  const [sequenceEnd, setSequenceEnd] = useState("300");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!open) return;
    const selected = transcripts.some((transcript) => transcript.id === selectedTranscriptId)
      ? selectedTranscriptId
      : transcripts[0]?.id;
    setSelectedIds(selected ? [selected] : []);
    setPresetScope("selected");
    setSections(["summary", "structure", "features"]);
    setStructureScope("full");
    setSequenceKind("protein");
    setSequenceStart("1");
    const selectedTranscript = transcripts.find((transcript) => transcript.id === selected);
    setSequenceEnd(String(Math.min(300, Math.max(1, selectedTranscript?.proteinLength ?? 300))));
    setQuery("");
    setStatus("");
    setError("");
  }, [gene.id, open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        abortRef.current?.abort();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => !element.hidden);
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      abortRef.current?.abort();
      previous?.focus();
    };
  }, [onClose, open]);

  const selectedTranscripts = useMemo(() => {
    const selected = new Set(selectedIds);
    return transcripts.filter((transcript) => selected.has(transcript.id));
  }, [selectedIds, transcripts]);
  const filteredChoices = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return transcripts;
    return transcripts.filter((transcript) => (
      `${transcript.name} ${transcript.id} ${transcript.versionedId} ${transcript.versionedProteinId}`
        .toLowerCase()
        .includes(normalized)
    ));
  }, [query, transcripts]);
  const sequenceLengths = selectedTranscripts
    .map((transcript) => transcriptSequenceLength(transcript, sequenceKind))
    .filter((length) => length > 0);
  const shortestSequence = sequenceLengths.length ? Math.min(...sequenceLengths) : undefined;
  const unavailableSequenceCount = selectedTranscripts.length - sequenceLengths.length;
  const sequenceEnabled = sections.includes("sequence");
  const parsedStart = Number(sequenceStart);
  const parsedEnd = Number(sequenceEnd);
  const sequenceSpan = parsedEnd - parsedStart + 1;

  let validationError = "";
  if (!selectedTranscripts.length) validationError = "Choose at least one transcript.";
  else if (selectedTranscripts.length > MAX_PDF_TRANSCRIPTS) validationError = `Choose no more than ${MAX_PDF_TRANSCRIPTS} transcripts.`;
  else if (!sections.length) validationError = "Choose at least one report section.";
  else if (sequenceEnabled && (!Number.isInteger(parsedStart) || !Number.isInteger(parsedEnd) || parsedStart < 1 || parsedEnd < parsedStart)) {
    validationError = "Enter a valid 1-based inclusive sequence range.";
  } else if (sequenceEnabled && sequenceSpan > MAX_PDF_SEQUENCE_EXCERPT) {
    validationError = `One sequence excerpt is limited to ${MAX_PDF_SEQUENCE_EXCERPT.toLocaleString()} characters.`;
  } else if (sequenceEnabled && shortestSequence !== undefined && parsedEnd > shortestSequence) {
    validationError = `The requested end exceeds the shortest available ${sequenceKind} sequence (${shortestSequence.toLocaleString()}).`;
  } else if (sequenceEnabled && sequenceSpan * sequenceLengths.length > MAX_PDF_SEQUENCE_CHARS) {
    validationError = `Combined sequence excerpts are limited to ${MAX_PDF_SEQUENCE_CHARS.toLocaleString()} characters.`;
  }

  function requestClose() {
    abortRef.current?.abort();
    onClose();
  }

  function choose(ids: Iterable<string>, message?: string, scope?: PdfPresetScope) {
    const next = orderedPdfTranscriptIds(transcripts, ids).slice(0, MAX_PDF_TRANSCRIPTS);
    setSelectedIds(next);
    setPresetScope(scope);
    setError("");
    setStatus(message ?? "");
  }

  function toggleTranscript(transcriptId: string) {
    if (selectedIds.includes(transcriptId)) {
      choose(selectedIds.filter((id) => id !== transcriptId));
      return;
    }
    if (selectedIds.length >= MAX_PDF_TRANSCRIPTS) {
      setStatus(`PDF reports are limited to ${MAX_PDF_TRANSCRIPTS} transcripts. Save another batch for additional rows.`);
      return;
    }
    choose([...selectedIds, transcriptId]);
  }

  function toggleSection(section: PdfReportSection) {
    setSections((current) => PDF_SECTIONS
      .map((item) => item.id)
      .filter((id) => id === section ? !current.includes(id) : current.includes(id)));
    setError("");
  }

  async function savePdf() {
    if (validationError || busy) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    setStatus(`Building a local PDF for ${selectedTranscripts.length} transcript${selectedTranscripts.length === 1 ? "" : "s"}…`);
    try {
      const download = await createTranscriptPdf({
        buildHash,
        geneId: gene.id,
        transcriptIds: selectedTranscripts.map((transcript) => transcript.id),
        sections,
        featureSources: sections.includes("features") ? activeSources : [],
        structureScope,
        locus: structureScope === "current_locus" ? locus : undefined,
        sequenceExcerpt: sequenceEnabled ? {
          kind: sequenceKind,
          start1: parsedStart,
          end1: parsedEnd,
        } : undefined,
      }, controller.signal);
      const url = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = download.filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      if (presetScope) {
        onPresetSaved(createPdfPreset(buildHash, {
          scope: presetScope,
          sections,
          featureSources: sections.includes("features") ? activeSources : [],
          structureScope,
          sequenceExcerpt: sequenceEnabled ? {
            kind: sequenceKind,
            start1: parsedStart,
            end1: parsedEnd,
          } : undefined,
        }));
      }
      onMessage(`${download.filename} saved with ${selectedTranscripts.length} transcript${selectedTranscripts.length === 1 ? "" : "s"} in the current visual order.`);
      onClose();
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "The local PDF report could not be generated.");
      setStatus("");
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="pdf-export-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busyRef.current) requestClose();
    }}>
      <section
        ref={dialogRef}
        className="pdf-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-export-title"
        aria-describedby="pdf-export-intro pdf-export-limits"
        tabIndex={-1}
      >
        <header>
          <div>
            <span className="eyebrow">Local report</span>
            <h2 id="pdf-export-title">Save selected transcripts as PDF</h2>
            <p id="pdf-export-intro">Choose rows and report sections. The PDF uses selectable text and vector transcript models.</p>
          </div>
          <button ref={closeRef} type="button" onClick={requestClose} aria-label="Close PDF export">×</button>
        </header>

        <div className="pdf-export-body">
          <section className="pdf-transcript-picker" aria-labelledby="pdf-transcript-title">
            <div className="pdf-section-heading">
              <div><h3 id="pdf-transcript-title">Transcripts</h3><small>{selectedTranscripts.length} of {MAX_PDF_TRANSCRIPTS} selected</small></div>
              <span>{transcripts.length} filter-matched rows</span>
            </div>
            <div className="pdf-quick-actions" aria-label="Transcript selection shortcuts">
              <button type="button" onClick={() => choose([selectedTranscriptId], undefined, "selected")}>Selected only</button>
              <button type="button" disabled={!comparisonTranscriptId} onClick={() => choose(
                [selectedTranscriptId, comparisonTranscriptId],
                undefined,
                "selected_comparison",
              )}>Selected + comparison</button>
              <button type="button" onClick={() => choose(
                [selectedTranscriptId, ...pinnedTranscriptIds],
                pinnedTranscriptIds.length + 1 > MAX_PDF_TRANSCRIPTS ? `First ${MAX_PDF_TRANSCRIPTS} selected and pinned rows included.` : undefined,
                "selected_pinned",
              )}>Selected + pinned</button>
              <button type="button" onClick={() => choose(
                transcripts.map((transcript) => transcript.id),
                transcripts.length > MAX_PDF_TRANSCRIPTS ? `First ${MAX_PDF_TRANSCRIPTS} filter-matched rows selected. Save additional batches as needed.` : undefined,
              )}>All matching</button>
              <button type="button" onClick={() => choose([])}>Clear</button>
            </div>
            <label className="pdf-transcript-search">
              <span className="sr-only">Filter transcript choices</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter transcript IDs or names" />
            </label>
            <div className="pdf-transcript-list" role="group" aria-label="Transcript choices">
              {filteredChoices.map((transcript) => (
                <label key={transcript.id} className="pdf-transcript-option">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(transcript.id)}
                    onChange={() => toggleTranscript(transcript.id)}
                  />
                  <span><strong>{transcript.name}</strong><small>{transcript.versionedId}</small></span>
                  <small>{transcript.proteinLength > 0 ? `${transcript.proteinLength.toLocaleString()} aa` : "noncoding"}</small>
                </label>
              ))}
              {!filteredChoices.length && <p>No filter-matched transcript choice contains “{query}”.</p>}
            </div>
          </section>

          <section className="pdf-report-options" aria-labelledby="pdf-options-title">
            <div className="pdf-section-heading"><div><h3 id="pdf-options-title">Report sections</h3><small>Applied to each chosen transcript</small></div></div>
            <fieldset className="pdf-section-options">
              <legend className="sr-only">PDF report sections</legend>
              {PDF_SECTIONS.map((section) => (
                <label key={section.id}>
                  <input type="checkbox" checked={sections.includes(section.id)} onChange={() => toggleSection(section.id)} />
                  <span><strong>{section.label}</strong><small>{section.description}</small></span>
                </label>
              ))}
            </fieldset>

            {sections.includes("structure") && (
              <fieldset className="pdf-scope-options">
                <legend>Genomic structure interval</legend>
                <label><input type="radio" name="pdf-structure-scope" checked={structureScope === "full"} onChange={() => setStructureScope("full")} /><span><strong>Selected-transcript union</strong><small>One shared scale across all chosen rows</small></span></label>
                <label><input type="radio" name="pdf-structure-scope" checked={structureScope === "current_locus"} onChange={() => setStructureScope("current_locus")} /><span><strong>Current locus</strong><small>{locus.chrom}:{(locus.start0 + 1).toLocaleString()}-{locus.end0.toLocaleString()}</small></span></label>
              </fieldset>
            )}

            {sequenceEnabled && (
              <fieldset className="pdf-sequence-options">
                <legend>Exact sequence excerpt</legend>
                <label><span>Sequence</span><select value={sequenceKind} onChange={(event) => setSequenceKind(event.target.value as SequenceKind)}><option value="protein">Protein (N-to-C)</option><option value="cds">CDS (5′-to-3′)</option><option value="transcript_full">Full transcript (5′-to-3′)</option></select></label>
                <div>
                  <label><span>Start (1-based)</span><input type="number" min="1" step="1" value={sequenceStart} onChange={(event) => setSequenceStart(event.target.value)} /></label>
                  <label><span>End (inclusive)</span><input type="number" min="1" step="1" value={sequenceEnd} onChange={(event) => setSequenceEnd(event.target.value)} /></label>
                </div>
                <small>
                  {shortestSequence ? `Available through ${shortestSequence.toLocaleString()} in every transcript that has this sequence.` : `No chosen transcript reports an available ${sequenceKind} sequence.`}
                  {unavailableSequenceCount > 0 ? ` ${unavailableSequenceCount} unavailable transcript${unavailableSequenceCount === 1 ? "" : "s"} will be labeled explicitly.` : ""}
                </small>
              </fieldset>
            )}

            <p id="pdf-export-limits" className="pdf-limit-note">
              Reports are local and bounded to {MAX_PDF_TRANSCRIPTS} transcripts, 2,000 feature rows, 20,000 sequence characters, 100 pages, and 25 MiB. Nothing is silently truncated.
            </p>
          </section>
        </div>

        <footer>
          <div aria-live="polite">
            {error ? <span className="pdf-export-error" role="alert">{error}</span> : validationError ? <span>{validationError}</span> : status ? <span>{status}</span> : <span>Ready to create a local PDF.</span>}
          </div>
          <div>
            <button type="button" className="pdf-cancel" onClick={requestClose}>{busy ? "Cancel" : "Close"}</button>
            <button type="button" className="pdf-save" disabled={Boolean(validationError) || busy} onClick={() => void savePdf()}>{busy ? "Building PDF…" : "Save PDF"}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
