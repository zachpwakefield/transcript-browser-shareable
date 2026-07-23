import { useRef, useState, type ChangeEvent } from "react";
import { encodeSession, MAX_SESSION_BYTES, parsePortableSession } from "../lib/session";
import type { EntityKey, UserAnnotation } from "../lib/workspaceStore";
import type { BrowserViewState, BuildManifest } from "../types";

interface SessionActionsProps {
  manifest: BuildManifest;
  view: BrowserViewState;
  annotations: Partial<Record<EntityKey, UserAnnotation>>;
  fallback: BrowserViewState;
  onSavePdf: () => void;
  onQuickPdf: () => void;
  quickPdfBusy: boolean;
  onRestore: (view: BrowserViewState, annotations: Partial<Record<EntityKey, UserAnnotation>>) => string | void;
  onMessage: (message: string) => void;
}

export function SessionActions({ manifest, view, annotations, fallback, onSavePdf, onQuickPdf, quickPdfBusy, onRestore, onMessage }: SessionActionsProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  function exportSession() {
    const blob = new Blob([encodeSession(view, annotations)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `transcript-browser-${manifest.buildHash.slice(0, 12)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    onMessage("Session JSON exported with the required local build hash and build-scoped user annotations.");
  }

  async function importSession(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_SESSION_BYTES) {
      onMessage("Session import rejected: file exceeds the 512 KiB safety limit.");
      return;
    }
    setBusy(true);
    try {
      const restored = parsePortableSession(await file.text(), fallback, manifest.buildHash);
      const annotationCount = Object.keys(restored.annotations).length;
      let annotationsToMerge: Partial<Record<EntityKey, UserAnnotation>> = {};
      if (annotationCount > 0 && window.confirm(
        `This matching-build session contains ${annotationCount} local user annotation${annotationCount === 1 ? "" : "s"}. Merge them without overwriting newer local notes?`,
      )) {
        annotationsToMerge = restored.annotations;
      }
      const restoreMessage = onRestore(restored.view, annotationsToMerge);
      onMessage(restoreMessage ?? (annotationCount > 0
        ? `Session view restored; ${Object.keys(annotationsToMerge).length} explicitly approved annotation${Object.keys(annotationsToMerge).length === 1 ? "" : "s"} submitted for safe merge.`
        : "Session restored against the matching immutable build."));
    } catch (error) {
      onMessage(`Session import rejected: ${error instanceof Error ? error.message : "invalid file"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="session-actions" aria-label="View and session actions">
      <a href={`/api/v1/export?entity=region&chr=${encodeURIComponent(view.locus.chrom)}&start0=${view.locus.start0}&end0=${view.locus.end0}&format=json`}>Locus JSON</a>
      <a href={`/api/v1/export?entity=region&chr=${encodeURIComponent(view.locus.chrom)}&start0=${view.locus.start0}&end0=${view.locus.end0}&format=tsv`}>Locus TSV</a>
      <button type="button" onClick={onSavePdf}>Save PDF</button>
      <button type="button" disabled={quickPdfBusy} onClick={onQuickPdf}>{quickPdfBusy ? "Building PDF…" : "Quick PDF"}</button>
      <button type="button" onClick={() => {
        if (!navigator.clipboard) {
          onMessage("Clipboard access is unavailable. Copy the complete URL from the address bar.");
          return;
        }
        void navigator.clipboard.writeText(window.location.href)
          .then(() => onMessage("Local view URL copied. It is reusable on this installation and build."))
          .catch(() => onMessage("Clipboard access was denied. Copy the complete URL from the address bar."));
      }}>Copy view</button>
      <button type="button" onClick={exportSession}>Export session</button>
      <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Importing…" : "Import session"}</button>
      <input ref={fileRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void importSession(event)} />
    </span>
  );
}
