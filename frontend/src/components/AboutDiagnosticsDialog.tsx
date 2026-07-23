import { useEffect, useMemo, useRef, useState } from "react";
import { APPLICATION_VERSION } from "../lib/application";
import { formatDiagnostics } from "../lib/diagnostics";
import type { BuildManifest, Gene, Transcript } from "../types";

interface AboutDiagnosticsDialogProps {
  open: boolean;
  manifest: BuildManifest;
  gene?: Gene;
  transcript?: Transcript;
  onClose: () => void;
  onMessage: (message: string) => void;
}

export function AboutDiagnosticsDialog({ open, manifest, gene, transcript, onClose, onMessage }: AboutDiagnosticsDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }));
  useEffect(() => {
    if (!open) return;
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio });
    update();
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [onClose, open]);

  const diagnostics = useMemo(() => {
    const external = performance.getEntriesByType("resource").filter((entry) => {
      try { return new URL(entry.name).origin !== window.location.origin; } catch { return true; }
    }).length;
    return formatDiagnostics({
      applicationVersion: APPLICATION_VERSION,
      buildHash: manifest.buildHash,
      gencodeRelease: manifest.gencodeRelease ?? manifest.release.split(" · ")[0],
      ensemblRelease: String(manifest.ensemblRelease ?? manifest.release.match(/Ensembl\s+(\d+)/u)?.[1] ?? "not declared"),
      assembly: manifest.assembly,
      schemaVersion: manifest.schemaVersion ?? "not declared",
      capabilities: Object.entries(manifest.capabilities).filter(([, enabled]) => enabled).map(([name]) => name),
      pdfAvailable: manifest.capabilities.pdfReports === true,
      currentGene: gene ? `${gene.symbol} (${gene.versionedId})` : "none",
      currentTranscript: transcript?.versionedId ?? "none",
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      devicePixelRatio: viewport.dpr,
      serviceUrl: window.location.href,
      externalResourceCount: external,
    });
  }, [gene, manifest, transcript, viewport]);

  if (!open) return null;
  return (
    <div className="help-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="help-dialog diagnostics-dialog" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title" tabIndex={-1}>
        <header><div><span className="eyebrow">About this local application</span><h2 id="diagnostics-title">Transcript Browser {APPLICATION_VERSION}</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close About and Diagnostics">×</button></header>
        <pre>{diagnostics}</pre>
        <footer><button type="button" onClick={() => {
          if (!navigator.clipboard) { onMessage("Clipboard access is unavailable."); return; }
          void navigator.clipboard.writeText(diagnostics).then(() => onMessage("Privacy-safe diagnostics copied.")).catch(() => onMessage("Clipboard access was denied."));
        }}>Copy diagnostics</button><button type="button" onClick={onClose}>Close</button></footer>
      </section>
    </div>
  );
}
