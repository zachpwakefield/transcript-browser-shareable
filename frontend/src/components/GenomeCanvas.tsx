import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { genomicToPixel, locusSpan, panLocus, pixelToGenomic, zoomLocus } from "../lib/coordinates";
import type { BrowserRowLayout } from "../lib/layout";
import { canvasKeyboardCommand } from "../lib/navigation";
import { boundedCanvasBitmapSize, type VariableRowWindow } from "../lib/windowing";
import {
  SOURCE_META,
  type DisplayMode,
  type FeatureSource,
  type Gene,
  type Locus,
  type ProteinFeature,
  type RegionData,
  type Transcript,
} from "../types";

interface HitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  transcriptId: string;
  label: string;
  feature?: ProteinFeature;
  geneId?: string;
  phase?: { exonRank: number; phase: 1 | 2; aaStart?: number };
}

interface GenomeCanvasProps {
  gene: Gene;
  transcripts: Transcript[];
  layout: BrowserRowLayout;
  renderWindow: VariableRowWindow;
  locus: Locus;
  displayMode: DisplayMode;
  activeSources: FeatureSource[];
  selectedTranscriptId: string;
  selectedFeatureId?: string;
  keyboardShortcutsEnabled: boolean;
  onSelectTranscript: (transcriptId: string) => void;
  onSelectFeature: (feature: ProteinFeature) => void;
  region?: RegionData;
  onSelectGene?: (geneId: string) => void;
  onLocusChange: (locus: Locus, commit?: boolean) => void;
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(760);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.max(320, Math.round(element.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceStep(span: number): number {
  const rough = span / 6;
  const power = 10 ** Math.floor(Math.log10(Math.max(1, rough)));
  const ratio = rough / power;
  const multiplier = ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10;
  return multiplier * power;
}

function visibleRect(start0: number, end0: number, locus: Locus, width: number) {
  const clippedStart = Math.max(start0, locus.start0);
  const clippedEnd = Math.min(end0, locus.end0);
  if (clippedEnd <= clippedStart) return null;
  const x = genomicToPixel(clippedStart, locus, width);
  const endX = genomicToPixel(clippedEnd, locus, width);
  return { x, width: Math.max(1.5, endX - x) };
}

function drawFeatureBlock(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  feature: ProteinFeature,
  selected: boolean,
) {
  const meta = SOURCE_META[feature.source];
  const visualWidth = Math.max(width, 2);
  context.globalAlpha = selected ? 1 : 0.76;
  context.fillStyle = meta.color;
  context.fillRect(x, y, visualWidth, height);
  context.globalAlpha = 1;
  if (width < 2) {
    context.setLineDash([1, 1]);
    context.strokeStyle = "#526159";
    context.strokeRect(x - 1, y - 1, visualWidth + 2, height + 2);
    context.setLineDash([]);
  }
  if (feature.source === "mobidblite") {
    context.strokeStyle = "rgba(255,255,255,.55)";
    context.lineWidth = 1;
    for (let hatchX = x + 2; hatchX < x + width; hatchX += 6) {
      context.beginPath();
      context.moveTo(hatchX, y + height);
      context.lineTo(Math.min(hatchX + height, x + width), y);
      context.stroke();
    }
  }
  if (selected) {
    context.strokeStyle = "#14221c";
    context.lineWidth = 2;
    context.strokeRect(x - 1, y - 1, visualWidth + 2, height + 2);
  }
}

export function GenomeCanvas({
  gene,
  transcripts,
  layout,
  renderWindow,
  locus,
  displayMode,
  activeSources,
  selectedTranscriptId,
  selectedFeatureId,
  keyboardShortcutsEnabled,
  onSelectTranscript,
  onSelectFeature,
  region,
  onSelectGene,
  onLocusChange,
}: GenomeCanvasProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitRegions = useRef<HitRegion[]>([]);
  const drag = useRef<{ startX: number; startLocus: Locus; moved: boolean; mode: "pan" | "ruler" } | null>(null);
  const [hovered, setHovered] = useState<HitRegion | null>(null);
  const [overlapChoices, setOverlapChoices] = useState<{ x: number; y: number; hits: HitRegion[] } | null>(null);
  const activeFeatureId = hovered?.feature?.recordId ?? selectedFeatureId;
  const transcriptById = useMemo(
    () => new Map(transcripts.map((transcript) => [transcript.id, transcript])),
    [transcripts],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bitmap = boundedCanvasBitmapSize(width, renderWindow.height, window.devicePixelRatio || 1);
    const dpr = bitmap.dpr;
    const height = renderWindow.height;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.top = `${renderWindow.start0}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#fbfcf9";
    context.fillRect(0, 0, width, height);
    context.translate(0, -renderWindow.start0);
    context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textBaseline = "middle";
    const hits: HitRegion[] = [];
    const visibleRows = layout.rows.slice(renderWindow.firstIndex, renderWindow.lastIndexExclusive);

    // Coordinate ruler and per-row genomic guides. Guides intentionally stop
    // before each independent protein axis.
    const step = niceStep(locusSpan(locus));
    const firstTick = Math.ceil(locus.start0 / step) * step;
    for (let tick = firstTick; tick <= locus.end0; tick += step) {
      const x = genomicToPixel(tick, locus, width);
      context.strokeStyle = "#dce2dc";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x + 0.5, 25);
      context.lineTo(x + 0.5, layout.geneHeaderHeight);
      visibleRows.forEach((row) => {
        context.moveTo(x + 0.5, row.y);
        context.lineTo(x + 0.5, row.expanded ? row.proteinTop - 8 : row.y + row.height);
      });
      context.stroke();
      context.fillStyle = "#647069";
      context.textAlign = "center";
      context.fillText((tick + 1).toLocaleString("en-US"), x, 13);
    }

    // Region density and packed genes share only the broad ruler band. The
    // selected gene/transcript rows remain below as an explicit LOD override.
    if (region?.density.length) {
      const maximum = Math.max(1, ...region.density.map((bin) => Math.max(bin.geneCount, bin.transcriptCount)));
      region.density.forEach((bin) => {
        const rect = visibleRect(bin.start0, bin.end0, locus, width);
        if (!rect) return;
        const heightPx = Math.max(1, (bin.transcriptCount / maximum) * 12);
        context.fillStyle = "rgba(80,111,99,.18)";
        context.fillRect(rect.x, 49 - heightPx, Math.max(1, rect.width), heightPx);
      });
    }
    region?.genes.forEach((regionGene, index) => {
      const rect = visibleRect(regionGene.start0, regionGene.end0, locus, width);
      if (!rect) return;
      const selected = regionGene.id === gene.id;
      const y = 32 + (index % 2) * 7;
      context.fillStyle = selected ? "#1f6e62" : "rgba(100,116,107,.55)";
      context.fillRect(rect.x, y, Math.max(2, rect.width), selected ? 6 : 4);
      hits.push({
        x: rect.x - 2,
        y: y - 3,
        width: Math.max(8, rect.width + 4),
        height: 12,
        transcriptId: "",
        geneId: regionGene.id,
        label: `${regionGene.symbol}, ${regionGene.transcriptCount} transcripts`,
      });
    });

    // Selected gene summary in the ruler band.
    const geneRect = visibleRect(gene.start0, gene.end0, locus, width);
    context.strokeStyle = "#86928a";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(geneRect?.x ?? 0, 39);
    context.lineTo(geneRect ? geneRect.x + geneRect.width : width, 39);
    context.stroke();
    if (geneRect) {
      context.fillStyle = "#1f6e62";
      context.fillRect(geneRect.x, 34, Math.max(3, geneRect.width), 10);
      context.fillStyle = "#15352f";
      context.textAlign = geneRect.x + geneRect.width < width - 80 ? "left" : "right";
      const labelX = geneRect.x + geneRect.width < width - 80 ? geneRect.x + geneRect.width + 7 : geneRect.x - 7;
      context.fillText(`${gene.symbol} · ${gene.strand} strand`, labelX, 39);
    }

    visibleRows.forEach((row, visibleRowIndex) => {
      const transcript = transcriptById.get(row.transcriptId);
      if (!transcript) return;
      const rowIndex = renderWindow.firstIndex + visibleRowIndex;
      const selectedTranscript = transcript.id === selectedTranscriptId;
      context.fillStyle = selectedTranscript
        ? "rgba(31,110,98,.075)"
        : rowIndex % 2
          ? "rgba(238,241,235,.42)"
          : "rgba(255,255,255,.34)";
      context.fillRect(0, row.y, width, row.height);
      context.strokeStyle = "#e2e6e0";
      context.beginPath();
      context.moveTo(0, row.y + row.height - 0.5);
      context.lineTo(width, row.y + row.height - 0.5);
      context.stroke();
      hits.push({
        x: 0,
        y: row.y,
        width,
        height: Math.min(64, row.height),
        transcriptId: transcript.id,
        label: transcript.name,
      });

      const modelY = row.modelY;
      const visibleExons = transcript.exons
        .map((item) => ({ item, rect: visibleRect(item.start0, item.end0, locus, width) }))
        .filter((entry) => entry.rect !== null);
      if (visibleExons.length) {
        const left = Math.min(...visibleExons.map((entry) => entry.rect!.x));
        const right = Math.max(...visibleExons.map((entry) => entry.rect!.x + entry.rect!.width));
        context.strokeStyle = selectedTranscript ? "#35594f" : "#8d9991";
        context.lineWidth = selectedTranscript ? 1.5 : 1;
        context.beginPath();
        context.moveTo(left, modelY);
        context.lineTo(right, modelY);
        context.stroke();
        context.fillStyle = selectedTranscript ? "#35594f" : "#9ca69f";
        for (let x = left + 28; x < right; x += 46) {
          context.beginPath();
          const direction = transcript.strand === "+" ? 1 : -1;
          context.moveTo(x - 3 * direction, modelY - 2.5);
          context.lineTo(x + 2 * direction, modelY);
          context.lineTo(x - 3 * direction, modelY + 2.5);
          context.fill();
        }
      } else {
        const summary = visibleRect(transcript.start0, transcript.end0, locus, width);
        if (summary) {
          context.fillStyle = transcript.detailState === "error" ? "#a77a62" : "#87968e";
          context.fillRect(summary.x, modelY - 3, summary.width, 6);
          context.setLineDash([3, 3]);
          context.strokeStyle = "#66736c";
          context.strokeRect(summary.x, modelY - 5, summary.width, 10);
          context.setLineDash([]);
        }
      }

      const selectedFeature = transcript.features.find((feature) => feature.recordId === activeFeatureId);
      if (displayMode !== "compact") transcript.exons.forEach((item) => {
        const outer = visibleRect(item.start0, item.end0, locus, width);
        if (!outer) return;
        context.fillStyle = "#f7f8f4";
        context.strokeStyle = selectedTranscript ? "#294c43" : "#76847b";
        context.lineWidth = selectedTranscript ? 1.3 : 1;
        context.fillRect(outer.x, modelY - 5, outer.width, 10);
        context.strokeRect(outer.x, modelY - 5, outer.width, 10);
        if (item.cdsStart0 !== undefined && item.cdsEnd0 !== undefined) {
          const cds = visibleRect(item.cdsStart0, item.cdsEnd0, locus, width);
          if (cds) {
            context.fillStyle = selectedTranscript ? "#355e54" : "#6d8178";
            context.fillRect(cds.x, modelY - 8, cds.width, 16);
          }
        }
      });
      if (selectedFeature) {
        selectedFeature.segments.forEach((segment) => {
          const rect = visibleRect(segment.start0, segment.end0, locus, width);
          if (!rect) return;
          context.strokeStyle = SOURCE_META[selectedFeature.source].color;
          context.lineWidth = 3;
          context.strokeRect(rect.x - 2, modelY - 11, rect.width + 4, 22);
        });
      }

      if (!row.expanded) return;
      if (transcript.featuresState === "loading" || transcript.featuresState === "idle") {
        context.fillStyle = "#6d746f";
        context.textAlign = "left";
        context.font = "12px system-ui, -apple-system, sans-serif";
        context.fillText("Loading local protein annotations…", 18, row.projectionTop + 7);
        context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      } else if (transcript.featuresState === "error") {
        context.fillStyle = "#8a5549";
        context.textAlign = "left";
        context.font = "12px system-ui, -apple-system, sans-serif";
        context.fillText("Feature annotations unavailable · transcript model retained", 18, row.projectionTop + 7);
        context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      } else if (row.laneSources.length === 0) {
        context.fillStyle = "#6d746f";
        context.textAlign = "left";
        context.font = "12px system-ui, -apple-system, sans-serif";
        context.fillText("No features in the selected local sources", 18, row.projectionTop + 7);
        context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      } else {
        row.laneSources.forEach((source, laneIndex) => {
          const laneY = row.projectionTop + laneIndex * row.projectionLaneHeight;
          const meta = SOURCE_META[source];
          context.strokeStyle = "#e1e5df";
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(0, laneY);
          context.lineTo(width, laneY);
          context.stroke();
          transcript.features
            .filter((feature) => feature.source === source)
            .forEach((feature) => {
              feature.segments.forEach((segment) => {
                const rect = visibleRect(segment.start0, segment.end0, locus, width);
                if (!rect) return;
                const selected = feature.recordId === activeFeatureId;
                drawFeatureBlock(context, rect.x, laneY - 4, rect.width, 8, feature, selected);
                hits.push({
                  x: rect.x - 2,
                  y: laneY - 7,
                  width: Math.max(7, rect.width + 4),
                  height: 14,
                  transcriptId: transcript.id,
                  label: `${meta.label}: ${feature.name}, amino acids ${feature.aaStart}–${feature.aaEnd}`,
                  feature,
                });
              });
            });
          context.fillStyle = "rgba(251,252,249,.92)";
          context.fillRect(4, laneY - 7, 34, 14);
          context.fillStyle = meta.color;
          context.textAlign = "left";
          context.font = "bold 9px system-ui, -apple-system, sans-serif";
          context.fillText(meta.shortLabel, 8, laneY);
          context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        });
      }

      // Independent protein coordinate inset. Its geometry never uses locus x.
      const proteinTop = row.proteinTop;
      const plotLeft = 56;
      const plotRight = Math.max(plotLeft + 120, width - 22);
      const plotWidth = plotRight - plotLeft;
      context.fillStyle = "#f1f3ed";
      context.fillRect(12, proteinTop, width - 24, row.proteinHeight);
      context.strokeStyle = "#cdd4cc";
      context.strokeRect(12.5, proteinTop + 0.5, width - 25, row.proteinHeight - 1);
      context.fillStyle = "#536159";
      context.font = "bold 9px system-ui, -apple-system, sans-serif";
      context.textAlign = "left";
      context.fillText("N", 22, proteinTop + 13);
      context.textAlign = "right";
      context.fillText("C", width - 22, proteinTop + 13);
      context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.textAlign = "left";
      context.fillText("1", plotLeft, proteinTop + 13);
      context.textAlign = "right";
      context.fillText(`${transcript.proteinLength} aa`, plotRight, proteinTop + 13);
      const proteinX = (aa: number) => plotLeft + ((aa - 1) / Math.max(1, transcript.proteinLength)) * plotWidth;
      transcript.exons.forEach((item, exonIndex) => {
        if (item.aaStart === undefined || item.aaEnd === undefined) return;
        const x = proteinX(item.aaStart);
        const endX = proteinX(item.aaEnd + 1);
        context.fillStyle = exonIndex % 2 ? "rgba(98,118,107,.13)" : "rgba(98,118,107,.055)";
        context.fillRect(x, proteinTop + 19, Math.max(1, endX - x), row.proteinHeight - 24);
        if (item.phase === 1 || item.phase === 2) {
          context.fillStyle = "#59665f";
          for (let stripe = 0; stripe < 5; stripe += 2) {
            context.fillRect(x + stripe, proteinTop + 19, 1, row.proteinHeight - 24);
          }
          context.fillStyle = "#45534c";
          context.font = "bold 7px system-ui, -apple-system, sans-serif";
          context.fillText(`p${item.phase}`, x + 6, proteinTop + row.proteinHeight - 5);
          context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
          hits.push({
            x: x - 3,
            y: proteinTop + 16,
            width: 22,
            height: row.proteinHeight - 18,
            transcriptId: transcript.id,
            label: `Exon ${item.rank}, GENCODE CDS phase ${item.phase}, split-codon boundary`,
            phase: { exonRank: item.rank, phase: item.phase, aaStart: item.aaStart },
          });
        }
      });
      const visibleAas = transcript.exons.filter(
        (item) =>
          item.aaStart !== undefined &&
          item.aaEnd !== undefined &&
          item.end0 > locus.start0 &&
          item.start0 < locus.end0,
      );
      if (visibleAas.length) {
        const aaStart = Math.min(...visibleAas.map((item) => item.aaStart as number));
        const aaEnd = Math.max(...visibleAas.map((item) => item.aaEnd as number));
        const x = proteinX(aaStart);
        const endX = proteinX(aaEnd + 1);
        context.fillStyle = "#d28a4b";
        context.fillRect(x, proteinTop + 18, Math.max(2, endX - x), 3);
      }
      row.laneSources.forEach((source, laneIndex) => {
        const laneY = proteinTop + 28 + laneIndex * 7;
        context.fillStyle = SOURCE_META[source].color;
        context.textAlign = "left";
        context.font = "bold 8px system-ui, -apple-system, sans-serif";
        context.fillText(SOURCE_META[source].shortLabel, 20, laneY + 3);
        transcript.features
          .filter((feature) => feature.source === source)
          .forEach((feature) => {
            const x = proteinX(feature.aaStart);
            const endX = proteinX(feature.aaEnd + 1);
            const selected = feature.recordId === activeFeatureId;
            drawFeatureBlock(context, x, laneY, endX - x, 5, feature, selected);
            hits.push({
              x: x - 2,
              y: laneY - 3,
              width: Math.max(8, endX - x + 4),
              height: 11,
              transcriptId: transcript.id,
              label: `${SOURCE_META[source].label}: ${feature.name}, amino acids ${feature.aaStart}–${feature.aaEnd}`,
              feature,
            });
          });
      });
    });
    hitRegions.current = hits;
  }, [activeFeatureId, activeSources, displayMode, gene, layout, locus, region, renderWindow, selectedTranscriptId, transcriptById, width]);

  function localPoint(event: { clientX: number; clientY: number }) {
    const bounds = canvasRef.current?.getBoundingClientRect();
    return bounds
      ? { x: event.clientX - bounds.left, y: event.clientY - bounds.top + renderWindow.start0 }
      : { x: 0, y: renderWindow.start0 };
  }

  function hitAt(x: number, y: number) {
    for (let index = hitRegions.current.length - 1; index >= 0; index -= 1) {
      const hit = hitRegions.current[index];
      if (x >= hit.x && x <= hit.x + hit.width && y >= hit.y && y <= hit.y + hit.height) return hit;
    }
    return null;
  }

  function featureHitsAt(x: number, y: number): HitRegion[] {
    const seen = new Set<string>();
    return hitRegions.current.filter((hit) => {
      if (!hit.feature || x < hit.x || x > hit.x + hit.width || y < hit.y || y > hit.y + hit.height) return false;
      if (seen.has(hit.feature.recordId)) return false;
      seen.add(hit.feature.recordId);
      return true;
    });
  }

  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const point = localPoint(event);
    drag.current = { startX: point.x, startLocus: locus, moved: false, mode: point.y <= 25 ? "ruler" : "pan" };
    setOverlapChoices(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const point = localPoint(event);
    if (drag.current) {
      const delta = point.x - drag.current.startX;
      if (Math.abs(delta) > 3) drag.current.moved = true;
      if (drag.current.moved && drag.current.mode === "pan") {
        const bases = -(delta / Math.max(1, width)) * locusSpan(drag.current.startLocus);
        onLocusChange(panLocus(drag.current.startLocus, bases), false);
        setHovered(null);
      }
      return;
    }
    const hit = hitAt(point.x, point.y);
    setHovered(hit?.feature || hit?.phase ? hit : null);
    event.currentTarget.style.cursor = hit?.feature || hit?.phase ? "pointer" : "grab";
  }

  function pointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const state = drag.current;
    drag.current = null;
    if (state?.mode === "ruler" && state.moved) {
      const point = localPoint(event);
      const first = pixelToGenomic(state.startX, state.startLocus, width);
      const second = pixelToGenomic(point.x, state.startLocus, width);
      onLocusChange({
        chrom: state.startLocus.chrom,
        start0: Math.max(0, Math.min(first, second)),
        end0: Math.max(first, second, Math.max(0, Math.min(first, second)) + 1),
      }, true);
    } else if (!state?.moved) {
      const point = localPoint(event);
      const hit = hitAt(point.x, point.y);
      const featureHits = featureHitsAt(point.x, point.y);
      if (featureHits.length > 1) setOverlapChoices({ x: point.x, y: point.y, hits: featureHits });
      else if (hit?.feature) onSelectFeature(hit.feature);
      else if (hit?.phase) setHovered(hit);
      else if (hit?.geneId) onSelectGene?.(hit.geneId);
      else if (hit) onSelectTranscript(hit.transcriptId);
    }
  }

  function wheel(event: ReactWheelEvent<HTMLCanvasElement>) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const point = localPoint(event);
      onLocusChange(zoomLocus(locus, event.deltaY < 0 ? 0.78 : 1.28, point.x / width), false);
    } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && Math.abs(event.deltaX) > 1) {
      event.preventDefault();
      onLocusChange(panLocus(locus, (event.deltaX / width) * locusSpan(locus)), false);
    }
  }

  function keyDown(event: ReactKeyboardEvent<HTMLCanvasElement>) {
    const command = canvasKeyboardCommand(event.key, keyboardShortcutsEnabled);
    if (command === "pan-left" || command === "pan-right") {
      event.preventDefault();
      onLocusChange(panLocus(locus, locusSpan(locus) * (command === "pan-left" ? -0.1 : 0.1)), false);
    } else if (command === "zoom-in") {
      event.preventDefault();
      onLocusChange(zoomLocus(locus, 0.72), false);
    } else if (command === "zoom-out") {
      event.preventDefault();
      onLocusChange(zoomLocus(locus, 1.38), false);
    }
  }

  const selectedTranscript = transcripts.find((item) => item.id === selectedTranscriptId);
  return (
    <div
      ref={containerRef}
      className={`genome-canvas-wrap mode-${displayMode}`}
      style={{ height: layout.totalHeight }}
    >
      <canvas
        ref={canvasRef}
        style={{ top: renderWindow.start0 }}
        tabIndex={0}
        aria-label={`${gene.symbol} genomic transcript models. Drag to pan; Control or Command plus wheel to zoom; ${keyboardShortcutsEnabled ? "arrow keys pan and plus or minus zoom" : "Canvas keyboard shortcuts are disabled in View settings"}.`}
        aria-describedby="canvas-accessible-summary"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={() => { drag.current = null; }}
        onPointerLeave={(event) => {
          if (!drag.current) setHovered(null);
          event.currentTarget.style.cursor = "grab";
        }}
        onWheel={wheel}
        onDoubleClick={(event) => {
          const point = localPoint(event);
          onLocusChange(zoomLocus(locus, 0.5, point.x / width), false);
        }}
        onKeyDown={keyDown}
      />
      {hovered && (
        <div
          className="canvas-tooltip"
          role="tooltip"
          style={{ left: Math.min(width - 270, Math.max(12, hovered.x + 8)), top: hovered.y + 16 }}
        >
          {hovered.feature ? <>
            <span style={{ backgroundColor: SOURCE_META[hovered.feature.source].color }} aria-hidden="true" />
            <strong>{SOURCE_META[hovered.feature.source].label}</strong>
            <p>{hovered.feature.name}</p>
            <small>{hovered.feature.featureId} · aa {hovered.feature.aaStart}–{hovered.feature.aaEnd}</small>
          </> : hovered.phase ? <>
            <span style={{ backgroundColor: "#59665f" }} aria-hidden="true" />
            <strong>Split-codon boundary</strong>
            <p>Exon {hovered.phase.exonRank} · GENCODE CDS phase {hovered.phase.phase}</p>
            <small>{hovered.phase.aaStart === undefined ? "Protein position not mapped" : `Boundary at aa ${hovered.phase.aaStart}`} · phase-aware exon contribution</small>
          </> : null}
        </div>
      )}
      {overlapChoices && (
        <div
          className="canvas-choice-menu"
          role="dialog"
          aria-label="Choose an overlapping protein feature"
          style={{ left: Math.min(width - 290, Math.max(12, overlapChoices.x + 8)), top: overlapChoices.y + 12 }}
        >
          <strong>{overlapChoices.hits.length} features overlap here</strong>
          {overlapChoices.hits.map((hit) => (
            <button
              type="button"
              key={hit.feature!.recordId}
              onClick={() => { onSelectFeature(hit.feature!); setOverlapChoices(null); }}
            >
              <span style={{ backgroundColor: SOURCE_META[hit.feature!.source].color }} aria-hidden="true" />
              <span>{hit.feature!.name}<small>{SOURCE_META[hit.feature!.source].label} · aa {hit.feature!.aaStart}–{hit.feature!.aaEnd}</small></span>
            </button>
          ))}
          <button type="button" className="choice-cancel" onClick={() => setOverlapChoices(null)}>Cancel</button>
        </div>
      )}
      <div id="canvas-accessible-summary" className="sr-only">
        <p>{gene.symbol} has {gene.transcripts.length} GENCODE v45 transcripts. The canvas is mirrored by transcript controls and the inspector feature table.</p>
        {selectedTranscript && (
          <ul>
            {selectedTranscript.exons
              .filter((exon) => exon.phase === 1 || exon.phase === 2)
              .map((exon) => (
                <li key={`phase-${exon.rank}`}>Exon {exon.rank} has GENCODE CDS phase {exon.phase}, marking a split-codon boundary{exon.aaStart === undefined ? "" : ` at amino acid ${exon.aaStart}`}.</li>
              ))}
            {selectedTranscript.features
              .filter((feature) => activeSources.includes(feature.source))
              .map((feature) => (
                <li key={feature.recordId}>
                  {SOURCE_META[feature.source].label}: {feature.name}, amino acids {feature.aaStart} through {feature.aaEnd}, {feature.segments.length} genomic segment{feature.segments.length === 1 ? "" : "s"}.
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}
