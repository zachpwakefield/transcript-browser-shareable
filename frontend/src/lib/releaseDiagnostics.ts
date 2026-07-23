export const FIRST_GENE_RENDER_MEASURE = "transcript-browser-first-gene-render";
export const MAX_FPS_SAMPLES = 120;
export const MAX_FPS_SAMPLE_WINDOW_MS = 2_000;
export const MAX_LISTED_RESOURCE_URLS = 32;
export const MAX_LISTED_RESOURCE_ORIGINS = 12;
export const MAX_LISTED_RESOURCE_URL_LENGTH = 512;

export interface ResourceDiagnosticSummary {
  totalEntries: number;
  externalEntries: number;
  totalOrigins: number;
  urls: string[];
  origins: string[];
  urlsTruncated: boolean;
  originsTruncated: boolean;
}

export interface CanvasBitmapDimensions {
  width: number;
  height: number;
}

/** Conservative RGBA byte count for app-owned Canvas backing stores. */
export function canvasBackingBytes(canvases: Iterable<CanvasBitmapDimensions>): number {
  let total = 0;
  for (const canvas of canvases) {
    const width = Number.isFinite(canvas.width) ? Math.max(0, Math.floor(canvas.width)) : 0;
    const height = Number.isFinite(canvas.height) ? Math.max(0, Math.floor(canvas.height)) : 0;
    total += width * height * 4;
  }
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}

function boundedText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, Math.max(0, maximumLength - 1))}\u2026`;
}

function resourceOrigin(url: URL): string {
  return url.origin === "null" ? url.protocol : url.origin;
}

/**
 * Build a bounded DOM-safe view of the browser's resource timing names while
 * retaining exact counts across every entry supplied by the Performance API.
 */
export function summarizeResourceNames(
  entryNames: readonly string[],
  pageHref: string,
  pageOrigin: string,
): ResourceDiagnosticSummary {
  let externalEntries = 0;
  const allOrigins = new Set<string>();
  const urls: string[] = [];

  for (const name of entryNames) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(name, pageHref);
    } catch {
      // Performance resource names are normally absolute URLs. Retain a
      // bounded marker if an engine or test harness supplies an invalid one.
    }

    const origin = parsed ? resourceOrigin(parsed) : "invalid:";
    allOrigins.add(origin);
    if (
      parsed
      && (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.origin !== pageOrigin
    ) {
      externalEntries += 1;
    }

    if (urls.length < MAX_LISTED_RESOURCE_URLS) {
      urls.push(boundedText(parsed?.href ?? name, MAX_LISTED_RESOURCE_URL_LENGTH));
    }
  }

  const origins = Array.from(allOrigins).sort().slice(0, MAX_LISTED_RESOURCE_ORIGINS);
  return {
    totalEntries: entryNames.length,
    externalEntries,
    totalOrigins: allOrigins.size,
    urls,
    origins,
    urlsTruncated: entryNames.length > urls.length,
    originsTruncated: allOrigins.size > origins.length,
  };
}

export function firstGeneRenderDuration(entries: readonly PerformanceEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.name === FIRST_GENE_RENDER_MEASURE
      && entry.entryType === "measure"
      && Number.isFinite(entry.duration)
      && entry.duration >= 0
    ) {
      return entry.duration;
    }
  }
  return null;
}

export function framesPerSecond(timestamps: readonly number[]): number | null {
  if (timestamps.length < 2) return null;
  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  const elapsed = last - first;
  if (!Number.isFinite(first) || !Number.isFinite(last) || elapsed <= 0) return null;
  return ((timestamps.length - 1) * 1_000) / elapsed;
}
