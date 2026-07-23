import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  FIRST_GENE_RENDER_MEASURE,
  MAX_FPS_SAMPLES,
  MAX_FPS_SAMPLE_WINDOW_MS,
  canvasBackingBytes,
  firstGeneRenderDuration,
  framesPerSecond,
  summarizeResourceNames,
  type ResourceDiagnosticSummary,
} from "../lib/releaseDiagnostics";

export interface ReleaseDiagnosticsProps {
  enabled: boolean;
}

type MetricStatus = "waiting" | "sampling" | "ready" | "unavailable" | "unsupported";

interface NumericMetric {
  status: MetricStatus;
  value: number | null;
}

interface FpsMetric extends NumericMetric {
  samples: number;
}

interface LongTaskMetric {
  supported: boolean;
  count: number;
  maxDurationMs: number;
}

interface MemoryWithHeap {
  usedJSHeapSize?: number;
}

interface UserAgentMemoryResult {
  bytes?: number;
}

interface PerformanceWithUserAgentMemory extends Performance {
  measureUserAgentSpecificMemory?: () => Promise<UserAgentMemoryResult>;
}

interface BrowserEnvironment {
  userAgent: string;
  devicePixelRatio: number | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
}

const EMPTY_RESOURCES: ResourceDiagnosticSummary = {
  totalEntries: 0,
  externalEntries: 0,
  totalOrigins: 0,
  urls: [],
  origins: [],
  urlsTruncated: false,
  originsTruncated: false,
};

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

function rounded(value: number | null, digits = 1): string {
  return value === null ? "" : value.toFixed(digits);
}

function metricText(metric: NumericMetric, digits = 1): string {
  return metric.status === "ready" ? rounded(metric.value, digits) : metric.status;
}

function readFirstRender(): number | null {
  if (typeof performance === "undefined") return null;
  return firstGeneRenderDuration(performance.getEntriesByName(FIRST_GENE_RENDER_MEASURE));
}

function readHeap(): NumericMetric {
  if (typeof performance === "undefined") return { status: "unsupported", value: null };
  const memory = (performance as Performance & { memory?: MemoryWithHeap }).memory;
  const value = memory?.usedJSHeapSize;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { status: "unsupported", value: null };
  }
  return { status: "ready", value };
}

function readResources(): ResourceDiagnosticSummary {
  if (typeof performance === "undefined" || typeof window === "undefined") {
    return EMPTY_RESOURCES;
  }
  const names = performance.getEntriesByType("resource").map((entry) => entry.name);
  return summarizeResourceNames(names, window.location.href, window.location.origin);
}

function readCanvasBytes(): NumericMetric {
  if (typeof document === "undefined") return { status: "unsupported", value: null };
  return {
    status: "ready",
    value: canvasBackingBytes(document.querySelectorAll("canvas")),
  };
}

function readEnvironment(): BrowserEnvironment {
  return {
    userAgent: typeof navigator === "undefined" ? "unsupported" : navigator.userAgent,
    devicePixelRatio: typeof window === "undefined" ? null : window.devicePixelRatio,
    viewportWidth: typeof window === "undefined" ? null : window.innerWidth,
    viewportHeight: typeof window === "undefined" ? null : window.innerHeight,
  };
}

function observerSupports(entryType: string): boolean {
  if (typeof PerformanceObserver === "undefined") return false;
  const supported = PerformanceObserver.supportedEntryTypes;
  return Array.isArray(supported) && supported.includes(entryType);
}

/**
 * Local, visually hidden release evidence. It reads browser performance state
 * only; it does not initiate requests or transmit measurements.
 */
export function ReleaseDiagnostics({ enabled }: ReleaseDiagnosticsProps) {
  const initialFirstRender = readFirstRender();
  const [firstRender, setFirstRender] = useState<NumericMetric>(() => ({
    status: initialFirstRender === null
      ? (typeof performance === "undefined" ? "unsupported" : "waiting")
      : "ready",
    value: initialFirstRender,
  }));
  const [fps, setFps] = useState<FpsMetric>({ status: "waiting", value: null, samples: 0 });
  const [longTasks, setLongTasks] = useState<LongTaskMetric>(() => ({
    supported: observerSupports("longtask"),
    count: 0,
    maxDurationMs: 0,
  }));
  const [heap, setHeap] = useState<NumericMetric>(() => readHeap());
  const [userAgentMemory, setUserAgentMemory] = useState<NumericMetric>(() => {
    if (typeof performance === "undefined") return { status: "unsupported", value: null };
    const measure = (performance as PerformanceWithUserAgentMemory).measureUserAgentSpecificMemory;
    return typeof measure === "function"
      ? { status: "waiting", value: null }
      : { status: "unsupported", value: null };
  });
  const [canvasBytes, setCanvasBytes] = useState<NumericMetric>(() => readCanvasBytes());
  const [environment, setEnvironment] = useState<BrowserEnvironment>(() => readEnvironment());
  const [resources, setResources] = useState<ResourceDiagnosticSummary>(() => readResources());
  const fpsStarted = useRef(false);

  useEffect(() => {
    const current = readFirstRender();
    if (current !== null) {
      setFirstRender({ status: "ready", value: current });
    }

    if (!observerSupports("measure")) return;
    const observer = new PerformanceObserver((list) => {
      const duration = firstGeneRenderDuration(list.getEntries());
      if (duration !== null) setFirstRender({ status: "ready", value: duration });
    });
    try {
      observer.observe({ type: "measure", buffered: true });
    } catch {
      setFirstRender((metric) => metric.value === null
        ? { status: "unavailable", value: null }
        : metric);
      observer.disconnect();
      return;
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const refresh = () => setCanvasBytes(readCanvasBytes());
    refresh();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["width", "height"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = () => setEnvironment(readEnvironment());
    refresh();
    window.addEventListener("resize", refresh, { passive: true });
    return () => window.removeEventListener("resize", refresh);
  }, []);

  useEffect(() => {
    if (!enabled || typeof performance === "undefined") return;
    const measure = (performance as PerformanceWithUserAgentMemory).measureUserAgentSpecificMemory;
    if (typeof measure !== "function") {
      setUserAgentMemory({ status: "unsupported", value: null });
      return;
    }
    let cancelled = false;
    setUserAgentMemory({ status: "sampling", value: null });
    void measure.call(performance)
      .then((result) => {
        if (cancelled) return;
        const value = result.bytes;
        setUserAgentMemory(typeof value === "number" && Number.isFinite(value) && value >= 0
          ? { status: "ready", value }
          : { status: "unavailable", value: null });
      })
      .catch(() => {
        if (!cancelled) setUserAgentMemory({ status: "unavailable", value: null });
      });
    return () => { cancelled = true; };
  }, [enabled]);

  useEffect(() => {
    if (!longTasks.supported) return;
    const observer = new PerformanceObserver((list) => {
      const durations = list.getEntries()
        .map((entry) => entry.duration)
        .filter((duration) => Number.isFinite(duration) && duration >= 0);
      if (durations.length === 0) return;
      let batchMaximum = 0;
      for (const duration of durations) batchMaximum = Math.max(batchMaximum, duration);
      setLongTasks((current) => ({
        supported: true,
        count: current.count + durations.length,
        maxDurationMs: Math.max(current.maxDurationMs, batchMaximum),
      }));
    });
    try {
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      setLongTasks({ supported: false, count: 0, maxDurationMs: 0 });
      observer.disconnect();
      return;
    }
    return () => observer.disconnect();
  // Support is fixed for the page lifetime; do not restart the buffered observer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const refresh = () => setResources(readResources());
    refresh();
    if (!observerSupports("resource")) return;
    const observer = new PerformanceObserver(refresh);
    try {
      observer.observe({ type: "resource", buffered: true });
    } catch {
      observer.disconnect();
      return;
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setHeap(readHeap());
    setCanvasBytes(readCanvasBytes());
    setResources(readResources());
    const duration = readFirstRender();
    if (duration !== null) setFirstRender({ status: "ready", value: duration });

    if (fpsStarted.current || fps.status === "ready" || fps.status === "unsupported") return;
    if (
      typeof requestAnimationFrame === "undefined"
      || typeof cancelAnimationFrame === "undefined"
    ) {
      setFps({ status: "unsupported", value: null, samples: 0 });
      return;
    }

    fpsStarted.current = true;
    setFps({ status: "sampling", value: null, samples: 0 });
    const timestamps: number[] = [];
    let frame = 0;
    let complete = false;
    const sample = (timestamp: number) => {
      timestamps.push(timestamp);
      const elapsed = timestamp - timestamps[0];
      if (timestamps.length >= MAX_FPS_SAMPLES || elapsed >= MAX_FPS_SAMPLE_WINDOW_MS) {
        complete = true;
        const value = framesPerSecond(timestamps);
        setFps({
          status: value === null ? "unavailable" : "ready",
          value,
          samples: timestamps.length,
        });
        setHeap(readHeap());
        setCanvasBytes(readCanvasBytes());
        setResources(readResources());
        const measured = readFirstRender();
        setFirstRender((metric) => measured === null
          ? (metric.value === null ? { status: "unavailable", value: null } : metric)
          : { status: "ready", value: measured });
        return;
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);

    return () => {
      cancelAnimationFrame(frame);
      if (!complete) fpsStarted.current = false;
    };
  }, [enabled, fps.status]);

  const firstRenderText = metricText(firstRender);
  const fpsText = metricText(fps);
  const heapText = heap.status === "ready" ? rounded(heap.value, 0) : heap.status;
  const userAgentMemoryText = userAgentMemory.status === "ready"
    ? rounded(userAgentMemory.value, 0)
    : userAgentMemory.status;
  const canvasBytesText = canvasBytes.status === "ready" ? rounded(canvasBytes.value, 0) : canvasBytes.status;
  const longTaskText = longTasks.supported ? rounded(longTasks.maxDurationMs) : "unsupported";

  return (
    <section
      id="release-diagnostics"
      aria-hidden="true"
      style={VISUALLY_HIDDEN}
      data-release-diagnostics="local"
      data-enabled={enabled ? "true" : "false"}
      data-first-gene-render-ms={firstRenderText}
      data-fps={fpsText}
      data-fps-samples={String(fps.samples)}
      data-long-task-supported={longTasks.supported ? "true" : "false"}
      data-long-task-count={String(longTasks.count)}
      data-long-task-max-ms={longTaskText}
      data-js-heap-status={heap.status}
      data-js-heap-used-bytes={heapText}
      data-user-agent-memory-status={userAgentMemory.status}
      data-user-agent-memory-bytes={userAgentMemoryText}
      data-canvas-backing-bytes={canvasBytesText}
      data-user-agent={environment.userAgent}
      data-device-pixel-ratio={environment.devicePixelRatio === null ? "unsupported" : String(environment.devicePixelRatio)}
      data-viewport-width={environment.viewportWidth === null ? "unsupported" : String(environment.viewportWidth)}
      data-viewport-height={environment.viewportHeight === null ? "unsupported" : String(environment.viewportHeight)}
      data-resource-count={String(resources.totalEntries)}
      data-resource-origin-count={String(resources.totalOrigins)}
      data-external-resource-count={String(resources.externalEntries)}
      data-resource-urls-truncated={resources.urlsTruncated ? "true" : "false"}
      data-resource-origins-truncated={resources.originsTruncated ? "true" : "false"}
    >
      <span data-diagnostic="first-gene-render">first-gene-render-ms={firstRenderText}</span>
      <span data-diagnostic="fps">fps={fpsText};samples={fps.samples}</span>
      <span data-diagnostic="long-tasks">
        long-task-count={longTasks.count};long-task-max-ms={longTaskText}
      </span>
      <span data-diagnostic="js-heap">js-heap-used-bytes={heapText}</span>
      <span data-diagnostic="user-agent-memory">
        user-agent-memory-status={userAgentMemory.status};user-agent-memory-bytes={userAgentMemoryText}
      </span>
      <span data-diagnostic="canvas-backing">canvas-backing-bytes={canvasBytesText}</span>
      <span data-diagnostic="browser-environment">
        user-agent={environment.userAgent};dpr={environment.devicePixelRatio ?? "unsupported"};viewport={environment.viewportWidth ?? "unsupported"}x{environment.viewportHeight ?? "unsupported"}
      </span>
      <span data-diagnostic="resources">
        resource-count={resources.totalEntries};external-resource-count={resources.externalEntries}
      </span>
      <ol data-diagnostic-resource-origins="true">
        {resources.origins.map((origin) => <li key={origin}>{origin}</li>)}
      </ol>
      <ol data-diagnostic-resource-urls="true">
        {resources.urls.map((url, index) => <li key={`${index}:${url}`}>{url}</li>)}
      </ol>
    </section>
  );
}

export default ReleaseDiagnostics;
