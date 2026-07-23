export interface DiagnosticsSnapshot {
  applicationVersion: string;
  buildHash: string;
  gencodeRelease: string;
  ensemblRelease: string;
  assembly: string;
  schemaVersion: string;
  capabilities: readonly string[];
  pdfAvailable: boolean;
  currentGene: string;
  currentTranscript: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  serviceUrl: string;
  externalResourceCount: number;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/\/Users\/[^/\s]+/gu, "/Users/<redacted>").trim();
}

export function safeServiceOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return loopback ? url.origin : "non-loopback origin (unexpected)";
  } catch {
    return "unavailable";
  }
}

/** Produce a bounded, private-content-free diagnostic receipt for support. */
export function formatDiagnostics(snapshot: DiagnosticsSnapshot): string {
  const capabilityText = [...snapshot.capabilities].sort().map(oneLine).join(", ") || "none declared";
  return [
    "Local Transcript Browser diagnostics",
    `Application version: ${oneLine(snapshot.applicationVersion)}`,
    `Annotation build: ${oneLine(snapshot.buildHash)}`,
    `GENCODE release: ${oneLine(snapshot.gencodeRelease)}`,
    `Ensembl release: ${oneLine(snapshot.ensemblRelease)}`,
    `Assembly: ${oneLine(snapshot.assembly)}`,
    `Schema version: ${oneLine(snapshot.schemaVersion)}`,
    `Capabilities: ${capabilityText}`,
    `PDF reports: ${snapshot.pdfAvailable ? "available" : "unavailable"}`,
    `Current gene: ${oneLine(snapshot.currentGene || "none")}`,
    `Current transcript: ${oneLine(snapshot.currentTranscript || "none")}`,
    `Viewport: ${Math.max(0, Math.round(snapshot.viewportWidth))} × ${Math.max(0, Math.round(snapshot.viewportHeight))} CSS px`,
    `Device pixel ratio: ${Number.isFinite(snapshot.devicePixelRatio) ? snapshot.devicePixelRatio : "unavailable"}`,
    `Local service: ${safeServiceOrigin(snapshot.serviceUrl)}`,
    `External runtime resources: ${Math.max(0, Math.floor(snapshot.externalResourceCount))}`,
    `Offline status: ${snapshot.externalResourceCount === 0 ? "loopback-only; no external resources observed" : "external resources observed"}`,
  ].join("\n");
}

