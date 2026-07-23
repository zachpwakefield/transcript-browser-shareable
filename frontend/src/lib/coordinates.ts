import type { Locus } from "../types";

const LOCUS_PATTERN = /^(?:chr)?([A-Za-z0-9_.-]+)\s*:\s*([\d,]+)\s*(?:-|\.\.)\s*([\d,]+)$/i;
export const MAX_LOCUS_SPAN_BP = 25_000_000;

export function parseLocus(value: string): Locus | null {
  const match = LOCUS_PATTERN.exec(value.trim());
  if (!match) return null;
  const start1 = Number(match[2].replaceAll(",", ""));
  const end1 = Number(match[3].replaceAll(",", ""));
  if (!Number.isSafeInteger(start1) || !Number.isSafeInteger(end1)) return null;
  if (start1 < 1 || end1 < start1) return null;
  if (end1 - start1 + 1 > MAX_LOCUS_SPAN_BP) return null;
  return {
    chrom: `chr${match[1].replace(/^chr/i, "")}`,
    start0: start1 - 1,
    end0: end1,
  };
}

export function formatLocus(locus: Locus): string {
  return `${locus.chrom}:${(locus.start0 + 1).toLocaleString("en-US")}-${locus.end0.toLocaleString("en-US")}`;
}

export function locusSpan(locus: Locus): number {
  return Math.max(1, locus.end0 - locus.start0);
}

export function fitInterval(
  chrom: string,
  start0: number,
  end0: number,
  paddingFraction = 0.08,
  minimumPadding = 800,
): Locus {
  const span = Math.max(1, end0 - start0);
  const padding = Math.max(minimumPadding, Math.round(span * paddingFraction));
  return {
    chrom,
    start0: Math.max(0, start0 - padding),
    end0: end0 + padding,
  };
}

export function zoomLocus(locus: Locus, scale: number, anchor = 0.5): Locus {
  const clampedAnchor = Math.max(0, Math.min(1, anchor));
  const oldSpan = locusSpan(locus);
  const newSpan = Math.min(MAX_LOCUS_SPAN_BP, Math.max(20, Math.round(oldSpan * scale)));
  const anchorPosition = locus.start0 + oldSpan * clampedAnchor;
  let start0 = Math.round(anchorPosition - newSpan * clampedAnchor);
  if (start0 < 0) start0 = 0;
  return { chrom: locus.chrom, start0, end0: start0 + newSpan };
}

export function panLocus(locus: Locus, deltaBases: number): Locus {
  const span = locusSpan(locus);
  const start0 = Math.max(0, Math.round(locus.start0 + deltaBases));
  return { ...locus, start0, end0: start0 + span };
}

export function genomicToPixel(
  position0: number,
  locus: Locus,
  width: number,
): number {
  return ((position0 - locus.start0) / locusSpan(locus)) * width;
}

export function pixelToGenomic(x: number, locus: Locus, width: number): number {
  return Math.round(locus.start0 + (x / Math.max(width, 1)) * locusSpan(locus));
}

export function formatBaseCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)} Mb`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)} kb`;
  return `${value} bp`;
}
