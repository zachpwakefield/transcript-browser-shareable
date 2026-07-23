import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  createTranscriptPdf,
  fallbackManifest,
  loadGene,
  loadManifest,
  loadRegion,
  loadTranscript,
  loadTranscriptFeatures,
  searchLocal,
} from "./api";
import { CommandBar } from "./components/CommandBar";
import { AboutDiagnosticsDialog } from "./components/AboutDiagnosticsDialog";
import { ComparisonPanel } from "./components/ComparisonPanel";
import { FilterBar } from "./components/FilterBar";
import { GenomeCanvas } from "./components/GenomeCanvas";
import { HelpOverlay } from "./components/HelpOverlay";
import { PdfExportDialog } from "./components/PdfExportDialog";
import { Inspector } from "./components/Inspector";
import { ReleaseDiagnostics } from "./components/ReleaseDiagnostics";
import { SessionActions } from "./components/SessionActions";
import { TranscriptLabels } from "./components/TranscriptLabels";
import { TranscriptMinimap } from "./components/TranscriptMinimap";
import { TranscriptNavigator } from "./components/TranscriptNavigator";
import { WorkspaceEntityMenu } from "./components/WorkspaceEntityMenu";
import { DEFAULT_VIEW_STATE } from "./data/sp1";
import { fitInterval, formatLocus, zoomLocus } from "./lib/coordinates";
import { enabledFeatureSources, filterTranscriptsWithContext, transcriptMatchesFilters } from "./lib/filters";
import { browserKeyboardCommand } from "./lib/keyboard";
import {
  ComparisonExportSelectionError,
  buildComparisonExportRows,
  comparisonExportFilename,
  selectComparisonExportTranscripts,
  serializeComparisonExport,
  type ComparisonExportFormat,
} from "./lib/comparisonExport";
import { resolveQuickPdfPreset } from "./lib/pdfPreset";
import { buildRowLayout } from "./lib/layout";
import { normalizedSearchToken, resolveSubmittedSearch } from "./lib/searchResolution";
import {
  DEFAULT_TRANSCRIPT_RENDER_LIMIT,
  MAX_EXPANDED_TRANSCRIPTS,
  MAX_TRANSCRIPT_RENDER_LIMIT,
  defaultProteinTranscriptId,
  featureSelectionForTranscript,
  intervalOverlapsLocus,
  nextExpansionState,
  nextPinnedState,
  semanticDisplayMode,
  transcriptRevealDecision,
  transcriptsForDisplay,
  type TranscriptRevealRequest,
} from "./lib/navigation";
import { encodeViewState, parseViewState, requestedBuildHash, restoreViewState } from "./lib/urlState";
import {
  applyTranscriptOrder,
  moveTranscriptRelative,
  normalizeTranscriptOrder,
  transcriptNeighborIds,
  type TranscriptOrderAction,
  type TranscriptOrderPlacement,
} from "./lib/transcriptOrder";
import { transcriptDemandIds, variableRowWindow } from "./lib/windowing";
import { chooseInitialView } from "./lib/viewRestore";
import {
  WORKSPACE_WRITE_DEBOUNCE_MS,
  addRecentEntity,
  clearWorkspaceState,
  createEmptyWorkspaceState,
  createEntityReference,
  entityReferenceKey,
  loadWorkspaceState,
  mergeImportedAnnotations,
  saveWorkspaceState,
  setUserAnnotation,
  toggleFavoriteEntity,
  removeUserAnnotation,
  withLastView,
  withLastPdfPreset,
  type EntityReference,
  type EntityKey,
  type UserAnnotation,
  type LocalWorkspaceState,
} from "./lib/workspaceStore";
import type {
  BrowserViewState,
  BuildManifest,
  DisplayModeSetting,
  FeatureClass,
  FeatureSource,
  Gene,
  InspectorTab,
  LoadState,
  Locus,
  ProteinFeature,
  RegionData,
  RowDensity,
  SearchResult,
  Transcript,
  TranscriptFlag,
} from "./types";

interface BuildMismatch {
  requested: string;
  current: string;
}

const EMPTY_GENE: Gene = {
  id: "",
  versionedId: "",
  symbol: "—",
  name: "No local gene loaded",
  hgncId: "Not assigned",
  biotype: "unknown",
  chrom: DEFAULT_VIEW_STATE.locus.chrom,
  start0: DEFAULT_VIEW_STATE.locus.start0,
  end0: DEFAULT_VIEW_STATE.locus.end0,
  strand: "+",
  transcripts: [],
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "An unknown local service error occurred.";
}

export default function App() {
  const requestedBuildOnLoad = useRef(requestedBuildHash(window.location.search));
  const firstGeneMeasured = useRef(false);
  const navigationController = useRef<AbortController | undefined>(undefined);
  const detailControllers = useRef(new Set<AbortController>());
  const featureControllers = useRef(new Set<AbortController>());
  const lastValidLocus = useRef(DEFAULT_VIEW_STATE.locus);
  const [manifest, setManifest] = useState<BuildManifest>(fallbackManifest());
  const [localWorkspace, setLocalWorkspace] = useState<LocalWorkspaceState>(() => createEmptyWorkspaceState(DEFAULT_VIEW_STATE.buildHash));
  const [localWorkspaceLoaded, setLocalWorkspaceLoaded] = useState(false);
  const [manifestState, setManifestState] = useState<LoadState>("loading");
  const [startupError, setStartupError] = useState<string>();
  const [gene, setGene] = useState<Gene>(EMPTY_GENE);
  const [geneState, setGeneState] = useState<LoadState>("idle");
  const [geneError, setGeneError] = useState<string>();
  const [geneRetry, setGeneRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const [featureRetry, setFeatureRetry] = useState(0);
  const [region, setRegion] = useState<RegionData>();
  const [regionState, setRegionState] = useState<LoadState>("idle");
  const [regionError, setRegionError] = useState<string>();
  const [regionRetry, setRegionRetry] = useState(0);
  const [view, setView] = useState<BrowserViewState>(() =>
    parseViewState(window.location.search, DEFAULT_VIEW_STATE),
  );
  const viewRef = useRef(view);
  const transcriptRevealRequestId = useRef(0);
  const pendingTranscriptReveal = useRef<TranscriptRevealRequest | null>({
    requestId: 0,
    geneId: view.selectedGeneId,
    transcriptId: view.selectedTranscriptId || undefined,
  });
  const pendingDefaultProteinGeneId = useRef<string | undefined>(undefined);
  const skipNextWorkspaceSave = useRef(false);
  const [query, setQuery] = useState("SP1");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchState, setSearchState] = useState<LoadState>("idle");
  const [searchError, setSearchError] = useState<string>();
  const [searchMessage, setSearchMessage] = useState<string>();
  const [sessionMessage, setSessionMessage] = useState<string>();
  const [reorderFocusTranscriptId, setReorderFocusTranscriptId] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1040);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [quickPdfBusy, setQuickPdfBusy] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [navigatorQuery, setNavigatorQuery] = useState("");
  const [buildMismatch, setBuildMismatch] = useState<BuildMismatch>();
  const [transcriptRenderLimit, setTranscriptRenderLimit] = useState(DEFAULT_TRANSCRIPT_RENDER_LIMIT);
  const [trackScrollerElement, setTrackScrollerElement] = useState<HTMLDivElement | null>(null);
  const [trackViewport, setTrackViewport] = useState({ scrollTop: 0, height: 720 });

  const writeHistory = useCallback((next: BrowserViewState, push: boolean) => {
    window.history[push ? "pushState" : "replaceState"](
      {},
      "",
      `${window.location.pathname}${encodeViewState(next)}`,
    );
  }, []);

  const commitView = useCallback((
    update: Partial<BrowserViewState> | ((current: BrowserViewState) => BrowserViewState),
    push = false,
  ) => {
    const current = viewRef.current;
    const next = typeof update === "function" ? update(current) : { ...current, ...update };
    viewRef.current = next;
    setView(next);
    writeHistory(next, push);
  }, [writeHistory]);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const closePdf = useCallback(() => setPdfOpen(false), []);
  const requestTranscriptReveal = useCallback((geneId: string, transcriptId?: string) => {
    transcriptRevealRequestId.current += 1;
    pendingTranscriptReveal.current = {
      requestId: transcriptRevealRequestId.current,
      geneId,
      transcriptId: transcriptId || undefined,
    };
  }, []);

  function recordRecent(reference: EntityReference) {
    setLocalWorkspace((current) => ({
      ...current,
      recents: addRecentEntity(current.recents, reference),
    }));
  }

  function toggleFavorite(reference: EntityReference) {
    const wasFavorite = localWorkspace.favorites.some((item) => entityReferenceKey(item) === entityReferenceKey(reference));
    setLocalWorkspace((current) => ({
      ...current,
      favorites: toggleFavoriteEntity(current.favorites, reference),
    }));
    setSessionMessage(`${reference.label} ${wasFavorite ? "removed from" : "added to"} favorites.`);
  }

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Transcript/feature records are immutable across locus changes, so useful
  // in-flight work may finish while panning. A gene change or unmount makes
  // those requests stale and aborts them as a group.
  useEffect(() => () => {
    detailControllers.current.forEach((controller) => controller.abort());
    detailControllers.current.clear();
    featureControllers.current.forEach((controller) => controller.abort());
    featureControllers.current.clear();
  }, [gene.id]);

  useEffect(() => setPdfOpen(false), [gene.id]);
  useEffect(() => setNavigatorQuery(""), [gene.id]);

  // Manifest validation is the gate for deterministic deep-link restoration.
  useEffect(() => {
    const controller = new AbortController();
    setManifestState("loading");
    setStartupError(undefined);
    void loadManifest(controller.signal)
      .then((nextManifest) => {
        setManifest(nextManifest);
        setManifestState("ready");
        let loadedWorkspace = createEmptyWorkspaceState(nextManifest.buildHash);
        let workspaceStatus: ReturnType<typeof loadWorkspaceState>["status"] = "missing";
        try {
          const loaded = loadWorkspaceState(window.localStorage, nextManifest.buildHash);
          loadedWorkspace = loaded.state;
          workspaceStatus = loaded.status;
        } catch {
          workspaceStatus = "invalid";
        }
        setLocalWorkspace(loadedWorkspace);
        setLocalWorkspaceLoaded(true);
        const restored = restoreViewState(window.location.search, DEFAULT_VIEW_STATE, nextManifest.buildHash);
        const initial = chooseInitialView(window.location.search, restored.view, loadedWorkspace);
        const requested = requestedBuildOnLoad.current;
        if (restored.mismatchedBuild) {
          setBuildMismatch({ requested: requested ?? restored.mismatchedBuild, current: nextManifest.buildHash });
        }
        requestTranscriptReveal(
          initial.view.selectedGeneId,
          initial.view.selectedTranscriptId || undefined,
        );
        viewRef.current = initial.view;
        setView(initial.view);
        writeHistory(initial.view, false);
        if (initial.restoredLastView) setSessionMessage("Restored the last validated local view.");
        else if (workspaceStatus === "invalid") setSessionMessage("Saved workspace data was invalid and was safely ignored.");
        else if (workspaceStatus === "build-mismatch") setSessionMessage("Saved workspace belongs to another annotation build and was safely ignored.");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setManifestState("error");
        setStartupError(errorMessage(error));
      });
    return () => controller.abort();
  }, [requestTranscriptReveal, writeHistory]);

  useEffect(() => {
    if (!localWorkspaceLoaded || manifestState !== "ready" || geneState !== "ready" || gene.id !== view.selectedGeneId) return;
    if (skipNextWorkspaceSave.current) {
      skipNextWorkspaceSave.current = false;
      return;
    }
    const timeout = window.setTimeout(() => {
      try {
        saveWorkspaceState(window.localStorage, withLastView(localWorkspace, view));
      } catch {
        setSessionMessage("The bounded local workspace could not be saved in this browser.");
      }
    }, WORKSPACE_WRITE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [gene.id, geneState, localWorkspace, localWorkspaceLoaded, manifestState, view]);

  // Complete locus state, rather than only coordinates, follows back/forward.
  useEffect(() => {
    if (manifestState !== "ready") return;
    const pop = () => {
      const restored = restoreViewState(window.location.search, DEFAULT_VIEW_STATE, manifest.buildHash);
      setBuildMismatch(restored.mismatchedBuild
        ? { requested: restored.mismatchedBuild, current: manifest.buildHash }
        : undefined);
      requestTranscriptReveal(
        restored.view.selectedGeneId,
        restored.view.selectedTranscriptId || undefined,
      );
      viewRef.current = restored.view;
      setView(restored.view);
      if (restored.mismatchedBuild) writeHistory(restored.view, false);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [manifest.buildHash, manifestState, requestTranscriptReveal, writeHistory]);

  // The selected gene owns transcript ordering. Detail requests are bounded by
  // local concurrency and leave summary rows usable if one transcript fails.
  useEffect(() => {
    if (manifestState !== "ready" || !view.selectedGeneId) return;
    const controller = new AbortController();
    setGeneState("loading");
    setGeneError(undefined);
    void loadGene(view.selectedGeneId, controller.signal, manifest.buildHash)
      .then((nextGene) => {
        const current = viewRef.current;
        if (current.selectedGeneId !== view.selectedGeneId) return;
        setGene(nextGene);
        setQuery(nextGene.symbol);
        setGeneState("ready");
        setTranscriptRenderLimit(DEFAULT_TRANSCRIPT_RENDER_LIMIT);
        const known = new Set(nextGene.transcripts.map((transcript) => transcript.id));
        const canonicalTranscriptIds = nextGene.transcripts.map((transcript) => transcript.id);
        const pendingProteinNavigation = pendingDefaultProteinGeneId.current === nextGene.id;
        if (pendingProteinNavigation) pendingDefaultProteinGeneId.current = undefined;
        const requestedSelectionKnown = known.has(current.selectedTranscriptId);
        const defaultProteinNavigation = pendingProteinNavigation
          || (!requestedSelectionKnown && current.displayMode === "expanded");
        const selectedTranscriptId = requestedSelectionKnown
          ? current.selectedTranscriptId
          : defaultProteinNavigation
            ? defaultProteinTranscriptId(nextGene.transcripts)
            : nextGene.transcripts[0]?.id ?? "";
        const retainedExpandedTranscriptIds = current.expandedTranscriptIds
          .filter((id, index, values) => known.has(id) && values.indexOf(id) === index)
          .slice(0, MAX_EXPANDED_TRANSCRIPTS);
        const defaultSelectedTranscript = nextGene.transcripts.find((transcript) => (
          transcript.id === selectedTranscriptId && transcript.proteinLength > 0
        ));
        const next: BrowserViewState = {
          ...current,
          selectedGeneId: nextGene.id,
          selectedTranscriptId,
          comparisonTranscriptId: known.has(current.comparisonTranscriptId)
            && current.comparisonTranscriptId !== selectedTranscriptId
            ? current.comparisonTranscriptId
            : "",
          transcriptOrderIds: normalizeTranscriptOrder(canonicalTranscriptIds, current.transcriptOrderIds),
          expandedTranscriptIds: defaultProteinNavigation && defaultSelectedTranscript
            ? nextExpansionState(defaultSelectedTranscript.id, retainedExpandedTranscriptIds, true)
            : retainedExpandedTranscriptIds,
          pinnedTranscriptIds: current.pinnedTranscriptIds.filter((id) => known.has(id)),
          selectedFeatureId: selectedTranscriptId === current.selectedTranscriptId
            ? current.selectedFeatureId
            : undefined,
        };
        viewRef.current = next;
        setView(next);
        writeHistory(next, false);
        try {
          recordRecent(createEntityReference({
            kind: "gene",
            id: nextGene.id,
            versionedId: nextGene.versionedId,
            label: nextGene.symbol,
            geneSymbol: nextGene.symbol,
          }));
          const recentTranscript = nextGene.transcripts.find((transcript) => transcript.id === selectedTranscriptId);
          if (current.selectedTranscriptId && recentTranscript) {
            recordRecent(createEntityReference({
              kind: "transcript",
              id: recentTranscript.id,
              versionedId: recentTranscript.versionedId,
              label: recentTranscript.name,
              geneId: nextGene.id,
              geneSymbol: nextGene.symbol,
            }));
          }
        } catch {
          // API-normalized identifiers should always satisfy persistence bounds.
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setGeneState("error");
        setGeneError(errorMessage(error));
      });
    return () => controller.abort();
  }, [geneRetry, manifest.buildHash, manifestState, view.selectedGeneId, writeHistory]);

  // Measure the first committed selected-gene render locally. No measurement is
  // transmitted; release checks can read it from the browser Performance API.
  useEffect(() => {
    if (geneState !== "ready" || firstGeneMeasured.current) return;
    firstGeneMeasured.current = true;
    performance.mark("transcript-browser-first-gene-rendered");
    try {
      performance.measure(
        "transcript-browser-first-gene-render",
        "transcript-browser-app-start",
        "transcript-browser-first-gene-rendered",
      );
    } catch {
      // A directly mounted test shell may not install the app-start mark.
    }
  }, [gene.id, geneState]);

  // Server-side search owns ID/coordinate validation. Stale keystroke requests
  // are aborted and never replace newer result sets.
  useEffect(() => {
    if (manifestState !== "ready" || !query.trim()) {
      setSearchResults([]);
      setSearchState("idle");
      setSearchError(undefined);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setSearchState("loading");
      setSearchError(undefined);
      void searchLocal(query, controller.signal)
        .then((results) => {
          setSearchResults(results);
          setSearchState("ready");
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setSearchState("error");
          setSearchError(errorMessage(error));
        });
    }, 140);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [manifestState, query]);

  useEffect(() => {
    if (!sessionMessage) return;
    const timeout = window.setTimeout(() => setSessionMessage(undefined), 4_000);
    return () => window.clearTimeout(timeout);
  }, [sessionMessage]);

  const selectedForRegion = useMemo(
    () => [view.selectedGeneId, view.selectedTranscriptId, view.comparisonTranscriptId].filter(Boolean),
    [view.comparisonTranscriptId, view.selectedGeneId, view.selectedTranscriptId],
  );

  // Region payloads are display-tier-aware and cancellable during live panning.
  // The previous valid frame remains mounted during each local request.
  useEffect(() => {
    if (manifestState !== "ready") return;
    const controller = new AbortController();
    setRegionState("loading");
    setRegionError(undefined);
    void loadRegion(
      view.locus,
      view.displayMode,
      controller.signal,
      manifest.buildHash,
      selectedForRegion,
      view.pinnedTranscriptIds,
    )
      .then((nextRegion) => {
        setRegion(nextRegion);
        setRegionState("ready");
        lastValidLocus.current = view.locus;
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRegionState("error");
        setRegionError(errorMessage(error));
      });
    return () => controller.abort();
  }, [manifest.buildHash, manifestState, regionRetry, selectedForRegion, view.displayMode, view.locus, view.pinnedTranscriptIds]);

  const effectiveDisplayMode = semanticDisplayMode(
    view.displayMode,
    view.locus,
    view.expandedTranscriptIds.length > 0,
    region?.detail,
  );
  const effectiveExpanded = effectiveDisplayMode === "expanded" ? view.expandedTranscriptIds : [];
  const orderedTranscripts = useMemo(
    () => applyTranscriptOrder(gene.transcripts, view.transcriptOrderIds),
    [gene.transcripts, view.transcriptOrderIds],
  );
  const filteredTranscripts = useMemo(
    () => filterTranscriptsWithContext(
      orderedTranscripts,
      view.excludedTranscriptBiotypes,
      view.activeTranscriptFlags,
      view.selectedTranscriptId,
      view.pinnedTranscriptIds,
      view.comparisonTranscriptId,
    ),
    [
      orderedTranscripts,
      view.activeTranscriptFlags,
      view.excludedTranscriptBiotypes,
      view.pinnedTranscriptIds,
      view.comparisonTranscriptId,
      view.selectedTranscriptId,
    ],
  );
  const filterMatchedTranscripts = useMemo(
    () => orderedTranscripts.filter((transcript) => transcriptMatchesFilters(
      transcript,
      view.excludedTranscriptBiotypes,
      view.activeTranscriptFlags,
    )),
    [orderedTranscripts, view.activeTranscriptFlags, view.excludedTranscriptBiotypes],
  );
  const selectedTranscriptNeighborIds = useMemo(
    () => view.transcriptOrderIds.length
      ? transcriptNeighborIds(
        filteredTranscripts.map((transcript) => transcript.id),
        view.selectedTranscriptId,
      )
      : [],
    [filteredTranscripts, view.selectedTranscriptId, view.transcriptOrderIds.length],
  );
  const displayedTranscripts = useMemo(
    () => transcriptsForDisplay(
      filteredTranscripts,
      effectiveDisplayMode,
      view.selectedTranscriptId,
      view.pinnedTranscriptIds,
      transcriptRenderLimit,
      selectedTranscriptNeighborIds,
      view.comparisonTranscriptId,
      effectiveExpanded,
    ),
    [effectiveDisplayMode, effectiveExpanded, filteredTranscripts, selectedTranscriptNeighborIds, transcriptRenderLimit, view.comparisonTranscriptId, view.pinnedTranscriptIds, view.selectedTranscriptId],
  );
  const effectiveFeatureSources = useMemo(
    () => enabledFeatureSources(view.activeSources, view.activeFeatureClasses),
    [view.activeFeatureClasses, view.activeSources],
  );
  const layout = useMemo(
    () => buildRowLayout(displayedTranscripts, effectiveExpanded, effectiveFeatureSources, view.rowDensity),
    [displayedTranscripts, effectiveExpanded, effectiveFeatureSources, view.rowDensity],
  );
  useLayoutEffect(() => {
    if (!trackScrollerElement) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setTrackViewport({
        scrollTop: trackScrollerElement.scrollTop,
        height: Math.max(1, trackScrollerElement.clientHeight),
      });
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    trackScrollerElement.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(trackScrollerElement);
    return () => {
      trackScrollerElement.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [layout.totalHeight, trackScrollerElement]);
  const trackRenderWindow = useMemo(
    () => variableRowWindow(
      layout.rows,
      layout.totalHeight,
      trackViewport.scrollTop,
      trackViewport.height,
    ),
    [layout, trackViewport.height, trackViewport.scrollTop],
  );
  const windowedTranscriptIds = useMemo(
    () => layout.rows
      .slice(trackRenderWindow.firstIndex, trackRenderWindow.lastIndexExclusive)
      .map((row) => row.transcriptId),
    [layout.rows, trackRenderWindow.firstIndex, trackRenderWindow.lastIndexExclusive],
  );
  const windowedTranscriptIdSet = useMemo(() => new Set(windowedTranscriptIds), [windowedTranscriptIds]);
  const windowedTranscripts = useMemo(
    () => displayedTranscripts.filter((transcript) => windowedTranscriptIdSet.has(transcript.id)),
    [displayedTranscripts, windowedTranscriptIdSet],
  );
  const selectedTranscript = gene.transcripts.find((transcript) => transcript.id === view.selectedTranscriptId)
    ?? gene.transcripts[0];
  const comparisonTranscript = gene.transcripts.find((transcript) => transcript.id === view.comparisonTranscriptId);
  const currentGeneReference = useMemo(() => {
    if (!gene.id) return undefined;
    try {
      return createEntityReference({
        kind: "gene",
        id: gene.id,
        versionedId: gene.versionedId,
        label: gene.symbol,
        geneSymbol: gene.symbol,
      });
    } catch { return undefined; }
  }, [gene.id, gene.symbol, gene.versionedId]);
  const currentTranscriptReference = useMemo(() => {
    if (!selectedTranscript) return undefined;
    try {
      return createEntityReference({
        kind: "transcript",
        id: selectedTranscript.id,
        versionedId: selectedTranscript.versionedId,
        label: selectedTranscript.name,
        geneId: gene.id,
        geneSymbol: gene.symbol,
      });
    } catch { return undefined; }
  }, [gene.id, gene.symbol, selectedTranscript]);
  useLayoutEffect(() => {
    const request = pendingTranscriptReveal.current;
    if (!trackScrollerElement || !selectedTranscript || !request) return;
    const targetTranscriptId = request.transcriptId
      && gene.transcripts.some((transcript) => transcript.id === request.transcriptId)
      ? request.transcriptId
      : selectedTranscript.id;
    const decision = transcriptRevealDecision(
      request,
      gene.id,
      targetTranscriptId,
      layout.rows,
      trackScrollerElement.scrollTop,
      trackScrollerElement.clientHeight,
    );
    if (!decision.consume) return;
    pendingTranscriptReveal.current = null;
    if (decision.scrollTop !== undefined) trackScrollerElement.scrollTop = decision.scrollTop;
  }, [gene.id, gene.transcripts, layout.rows, selectedTranscript, trackScrollerElement]);
  const selectedFeature = gene.transcripts
    .flatMap((transcript) => transcript.features)
    .find((feature) => feature.recordId === view.selectedFeatureId);
  const windowAndContextDemandIds = useMemo(
    () => transcriptDemandIds(
      effectiveDisplayMode === "labeled" || effectiveDisplayMode === "expanded"
        ? windowedTranscriptIds
        : [],
      view.selectedTranscriptId,
      view.pinnedTranscriptIds,
      effectiveExpanded,
      view.comparisonTranscriptId,
    ),
    [effectiveDisplayMode, effectiveExpanded, view.comparisonTranscriptId, view.pinnedTranscriptIds, view.selectedTranscriptId, windowedTranscriptIds],
  );
  const detailDemandKey = windowAndContextDemandIds.join("|");
  const featureDemandKey = windowAndContextDemandIds.filter((id) => (
    effectiveExpanded.includes(id)
    || ((selectedTranscript?.id === id || comparisonTranscript?.id === id) && (
      view.inspectorTab === "feature"
      || view.inspectorTab === "table"
      || view.inspectorTab === "compare"
      || Boolean(view.selectedFeatureId)
    ))
  )).join("|");

  // Transcript structures are loaded only for rows the current LOD can render,
  // plus selected/pinned overrides. A huge gene therefore cannot trigger an
  // unbounded request fan-out before its summaries are usable.
  useEffect(() => {
    if (manifestState !== "ready" || geneState !== "ready" || !gene.id) return;
    const demanded = new Set(detailDemandKey.split("|").filter(Boolean));
    const candidates = gene.transcripts.filter(
      (transcript) => demanded.has(transcript.id) && transcript.detailState === "idle",
    );
    if (!candidates.length) return;
    const controller = new AbortController();
    detailControllers.current.add(controller);
    const ids = new Set(candidates.map((transcript) => transcript.id));
    setGene((current) => current.id !== gene.id ? current : ({
      ...current,
      transcripts: current.transcripts.map((transcript) => ids.has(transcript.id)
        ? { ...transcript, detailState: "loading" }
        : transcript),
    }));
    let cursor = 0;
    async function worker() {
      while (!controller.signal.aborted && cursor < candidates.length) {
        const summary = candidates[cursor];
        cursor += 1;
        try {
          const detailed = await loadTranscript(summary.id, controller.signal, manifest.buildHash, summary);
          setGene((current) => current.id !== gene.id ? current : ({
            ...current,
            transcripts: current.transcripts.map((transcript) => transcript.id === detailed.id
              ? { ...detailed, features: transcript.features, featuresState: transcript.featuresState }
              : transcript),
          }));
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setGene((current) => current.id !== gene.id ? current : ({
            ...current,
            transcripts: current.transcripts.map((transcript) => transcript.id === summary.id
              ? { ...transcript, detailState: "error" }
              : transcript),
          }));
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(8, candidates.length) }, () => worker()))
      .finally(() => { detailControllers.current.delete(controller); });
  }, [detailDemandKey, detailRetry, gene.id, geneState, manifest.buildHash, manifestState]);

  // Expanded protein rows fetch only their own features. Filters then operate
  // locally without refetching or altering the genomic locus.
  useEffect(() => {
    if (manifestState !== "ready" || geneState !== "ready") return;
    const demanded = new Set(featureDemandKey.split("|").filter(Boolean));
    if (!demanded.size) return;
    const candidates = gene.transcripts.filter(
      (transcript) => demanded.has(transcript.id)
        && transcript.proteinLength > 0
        && transcript.featuresState === "idle",
    );
    if (!candidates.length) return;
    const controller = new AbortController();
    featureControllers.current.add(controller);
    const ids = new Set(candidates.map((transcript) => transcript.id));
    setGene((current) => current.id !== gene.id ? current : ({
      ...current,
      transcripts: current.transcripts.map((transcript) => ids.has(transcript.id)
        ? { ...transcript, featuresState: "loading" }
        : transcript),
    }));
    let cursor = 0;
    async function worker() {
      while (!controller.signal.aborted && cursor < candidates.length) {
        const transcript = candidates[cursor];
        cursor += 1;
        try {
          const features = await loadTranscriptFeatures(transcript, manifest.featureSources, controller.signal, manifest.buildHash);
          setGene((current) => current.id !== gene.id ? current : ({
            ...current,
            transcripts: current.transcripts.map((item) => item.id === transcript.id
              ? { ...item, features, featureCount: features.length, featuresState: "ready" }
              : item),
          }));
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setGene((current) => current.id !== gene.id ? current : ({
            ...current,
            transcripts: current.transcripts.map((item) => item.id === transcript.id
              ? { ...item, featuresState: "error" }
              : item),
          }));
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(8, candidates.length) }, () => worker()))
      .finally(() => { featureControllers.current.delete(controller); });
  }, [featureDemandKey, featureRetry, gene.id, geneState, manifest.buildHash, manifest.featureSources, manifestState]);

  const resolveSearchOwnership = useCallback(async (
    result: SearchResult,
    signal: AbortSignal,
  ): Promise<{ geneId: string; transcriptId?: string }> => {
    if (result.kind === "gene") return { geneId: result.id };
    if (result.geneId) {
      return {
        geneId: result.geneId,
        transcriptId: result.transcriptId ?? (result.kind === "transcript" ? result.id : undefined),
      };
    }
    if (result.kind === "transcript") {
      const transcript = await loadTranscript(result.id, signal, manifest.buildHash);
      if (transcript.geneId) return { geneId: transcript.geneId, transcriptId: transcript.id };
    }
    const context = await loadRegion(
      fitInterval(result.chrom, result.start0, result.end0, 0.15, 2_000),
      "labeled",
      signal,
      manifest.buildHash,
    );
    const transcript = context.transcripts.find((item) =>
      [item.id, item.versionedId, item.proteinId, item.versionedProteinId]
        .filter(Boolean)
        .some((id) => normalizedSearchToken(id) === normalizedSearchToken(result.id)
          || normalizedSearchToken(id) === normalizedSearchToken(result.versionedId ?? "")),
    );
    if (transcript?.geneId) return { geneId: transcript.geneId, transcriptId: transcript.id };
    const containing = context.genes.filter((item) => item.start0 <= result.start0 && item.end0 >= result.end0);
    if (containing.length === 1) return { geneId: containing[0].id, transcriptId: result.transcriptId };
    throw new ApiError("The local result does not identify one unambiguous owning gene.", 409, "AMBIGUOUS_OWNER");
  }, [manifest.buildHash]);

  const navigateSearchResult = useCallback(async (result: SearchResult) => {
    navigationController.current?.abort();
    const controller = new AbortController();
    navigationController.current = controller;
    setSearchMessage(undefined);
    if (result.kind === "coordinate") {
      pendingDefaultProteinGeneId.current = undefined;
      commitView({
        locus: { chrom: result.chrom, start0: result.start0, end0: result.end0 },
        displayMode: "auto",
        selectedFeatureId: undefined,
      }, true);
      return;
    }
    try {
      const owner = await resolveSearchOwnership(result, controller.signal);
      const transcriptId = owner.transcriptId;
      const sameLoadedGene = owner.geneId === gene.id;
      const defaultGeneTranscriptId = !transcriptId && sameLoadedGene
        ? defaultProteinTranscriptId(gene.transcripts)
        : "";
      const nextTranscriptId = transcriptId ?? defaultGeneTranscriptId;
      pendingDefaultProteinGeneId.current = !transcriptId && !sameLoadedGene
        ? owner.geneId
        : undefined;
      const directTranscript = transcriptId
        ? fitInterval(result.chrom, result.start0, result.end0, 0.12, 500)
        : fitInterval(result.chrom, result.start0, result.end0);
      requestTranscriptReveal(owner.geneId, nextTranscriptId || undefined);
      commitView((current) => ({
        ...current,
        selectedGeneId: owner.geneId,
        selectedTranscriptId: nextTranscriptId,
        comparisonTranscriptId: owner.geneId === current.selectedGeneId
          && current.comparisonTranscriptId !== nextTranscriptId
          ? current.comparisonTranscriptId
          : "",
        transcriptOrderIds: owner.geneId === current.selectedGeneId ? current.transcriptOrderIds : [],
        locus: directTranscript,
        expandedTranscriptIds: nextTranscriptId ? [nextTranscriptId] : [],
        pinnedTranscriptIds: [],
        selectedFeatureId: undefined,
        inspectorTab: nextTranscriptId ? "transcript" : "gene",
        displayMode: "expanded",
      }), true);
      setInspectorOpen(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSearchMessage(errorMessage(error));
    }
  }, [commitView, gene.id, gene.transcripts, requestTranscriptReveal, resolveSearchOwnership]);

  function submitSearch(value: string, preferred?: SearchResult) {
    if (preferred) {
      void navigateSearchResult(preferred);
      return;
    }
    navigationController.current?.abort();
    const controller = new AbortController();
    navigationController.current = controller;
    setSearchMessage(undefined);
    setSearchState("loading");
    void searchLocal(value, controller.signal)
      .then((results) => {
        setSearchResults(results);
        setSearchState("ready");
        const resolution = resolveSubmittedSearch(value, results);
        if (resolution.kind === "navigate") void navigateSearchResult(resolution.result);
        else if (resolution.kind === "ambiguous-gene") setSearchMessage(`${resolution.count} genes use “${value.trim()}”. Choose the intended chromosome and stable ID.`);
        else if (resolution.kind === "ambiguous-exact") setSearchMessage(`${resolution.count} exact local matches are ambiguous. Choose the intended entity and stable ID.`);
        else if (resolution.kind === "none") setSearchMessage(`No exact or prefix local match for “${value}”. Check the identifier or submit a complete chromosome interval.`);
        else setSearchMessage(`Choose one of ${resolution.count} local matches to navigate without guessing.`);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSearchState("error");
        setSearchError(errorMessage(error));
        setSearchMessage(errorMessage(error));
      });
  }

  function selectTranscript(transcriptId: string) {
    if (gene.transcripts.some((transcript) => transcript.id === transcriptId && transcript.detailState === "error")) {
      setGene((current) => ({
        ...current,
        transcripts: current.transcripts.map((transcript) => transcript.id === transcriptId
          ? { ...transcript, detailState: "idle" }
          : transcript),
      }));
      setDetailRetry((value) => value + 1);
    }
    setInspectorOpen(true);
    const transcript = gene.transcripts.find((item) => item.id === transcriptId);
    if (transcript) {
      try {
        recordRecent(createEntityReference({
          kind: "transcript",
          id: transcript.id,
          versionedId: transcript.versionedId,
          label: transcript.name,
          geneId: gene.id,
          geneSymbol: gene.symbol,
        }));
      } catch {
        // API-normalized identifiers should always satisfy persistence bounds.
      }
    }
    requestTranscriptReveal(viewRef.current.selectedGeneId, transcriptId);
    commitView((current) => ({
      ...current,
      selectedTranscriptId: transcriptId,
      comparisonTranscriptId: current.comparisonTranscriptId === transcriptId ? "" : current.comparisonTranscriptId,
      inspectorTab: "transcript",
      selectedFeatureId: undefined,
    }));
    const visualPosition = filteredTranscripts.findIndex((item) => item.id === transcriptId) + 1;
    setSessionMessage(`${transcript?.name ?? transcriptId} selected${visualPosition > 0 ? `, position ${visualPosition} of ${filteredTranscripts.length} visible transcripts` : ""}.`);
  }

  function retrySelectedFeatures() {
    if (!selectedTranscript) return;
    setGene((current) => ({
      ...current,
      transcripts: current.transcripts.map((transcript) => transcript.id === selectedTranscript.id
        ? { ...transcript, featuresState: "idle" }
        : transcript),
    }));
    setFeatureRetry((value) => value + 1);
  }

  function selectFeature(feature: ProteinFeature) {
    setInspectorOpen(true);
    requestTranscriptReveal(viewRef.current.selectedGeneId, feature.transcriptId);
    commitView((current) => ({
      ...current,
      selectedTranscriptId: feature.transcriptId,
      selectedFeatureId: feature.recordId,
      inspectorTab: "feature",
      displayMode: "expanded",
      expandedTranscriptIds: nextExpansionState(
        feature.transcriptId,
        current.expandedTranscriptIds,
        true,
      ),
    }));
  }

  function toggleExpanded(transcriptId: string) {
    const current = viewRef.current;
    const visiblyExpanded = effectiveDisplayMode === "expanded"
      && current.expandedTranscriptIds.includes(transcriptId);
    if (
      !visiblyExpanded
      && !current.expandedTranscriptIds.includes(transcriptId)
      && current.expandedTranscriptIds.length >= MAX_EXPANDED_TRANSCRIPTS
    ) {
      setSessionMessage(`Up to ${MAX_EXPANDED_TRANSCRIPTS} protein-feature rows can be expanded at once. Collapse one before opening another.`);
      return;
    }
    setGene((current) => ({
      ...current,
      transcripts: current.transcripts.map((transcript) =>
        transcript.id === transcriptId && transcript.featuresState === "error"
          ? { ...transcript, featuresState: "idle" }
          : transcript),
    }));
    requestTranscriptReveal(viewRef.current.selectedGeneId, transcriptId);
    commitView((current) => ({
      ...current,
      selectedTranscriptId: transcriptId,
      selectedFeatureId: featureSelectionForTranscript(
        current.selectedFeatureId,
        selectedFeature?.transcriptId,
        transcriptId,
      ),
      displayMode: "expanded",
      expandedTranscriptIds: nextExpansionState(
        transcriptId,
        current.expandedTranscriptIds,
        !visiblyExpanded,
      ),
    }));
    const target = gene.transcripts.find((transcript) => transcript.id === transcriptId);
    setSessionMessage(`${target?.name ?? transcriptId} protein features ${visiblyExpanded ? "collapsed" : "expanded"}.`);
  }

  function togglePinned(transcriptId: string) {
    const wasPinned = viewRef.current.pinnedTranscriptIds.includes(transcriptId);
    commitView((current) => {
      const pinnedTranscriptIds = nextPinnedState(transcriptId, current.pinnedTranscriptIds);
      const expandedTranscriptIds = pinnedTranscriptIds.includes(transcriptId)
        ? nextExpansionState(transcriptId, current.expandedTranscriptIds, true)
        : current.expandedTranscriptIds;
      return { ...current, pinnedTranscriptIds, expandedTranscriptIds, displayMode: "expanded" };
    });
    const target = gene.transcripts.find((transcript) => transcript.id === transcriptId);
    setSessionMessage(`${target?.name ?? transcriptId} ${wasPinned ? "unpinned" : "pinned"}.`);
  }

  function setComparisonTranscript(transcriptId: string) {
    const current = viewRef.current;
    if (!gene.transcripts.some((transcript) => transcript.id === transcriptId)) return;
    if (transcriptId === current.selectedTranscriptId) {
      setSessionMessage("Choose a different transcript to compare with the current selection.");
      return;
    }
    const clearing = current.comparisonTranscriptId === transcriptId;
    commitView({ comparisonTranscriptId: clearing ? "" : transcriptId, inspectorTab: clearing ? current.inspectorTab : "compare" });
    setInspectorOpen(true);
    const target = gene.transcripts.find((transcript) => transcript.id === transcriptId);
    setSessionMessage(clearing
      ? "Comparison transcript cleared."
      : `${target?.name ?? transcriptId} set as the comparison transcript.`);
  }

  function swapComparison() {
    const comparisonId = viewRef.current.comparisonTranscriptId;
    const selectedId = viewRef.current.selectedTranscriptId;
    if (!comparisonId || !gene.transcripts.some((transcript) => transcript.id === comparisonId)) return;
    requestTranscriptReveal(gene.id, comparisonId);
    commitView({
      selectedTranscriptId: comparisonId,
      comparisonTranscriptId: selectedId,
      selectedFeatureId: undefined,
      inspectorTab: "compare",
    });
    setSessionMessage("Selected and comparison transcripts swapped.");
  }

  async function exportComparison(format: ComparisonExportFormat, includePinned: boolean) {
    try {
      const selection = selectComparisonExportTranscripts(orderedTranscripts, {
        selectedTranscriptId: viewRef.current.selectedTranscriptId,
        comparisonTranscriptId: viewRef.current.comparisonTranscriptId,
        pinnedTranscriptIds: viewRef.current.pinnedTranscriptIds,
        includePinned,
      });
      setSessionMessage(`Loading bounded local detail for ${selection.length} comparison transcript${selection.length === 1 ? "" : "s"}…`);
      const controller = new AbortController();
      const hydrated = [...selection];
      for (let start = 0; start < hydrated.length; start += 8) {
        const batch = hydrated.slice(start, start + 8);
        const results = await Promise.all(batch.map(async ({ transcript, ...roles }) => {
          let detailed = transcript;
          if (detailed.detailState !== "ready") {
            const loaded = await loadTranscript(detailed.id, controller.signal, manifest.buildHash, detailed);
            detailed = { ...loaded, features: detailed.features, featuresState: detailed.featuresState };
          }
          if (detailed.proteinLength > 0 && detailed.featuresState !== "ready") {
            const features = await loadTranscriptFeatures(detailed, manifest.featureSources, controller.signal, manifest.buildHash);
            detailed = { ...detailed, features, featureCount: features.length, featuresState: "ready" };
          }
          return { transcript: detailed, ...roles };
        }));
        results.forEach((result, index) => { hydrated[start + index] = result; });
      }
      const detailedById = new Map(hydrated.map((item) => [item.transcript.id, item.transcript]));
      setGene((current) => ({
        ...current,
        transcripts: current.transcripts.map((transcript) => detailedById.get(transcript.id) ?? transcript),
      }));
      const rows = buildComparisonExportRows(manifest.buildHash, gene, hydrated, localWorkspace.notes);
      const body = serializeComparisonExport(rows, format);
      const blob = new Blob([body], { type: format === "csv" ? "text/csv;charset=utf-8" : "text/tab-separated-values;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = comparisonExportFilename(gene.symbol, manifest.buildHash, format);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setSessionMessage(`${anchor.download} saved in current visual order.`);
    } catch (error) {
      const message = error instanceof ComparisonExportSelectionError ? error.message : errorMessage(error);
      setSessionMessage(`Comparison export was not created: ${message}`);
    }
  }

  function reorderTranscript(transcriptId: string, action: TranscriptOrderAction) {
    const current = viewRef.current;
    const canonicalIds = gene.transcripts.map((transcript) => transcript.id);
    const visibleIds = filteredTranscripts.map((transcript) => transcript.id);
    const visibleIndex = visibleIds.indexOf(transcriptId);
    const target = gene.transcripts.find((transcript) => transcript.id === transcriptId);
    if (!target || visibleIndex < 0) return;

    let referenceId = "";
    let placement: TranscriptOrderPlacement = "after";
    let movement = "";
    if (action === "up") {
      referenceId = visibleIds[visibleIndex - 1] ?? "";
      placement = "before";
      movement = "up one visible row";
    } else if (action === "down") {
      referenceId = visibleIds[visibleIndex + 1] ?? "";
      placement = "after";
      movement = "down one visible row";
    } else {
      referenceId = current.selectedTranscriptId;
      placement = action === "before-selected" ? "before" : "after";
      movement = `${placement === "before" ? "directly above" : "directly below"} selected ${selectedTranscript?.name ?? referenceId}`;
    }
    if (!referenceId || referenceId === transcriptId) return;

    const transcriptOrderIds = moveTranscriptRelative(
      canonicalIds,
      current.transcriptOrderIds,
      transcriptId,
      referenceId,
      placement,
    );
    if (
      transcriptOrderIds.length === current.transcriptOrderIds.length
      && transcriptOrderIds.every((id, index) => id === current.transcriptOrderIds[index])
    ) return;

    const nextVisible = filterTranscriptsWithContext(
      applyTranscriptOrder(gene.transcripts, transcriptOrderIds),
      current.excludedTranscriptBiotypes,
      current.activeTranscriptFlags,
      current.selectedTranscriptId,
      current.pinnedTranscriptIds,
      current.comparisonTranscriptId,
    );
    const nextPosition = nextVisible.findIndex((transcript) => transcript.id === transcriptId) + 1;
    commitView({ transcriptOrderIds });
    setReorderFocusTranscriptId(transcriptId);
    setSessionMessage(
      `${target.name} moved ${movement}, position ${nextPosition} of ${nextVisible.length} visible transcripts.`,
    );
  }

  function resetTranscriptOrder() {
    if (!viewRef.current.transcriptOrderIds.length) return;
    commitView({ transcriptOrderIds: [] });
    setReorderFocusTranscriptId(viewRef.current.selectedTranscriptId);
    setSessionMessage(`Original transcript order restored for ${gene.symbol}.`);
  }

  function toggleSource(source: FeatureSource) {
    commitView((current) => ({
      ...current,
      activeSources: current.activeSources.includes(source)
        ? current.activeSources.filter((item) => item !== source)
        : [...current.activeSources, source],
      selectedFeatureId: selectedFeature?.source === source && current.activeSources.includes(source)
        ? undefined
        : current.selectedFeatureId,
    }));
  }

  function toggleFeatureClass(featureClass: FeatureClass) {
    commitView((current) => {
      const activeFeatureClasses = current.activeFeatureClasses.includes(featureClass)
        ? current.activeFeatureClasses.filter((item) => item !== featureClass)
        : [...current.activeFeatureClasses, featureClass];
      const nextVisibleSources = enabledFeatureSources(current.activeSources, activeFeatureClasses);
      return {
        ...current,
        activeFeatureClasses,
        selectedFeatureId: selectedFeature && !nextVisibleSources.includes(selectedFeature.source)
          ? undefined
          : current.selectedFeatureId,
      };
    });
  }

  function toggleTranscriptBiotype(biotype: string) {
    commitView((current) => ({
      ...current,
      excludedTranscriptBiotypes: current.excludedTranscriptBiotypes.includes(biotype)
        ? current.excludedTranscriptBiotypes.filter((item) => item !== biotype)
        : [...current.excludedTranscriptBiotypes, biotype],
    }));
  }

  function toggleTranscriptFlag(flag: TranscriptFlag) {
    commitView((current) => ({
      ...current,
      activeTranscriptFlags: current.activeTranscriptFlags.includes(flag)
        ? current.activeTranscriptFlags.filter((item) => item !== flag)
        : [...current.activeTranscriptFlags, flag],
    }));
  }

  function setLocus(locus: Locus, push = false) {
    commitView({ locus }, push);
  }

  function selectRegionGene(geneId: string) {
    const regionGene = region?.genes.find((item) => item.id === geneId);
    if (!regionGene) return;
    const sameLoadedGene = regionGene.id === gene.id;
    const nextTranscriptId = sameLoadedGene ? defaultProteinTranscriptId(gene.transcripts) : "";
    const nextTranscript = gene.transcripts.find((transcript) => transcript.id === nextTranscriptId);
    pendingDefaultProteinGeneId.current = sameLoadedGene ? undefined : regionGene.id;
    setQuery(regionGene.symbol);
    requestTranscriptReveal(regionGene.id, nextTranscriptId || undefined);
    commitView((current) => ({
      ...current,
      selectedGeneId: regionGene.id,
      selectedTranscriptId: nextTranscriptId,
      comparisonTranscriptId: "",
      transcriptOrderIds: regionGene.id === current.selectedGeneId ? current.transcriptOrderIds : [],
      expandedTranscriptIds: nextTranscript?.proteinLength ? [nextTranscript.id] : [],
      pinnedTranscriptIds: [],
      selectedFeatureId: undefined,
      inspectorTab: nextTranscriptId ? "transcript" : "gene",
      locus: fitInterval(regionGene.chrom, regionGene.start0, regionGene.end0),
      displayMode: "expanded",
    }), true);
  }

  const selectedTranscriptOffscreen = Boolean(selectedTranscript && !intervalOverlapsLocus(
    gene.chrom,
    selectedTranscript.start0,
    selectedTranscript.end0,
    view.locus,
  ));
  const selectedGeneOffscreen = Boolean(gene.id && !intervalOverlapsLocus(
    gene.chrom,
    gene.start0,
    gene.end0,
    view.locus,
  ));
  const omittedTranscriptCount = Math.max(0, filteredTranscripts.length - displayedTranscripts.length);
  const workspaceReady = manifestState === "ready" && Boolean(gene.id);

  async function saveQuickPdf() {
    if (quickPdfBusy) return;
    const preset = localWorkspace.lastPdfPreset;
    if (!preset) {
      setPdfOpen(true);
      setSessionMessage("Choose a bounded PDF scope once; Quick PDF will reuse the last successful preset.");
      return;
    }
    const resolution = resolveQuickPdfPreset(preset, {
      buildHash: manifest.buildHash,
      gene,
      visuallyOrderedTranscripts: orderedTranscripts,
      selectedTranscriptId: view.selectedTranscriptId,
      comparisonTranscriptId: view.comparisonTranscriptId,
      pinnedTranscriptIds: view.pinnedTranscriptIds,
      locus: view.locus,
    });
    if (!resolution.valid) {
      setPdfOpen(true);
      setSessionMessage(`${resolution.reason} Review the safe PDF dialog before saving.`);
      return;
    }
    const controller = new AbortController();
    setQuickPdfBusy(true);
    setSessionMessage(`Building Quick PDF for ${resolution.transcriptIds.length} transcript${resolution.transcriptIds.length === 1 ? "" : "s"}…`);
    try {
      const download = await createTranscriptPdf(resolution.request, controller.signal);
      const url = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = download.filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setSessionMessage(`${download.filename} saved with the validated Quick PDF preset.`);
    } catch (error) {
      setSessionMessage(`Quick PDF failed: ${errorMessage(error)}`);
    } finally {
      setQuickPdfBusy(false);
    }
  }

  useEffect(() => {
    if (!workspaceReady) return;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      const command = browserKeyboardCommand({
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        targetTag: target?.tagName,
        targetRole: target?.getAttribute("role") ?? undefined,
        contentEditable: target?.isContentEditable,
        blockedContext: Boolean(target?.closest(".transcript-order-menu, [role=dialog]")),
        modalOpen: helpOpen || pdfOpen || aboutOpen,
      });
      if (!command) return;
      if (command === "focus-search") {
        const input = document.getElementById("global-search-input") as HTMLInputElement | null;
        if (!input) return;
        event.preventDefault();
        input.focus();
        input.select();
        return;
      }
      if (command === "next-transcript" || command === "previous-transcript") {
        const index = filterMatchedTranscripts.findIndex((transcript) => transcript.id === viewRef.current.selectedTranscriptId);
        const offset = command === "next-transcript" ? 1 : -1;
        const next = index < 0
          ? (command === "next-transcript" ? filterMatchedTranscripts[0] : filterMatchedTranscripts.at(-1))
          : filterMatchedTranscripts[index + offset];
        if (!next) {
          setSessionMessage(command === "next-transcript" ? "Already at the last filter-matched transcript." : "Already at the first filter-matched transcript.");
          return;
        }
        event.preventDefault();
        selectTranscript(next.id);
        return;
      }
      if (command === "toggle-pin" && selectedTranscript) {
        event.preventDefault();
        togglePinned(selectedTranscript.id);
        return;
      }
      if (command === "focus-comparison") {
        event.preventDefault();
        setInspectorOpen(true);
        commitView({ inspectorTab: "compare" });
        setSessionMessage(comparisonTranscript ? `Comparing ${selectedTranscript?.name} with ${comparisonTranscript.name}.` : "Comparison mode opened. Choose a comparison transcript from a row or the navigator.");
        return;
      }
      if (command === "set-comparison" && selectedTranscript) {
        const current = viewRef.current;
        const existing = gene.transcripts.find((transcript) => transcript.id === current.comparisonTranscriptId);
        const replacementSelected = existing
          ?? filteredTranscripts.find((transcript) => transcript.id !== selectedTranscript.id);
        if (!replacementSelected) {
          setSessionMessage("A second transcript is required for comparison.");
          return;
        }
        event.preventDefault();
        requestTranscriptReveal(gene.id, replacementSelected.id);
        commitView({
          selectedTranscriptId: replacementSelected.id,
          comparisonTranscriptId: selectedTranscript.id,
          selectedFeatureId: undefined,
          inspectorTab: "compare",
        });
        setInspectorOpen(true);
        setSessionMessage(`${selectedTranscript.name} set as comparison; ${replacementSelected.name} is now selected.`);
        return;
      }
      if (!trackScrollerElement || layout.totalHeight <= trackScrollerElement.clientHeight) return;
      let nextScrollTop = trackScrollerElement.scrollTop;
      if (command === "page-up") nextScrollTop -= trackScrollerElement.clientHeight;
      else if (command === "page-down") nextScrollTop += trackScrollerElement.clientHeight;
      else if (command === "home") nextScrollTop = 0;
      else if (command === "end") nextScrollTop = layout.totalHeight;
      else return;
      event.preventDefault();
      trackScrollerElement.scrollTop = Math.max(0, Math.min(layout.totalHeight - trackScrollerElement.clientHeight, nextScrollTop));
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [aboutOpen, commitView, comparisonTranscript, filterMatchedTranscripts, filteredTranscripts, gene.id, gene.transcripts, helpOpen, layout.totalHeight, pdfOpen, requestTranscriptReveal, selectedTranscript, trackScrollerElement, workspaceReady]);

  return (
    <div className="app-shell">
      <ReleaseDiagnostics enabled={geneState === "ready"} />
      <CommandBar
        manifest={manifest}
        manifestState={manifestState}
        query={query}
        locus={view.locus}
        displayMode={view.displayMode}
        effectiveDisplayMode={effectiveDisplayMode}
        inspectorOpen={inspectorOpen}
        searchResults={searchResults}
        searchState={searchState}
        searchError={searchError}
        canFitTranscript={Boolean(selectedTranscript?.id)}
        onQueryChange={(value) => {
          navigationController.current?.abort();
          setQuery(value);
          setSearchMessage(undefined);
          setSearchState(value.trim() ? "loading" : "idle");
        }}
        onSubmit={submitSearch}
        onFitGene={() => commitView({ locus: fitInterval(gene.chrom, gene.start0, gene.end0) }, true)}
        onFitTranscript={() => {
          if (selectedTranscript) commitView({ locus: fitInterval(gene.chrom, selectedTranscript.start0, selectedTranscript.end0, 0.12, 500) }, true);
        }}
        onZoom={(scale) => commitView({ locus: zoomLocus(view.locus, scale) })}
        onDisplayModeChange={(displayMode: DisplayModeSetting) => commitView((current) => ({
          ...current,
          displayMode,
          expandedTranscriptIds: displayMode === "expanded" && selectedTranscript?.proteinLength
            ? nextExpansionState(selectedTranscript.id, current.expandedTranscriptIds, true)
            : current.expandedTranscriptIds,
        }))}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
        onToggleHelp={() => setHelpOpen(true)}
        workspaceMenu={(
          <WorkspaceEntityMenu
            recents={localWorkspace.recents}
            favorites={localWorkspace.favorites}
            currentGene={currentGeneReference}
            currentTranscript={currentTranscriptReference}
            onNavigateEntity={(reference) => {
              const token = reference.versionedId ?? reference.id;
              setQuery(token);
              submitSearch(token);
            }}
            onToggleFavorite={toggleFavorite}
          />
        )}
      />
      {workspaceReady && (
        <FilterBar
          gene={gene}
          manifest={manifest}
          activeSources={view.activeSources}
          activeFeatureClasses={view.activeFeatureClasses}
          excludedTranscriptBiotypes={view.excludedTranscriptBiotypes}
          activeTranscriptFlags={view.activeTranscriptFlags}
          selectedTranscriptId={view.selectedTranscriptId}
          comparisonTranscriptId={view.comparisonTranscriptId}
          pinnedTranscriptIds={view.pinnedTranscriptIds}
          visibleTranscriptCount={filteredTranscripts.length}
          transcriptOrderActive={view.transcriptOrderIds.length > 0}
          rowDensity={view.rowDensity}
          canvasKeyboardShortcuts={view.canvasKeyboardShortcuts}
          restoreLastView={localWorkspace.restoreLastView}
          onToggleSource={toggleSource}
          onToggleFeatureClass={toggleFeatureClass}
          onToggleTranscriptBiotype={toggleTranscriptBiotype}
          onToggleTranscriptFlag={toggleTranscriptFlag}
          onResetTranscriptOrder={resetTranscriptOrder}
          onRowDensityChange={(rowDensity: RowDensity) => commitView({ rowDensity })}
          onCanvasKeyboardShortcutsChange={(canvasKeyboardShortcuts) => commitView({ canvasKeyboardShortcuts })}
          onRestoreLastViewChange={(restoreLastView) => {
            setLocalWorkspace((current) => ({ ...current, restoreLastView }));
            setSessionMessage(`Automatic last-view restoration ${restoreLastView ? "enabled" : "disabled"}.`);
          }}
          onClearSavedWorkspace={() => {
            skipNextWorkspaceSave.current = true;
            try { clearWorkspaceState(window.localStorage); } catch { /* Browser storage may be unavailable. */ }
            setLocalWorkspace(createEmptyWorkspaceState(manifest.buildHash));
            setSessionMessage("Saved recents, favorites, notes, PDF preset, and last view were cleared for this build.");
          }}
        />
      )}

      {startupError && (
        <div className="startup-failure" role="alert">
          <div><strong>Local annotation service is unavailable</strong><span>{startupError}</span><small>Start this project with <code>./run_local.sh</code>. The browser will not substitute network data.</small></div>
          <button type="button" onClick={() => window.location.reload()}>Retry startup</button>
        </div>
      )}
      {buildMismatch && (
        <div className="build-mismatch" role="alert">
          <div><strong>Saved view belongs to a different annotation build.</strong><span>Requested {buildMismatch.requested}; current build is {buildMismatch.current}. The stale gene, locus, transcript order, expansion, filters, and selection were cleared.</span></div>
          <button type="button" onClick={() => setBuildMismatch(undefined)}>Use current build</button>
        </div>
      )}
      {searchMessage && <div className="search-message" role="status">{searchMessage}</div>}
      {sessionMessage && <div className="session-message" role="status">{sessionMessage}</div>}
      {geneState === "error" && (
        <div className="track-error" role="alert"><span><strong>Selected gene could not be loaded.</strong> {geneError}</span><button type="button" onClick={() => setGeneRetry((value) => value + 1)}>Retry gene</button></div>
      )}
      {regionState === "error" && (
        <div className="track-error" role="alert"><span><strong>That interval could not be loaded.</strong> {regionError}</span><button type="button" onClick={() => { commitView({ locus: lastValidLocus.current }); setRegionRetry((value) => value + 1); }}>Return to last valid interval</button></div>
      )}
      {selectedTranscript && selectedTranscriptOffscreen && view.pinnedTranscriptIds.includes(selectedTranscript.id) && (
        <div className="offscreen-notice" role="status"><span><strong>{selectedTranscript.name}</strong> is pinned outside the current genomic view.</span><button type="button" onClick={() => commitView({ locus: fitInterval(gene.chrom, selectedTranscript.start0, selectedTranscript.end0, 0.12, 500) }, true)}>Return to transcript</button></div>
      )}
      {selectedGeneOffscreen && !view.pinnedTranscriptIds.includes(selectedTranscript?.id ?? "") && (
        <div className="offscreen-notice" role="status"><span>The selected gene <strong>{gene.symbol}</strong> is outside the current interval; its context remains available.</span><button type="button" onClick={() => commitView({ locus: fitInterval(gene.chrom, gene.start0, gene.end0) }, true)}>Return to gene</button></div>
      )}
      {regionState === "ready" && region?.emptyState && (
        <div className="empty-region" role="status"><strong>No annotated gene in this interval</strong><span>{region.emptyState}. Pan, zoom out, or search a local identifier. The selected gene context is retained.</span></div>
      )}
      {region?.truncated && (
        <div className="bounded-notice" role="status">This dense interval reached the bounded regional response limit. Zoom in to inspect individual models.</div>
      )}
      {regionState === "loading" && <div className="local-progress" role="status"><span />Loading visible interval…</div>}

      <main className={`browser-body ${workspaceReady && inspectorOpen ? "with-inspector" : ""}`}>
        {workspaceReady ? <>
          <section className="browser-workspace" aria-label={`${gene.symbol} genomic workspace`}>
          {geneState === "loading" && <div className="gene-loading" role="status">Loading {view.selectedGeneId} transcript structures…</div>}
          {omittedTranscriptCount > 0 && effectiveDisplayMode !== "overview" && (
            <div className="render-limit-notice" role="status">
              <span>Showing {displayedTranscripts.length} of {filteredTranscripts.length} filter-matched/context transcripts to keep the Canvas bounded. Selected, comparison, pinned, and expanded transcripts are retained.</span>
              {transcriptRenderLimit < MAX_TRANSCRIPT_RENDER_LIMIT && <button type="button" onClick={() => setTranscriptRenderLimit((value) => Math.min(MAX_TRANSCRIPT_RENDER_LIMIT, value + 40))}>Show more</button>}
            </div>
          )}
          <TranscriptNavigator
            transcripts={filteredTranscripts}
            selectedTranscriptId={view.selectedTranscriptId}
            query={navigatorQuery}
            onQueryChange={setNavigatorQuery}
            onSelectTranscript={selectTranscript}
            comparisonTranscriptId={view.comparisonTranscriptId}
            onSetComparison={setComparisonTranscript}
            ariaLabel={`${gene.symbol} current-gene transcript navigator`}
          />
          <div className="track-stage">
          <div className="track-scroller" id="transcript-track-scroller" ref={setTrackScrollerElement}>
            <div className="track-grid">
              <TranscriptLabels
                gene={gene}
                transcripts={windowedTranscripts}
                layout={layout}
                displayMode={effectiveDisplayMode}
                selectedTranscriptId={selectedTranscript?.id ?? ""}
                comparisonTranscriptId={view.comparisonTranscriptId}
                selectedTranscriptName={selectedTranscript?.name ?? "selected transcript"}
                expandedTranscriptIds={effectiveExpanded}
                pinnedTranscriptIds={view.pinnedTranscriptIds}
                reorderableTranscriptIds={filteredTranscripts.map((transcript) => transcript.id)}
                customOrderActive={view.transcriptOrderIds.length > 0}
                reorderFocusTranscriptId={reorderFocusTranscriptId}
                activeSources={effectiveFeatureSources}
                rowDensity={view.rowDensity}
                locus={view.locus}
                onSelectTranscript={selectTranscript}
                onToggleExpanded={toggleExpanded}
                onTogglePinned={togglePinned}
                onSetComparison={setComparisonTranscript}
                onReorderTranscript={reorderTranscript}
                onReorderFocusHandled={(transcriptId) => setReorderFocusTranscriptId((current) => (
                  current === transcriptId ? undefined : current
                ))}
              />
              <GenomeCanvas
                gene={gene}
                transcripts={displayedTranscripts}
                layout={layout}
                renderWindow={trackRenderWindow}
                locus={view.locus}
                displayMode={effectiveDisplayMode}
                activeSources={effectiveFeatureSources}
                keyboardShortcutsEnabled={view.canvasKeyboardShortcuts}
                selectedTranscriptId={selectedTranscript?.id ?? ""}
                selectedFeatureId={view.selectedFeatureId}
                region={region}
                onSelectGene={selectRegionGene}
                onSelectTranscript={selectTranscript}
                onSelectFeature={selectFeature}
                onLocusChange={setLocus}
              />
            </div>
          </div>
          <TranscriptMinimap
            layout={layout}
            viewport={trackViewport}
            selectedTranscriptId={view.selectedTranscriptId}
            comparisonTranscriptIds={view.comparisonTranscriptId ? [view.comparisonTranscriptId] : []}
            pinnedTranscriptIds={view.pinnedTranscriptIds}
            controlsId="transcript-track-scroller"
            onNavigate={(scrollTop) => { if (trackScrollerElement) trackScrollerElement.scrollTop = scrollTop; }}
            ariaLabel={`${gene.symbol} transcript viewport minimap`}
          />
          </div>
          </section>

          {inspectorOpen && selectedTranscript && (
            <Inspector
            gene={gene}
            transcript={selectedTranscript}
            buildHash={manifest.buildHash}
            selectedFeature={selectedFeature}
            activeSources={effectiveFeatureSources}
            tab={view.inspectorTab}
            onTabChange={(inspectorTab: InspectorTab) => commitView({ inspectorTab })}
            onSelectFeature={selectFeature}
            onRetryFeatures={retrySelectedFeatures}
            onClose={() => setInspectorOpen(false)}
            userAnnotations={localWorkspace.notes}
            onSaveUserAnnotation={(key: EntityKey, annotation: UserAnnotation) => {
              try {
                const notes = setUserAnnotation(localWorkspace.notes, key, annotation);
                setLocalWorkspace((current) => ({ ...current, notes }));
                setSessionMessage("Local user annotation saved for this immutable build.");
              } catch (error) {
                setSessionMessage(`Local annotation was not saved: ${errorMessage(error)}`);
                throw error;
              }
            }}
            onDeleteUserAnnotation={(key: EntityKey) => {
              setLocalWorkspace((current) => ({
                ...current,
                notes: removeUserAnnotation(current.notes, key),
              }));
              setSessionMessage("Local user annotation deleted.");
            }}
            comparisonPanel={(
              <ComparisonPanel
                selectedTranscript={selectedTranscript}
                comparisonTranscript={comparisonTranscript}
                activeSources={manifest.featureSources}
                comparisonPinned={Boolean(comparisonTranscript && view.pinnedTranscriptIds.includes(comparisonTranscript.id))}
                pinnedTranscriptCount={view.pinnedTranscriptIds.length}
                onSetComparison={() => {
                  const input = document.querySelector<HTMLInputElement>(".transcript-navigator input");
                  input?.focus();
                  setSessionMessage("Use the current-gene navigator or a row compare button to choose a different transcript.");
                }}
                onSwap={swapComparison}
                onClearComparison={() => {
                  commitView({ comparisonTranscriptId: "", inspectorTab: "transcript" });
                  setSessionMessage("Comparison transcript cleared.");
                }}
                onToggleComparisonPin={() => { if (comparisonTranscript) togglePinned(comparisonTranscript.id); }}
                onPlaceComparison={(placement) => {
                  if (comparisonTranscript) reorderTranscript(comparisonTranscript.id, placement === "before" ? "before-selected" : "after-selected");
                }}
                onExportComparison={(format, includePinned) => void exportComparison(format, includePinned)}
              />
            )}
            />
          )}
        </> : (
          <section className="startup-workspace" role="status" aria-live="polite">
            <span aria-hidden="true">TB</span>
            <div>
              <strong>{manifestState === "loading" ? "Verifying the immutable local build…" : geneState === "loading" ? `Loading ${view.selectedGeneId}…` : "No verified local annotation is loaded"}</strong>
              <p>{manifestState === "error" ? "The genomic workspace remains closed until the manifest and schema checks pass." : "Transcript models will appear after local validation; no fixture or network substitute is rendered."}</p>
            </div>
          </section>
        )}
      </main>

      <footer className="status-bar">
        <span><i className={`status-dot ${manifest.dataSource}`} aria-hidden="true" />{manifestState === "ready" ? `${manifest.technicalPreview ? "Technical preview" : "Immutable local build"} connected` : "Checking local build"}</span>
        <span>{formatLocus(view.locus)} · {view.displayMode === "auto" ? `auto → ${effectiveDisplayMode}` : effectiveDisplayMode}</span>
        <span>{selectedTranscript?.versionedId || "No transcript loaded"} · {effectiveFeatureSources.length} visible sources · {view.rowDensity}</span>
        {workspaceReady && <SessionActions
          manifest={manifest}
          view={view}
          annotations={localWorkspace.notes}
          fallback={{ ...DEFAULT_VIEW_STATE, buildHash: manifest.buildHash }}
          onSavePdf={() => {
            setHelpOpen(false);
            setPdfOpen(true);
          }}
          onQuickPdf={() => void saveQuickPdf()}
          quickPdfBusy={quickPdfBusy}
          onRestore={(restored, annotations) => {
            setBuildMismatch(undefined);
            viewRef.current = restored;
            setView(restored);
            writeHistory(restored, true);
            if (Object.keys(annotations).length) {
              const merged = mergeImportedAnnotations(localWorkspace.notes, annotations);
              setLocalWorkspace((current) => ({ ...current, notes: merged.notes }));
              return `Session restored; local annotations added ${merged.added.length}, replaced older ${merged.replaced.length}, preserved newer local ${merged.preservedLocal.length}.`;
            }
            return "Session restored; imported annotations were not merged.";
          }}
          onMessage={setSessionMessage}
        />}
        <button type="button" className="keyboard-help" onClick={() => setHelpOpen(true)}>Keyboard &amp; gestures</button>
        <button type="button" className="keyboard-help" onClick={() => setAboutOpen(true)}>About &amp; diagnostics</button>
      </footer>
      <HelpOverlay open={helpOpen} onClose={closeHelp} />
      <AboutDiagnosticsDialog open={aboutOpen} manifest={manifest} gene={workspaceReady ? gene : undefined} transcript={selectedTranscript} onClose={() => setAboutOpen(false)} onMessage={setSessionMessage} />
      <PdfExportDialog
        open={pdfOpen && workspaceReady}
        gene={gene}
        transcripts={filteredTranscripts}
        selectedTranscriptId={view.selectedTranscriptId}
        comparisonTranscriptId={view.comparisonTranscriptId}
        pinnedTranscriptIds={view.pinnedTranscriptIds}
        activeSources={effectiveFeatureSources}
        locus={view.locus}
        buildHash={manifest.buildHash}
        onClose={closePdf}
        onMessage={setSessionMessage}
        onPresetSaved={(preset) => setLocalWorkspace((current) => withLastPdfPreset(current, preset))}
      />
    </div>
  );
}
