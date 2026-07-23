import { useEffect, useRef } from "react";

interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function HelpOverlay({ open, onClose }: HelpOverlayProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [onClose, open]);
  if (!open) return null;
  return (
    <div className="help-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" tabIndex={-1}>
        <header><div><span className="eyebrow">Local controls</span><h2 id="help-title">Navigate the transcript workspace</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close keyboard and gesture help">×</button></header>
        <dl>
          <div><dt>Drag canvas</dt><dd>Pan genomic coordinates</dd></div>
          <div><dt>Horizontal trackpad</dt><dd>Pan without changing page scroll</dd></div>
          <div><dt>Ctrl/Cmd + wheel</dt><dd>Zoom around the pointer</dd></div>
          <div><dt>Vertical wheel</dt><dd>Scroll transcript rows and the page</dd></div>
          <div><dt>Drag ruler</dt><dd>Zoom to the selected genomic interval</dd></div>
          <div><dt>Double-click</dt><dd>Zoom in around the pointer</dd></div>
          <div><dt>← / →</dt><dd>Pan a focused canvas</dd></div>
          <div><dt>+ / −</dt><dd>Zoom a focused canvas</dd></div>
          <div><dt>/</dt><dd>Focus the global local-annotation search</dd></div>
          <div><dt>J / K</dt><dd>Select the next / previous filter-matched transcript without wrapping</dd></div>
          <div><dt>P</dt><dd>Pin or unpin the selected transcript</dd></div>
          <div><dt>C</dt><dd>Open or focus transcript comparison</dd></div>
          <div><dt>Shift + C</dt><dd>Make the selected transcript the comparison side and select its partner</dd></div>
          <div><dt>Page Up / Down</dt><dd>Move the transcript viewport by one page</dd></div>
          <div><dt>Home / End</dt><dd>Move to the first / last transcript row</dd></div>
          <div><dt>↕ Reorder</dt><dd>Move a row or place it directly above or below the selected transcript</dd></div>
          <div><dt>Save PDF</dt><dd>Choose transcripts and report sections, then download selectable text and vector structures</dd></div>
          <div><dt>Quick PDF</dt><dd>Reuse the last successful build-scoped PDF preset after strict revalidation</dd></div>
          <div><dt>Minimap</dt><dd>Click, drag, or focus and use paging keys to move the transcript viewport</dd></div>
          <div><dt>Tab / Enter</dt><dd>Reach transcript disclosure, pinning, reordering, filters, tables, and inspector tabs</dd></div>
          <div><dt>Escape</dt><dd>Close this help panel or the search palette</dd></div>
        </dl>
        <p>All coordinates shown in the interface are 1-based inclusive. API and database coordinates remain 0-based half-open.</p>
      </section>
    </div>
  );
}
