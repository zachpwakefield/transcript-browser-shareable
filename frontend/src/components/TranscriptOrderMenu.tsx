import { useEffect, useId, useRef, useState } from "react";
import type { TranscriptOrderAction } from "../lib/transcriptOrder";

interface TranscriptOrderMenuProps {
  transcriptName: string;
  position: number;
  total: number;
  selectedTranscriptName: string;
  selected: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  focusRequested: boolean;
  onAction: (action: TranscriptOrderAction) => void;
  onFocusHandled: () => void;
}

export function TranscriptOrderMenu({
  transcriptName,
  position,
  total,
  selectedTranscriptName,
  selected,
  canMoveUp,
  canMoveDown,
  focusRequested,
  onAction,
  onFocusHandled,
}: TranscriptOrderMenuProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const headingId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!focusRequested) return;
    triggerRef.current?.focus();
    onFocusHandled();
  }, [focusRequested, onFocusHandled]);

  useEffect(() => {
    if (!open) return;
    const closeAndRestoreFocus = () => {
      setOpen(false);
      triggerRef.current?.focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    const pointerdown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", pointerdown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", pointerdown);
    };
  }, [open]);

  function apply(action: TranscriptOrderAction) {
    triggerRef.current?.focus();
    setOpen(false);
    onAction(action);
  }

  return (
    <div className="transcript-order-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="transcript-order-trigger"
        aria-label={`Reorder ${transcriptName}, position ${position} of ${total} visible transcripts`}
        aria-expanded={open}
        aria-controls={panelId}
        title={`Reorder ${transcriptName}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">↕</span>
      </button>
      {open && (
        <div className="transcript-order-popover" id={panelId} role="group" aria-labelledby={headingId}>
          <strong id={headingId}>Reorder {transcriptName}</strong>
          <p>Changes only the visual row order in this saved view.</p>
          <button type="button" disabled={!canMoveUp} onClick={() => apply("up")}>Move up one visible row</button>
          <button type="button" disabled={!canMoveDown} onClick={() => apply("down")}>Move down one visible row</button>
          <button type="button" disabled={selected} onClick={() => apply("before-selected")}>
            Place directly above selected {selectedTranscriptName}
          </button>
          <button type="button" disabled={selected} onClick={() => apply("after-selected")}>
            Place directly below selected {selectedTranscriptName}
          </button>
          {selected && <small>Select another transcript to place beside {selectedTranscriptName}.</small>}
        </div>
      )}
    </div>
  );
}
