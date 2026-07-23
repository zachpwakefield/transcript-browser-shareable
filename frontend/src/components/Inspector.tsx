import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { loadTranscriptSequence, type SequenceKind } from "../api";
import { formatLocus } from "../lib/coordinates";
import { buildSequenceLineRange, sequenceDecorations } from "../lib/sequence";
import { fixedRowWindow } from "../lib/windowing";
import { LocalAnnotationsEditor } from "./LocalAnnotationsEditor";
import {
  makeEntityKey,
  type EntityKey,
  type UserAnnotation,
} from "../lib/workspaceStore";
import {
  SOURCE_META,
  type FeatureSource,
  type Gene,
  type InspectorTab,
  type ProteinFeature,
  type Transcript,
} from "../types";

const TABS: { id: InspectorTab; label: string }[] = [
  { id: "gene", label: "Gene" },
  { id: "transcript", label: "Transcript" },
  { id: "compare", label: "Compare" },
  { id: "feature", label: "Feature" },
  { id: "sequence", label: "Sequence" },
  { id: "table", label: "Table" },
];

const SEQUENCE_LINE_LENGTH = 60;
const SEQUENCE_ROW_HEIGHT = 22;
const FEATURE_ROW_HEIGHT = 44;

function useScrollViewport(resetKey: string, fallbackHeight: number) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: fallbackHeight });

  useLayoutEffect(() => {
    if (!element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setViewport({ scrollTop: element.scrollTop, height: Math.max(1, element.clientHeight) });
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    element.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [element]);

  useLayoutEffect(() => {
    if (!element) return;
    element.scrollTop = 0;
    setViewport({ scrollTop: 0, height: Math.max(1, element.clientHeight) });
  }, [element, resetKey]);

  return { element, setElement, ...viewport };
}

interface InspectorProps {
  gene: Gene;
  transcript: Transcript;
  buildHash: string;
  selectedFeature?: ProteinFeature;
  activeSources: FeatureSource[];
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onSelectFeature: (feature: ProteinFeature) => void;
  onRetryFeatures: () => void;
  onClose: () => void;
  comparisonPanel?: ReactNode;
  userAnnotations: Partial<Record<EntityKey, UserAnnotation>>;
  onSaveUserAnnotation: (key: EntityKey, annotation: UserAnnotation) => void;
  onDeleteUserAnnotation: (key: EntityKey) => void;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      aria-label={`Copy ${label}`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function InspectorAnnotationEditor({
  entityKey,
  entityLabel,
  annotation,
  onSave,
  onDelete,
}: {
  entityKey: EntityKey;
  entityLabel: string;
  annotation?: UserAnnotation;
  onSave: (key: EntityKey, annotation: UserAnnotation) => void;
  onDelete: (key: EntityKey) => void;
}) {
  const [note, setNote] = useState(annotation?.note ?? "");
  const [tags, setTags] = useState<string[]>(annotation?.tags ?? []);
  useEffect(() => {
    setNote(annotation?.note ?? "");
    setTags(annotation?.tags ?? []);
  }, [annotation?.updatedAt, entityKey]);
  return (
    <LocalAnnotationsEditor
      entityKey={entityKey}
      entityLabel={entityLabel}
      note={note}
      tags={tags}
      hasSavedAnnotation={Boolean(annotation)}
      updatedAt={annotation?.updatedAt}
      onNoteChange={setNote}
      onTagsChange={setTags}
      onSave={onSave}
      onDelete={(key) => {
        onDelete(key);
        setNote("");
        setTags([]);
      }}
    />
  );
}

export function Inspector({
  gene,
  transcript,
  buildHash,
  selectedFeature,
  activeSources,
  tab,
  onTabChange,
  onSelectFeature,
  onRetryFeatures,
  onClose,
  comparisonPanel,
  userAnnotations,
  onSaveUserAnnotation,
  onDeleteUserAnnotation,
}: InspectorProps) {
  const [sequenceKind, setSequenceKind] = useState<SequenceKind>("protein");
  const [sequenceRetry, setSequenceRetry] = useState(0);
  const [tableQuery, setTableQuery] = useState("");
  const [sequenceState, setSequenceState] = useState<{
    status: "idle" | "loading" | "ready" | "missing" | "error";
    sequence?: string;
  }>({ status: "idle" });
  const sequenceViewport = useScrollViewport(
    `${transcript.id}:${sequenceKind}:${sequenceState.sequence?.length ?? 0}`,
    360,
  );
  const tableViewport = useScrollViewport(`${transcript.id}:${tableQuery}`, 520);
  const geneAnnotationKey = makeEntityKey("gene", gene.id);
  const transcriptAnnotationKey = makeEntityKey("transcript", transcript.id);
  const visibleFeatures = useMemo(
    () => transcript.features.filter((feature) => activeSources.includes(feature.source)),
    [activeSources, transcript.features],
  );
  const splitCodonBoundaries = useMemo(
    () => transcript.exons.filter((exon) => exon.phase === 1 || exon.phase === 2),
    [transcript.exons],
  );
  const selectedFeatureCdsBounds = useMemo(() => {
    if (!selectedFeature) return undefined;
    const starts = selectedFeature.segments.flatMap((segment) => segment.ntStart0 === undefined ? [] : [segment.ntStart0]);
    const ends = selectedFeature.segments.flatMap((segment) => segment.ntEnd0 === undefined ? [] : [segment.ntEnd0]);
    return starts.length && ends.length
      ? { start1: Math.min(...starts) + 1, end1: Math.max(...ends) }
      : undefined;
  }, [selectedFeature]);
  const filteredFeatures = useMemo(() => {
    const normalized = tableQuery.trim().toLowerCase();
    if (!normalized) return visibleFeatures;
    return visibleFeatures.filter((feature) =>
      `${SOURCE_META[feature.source].label} ${feature.featureId} ${feature.name} ${feature.method}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [tableQuery, visibleFeatures]);
  const decorations = useMemo(
    () => sequenceDecorations(transcript, sequenceKind, selectedFeature),
    [selectedFeature, sequenceKind, transcript],
  );
  const sequenceLineCount = sequenceState.sequence
    ? Math.ceil(sequenceState.sequence.length / SEQUENCE_LINE_LENGTH)
    : 0;
  const sequenceWindow = useMemo(
    () => fixedRowWindow(
      sequenceLineCount,
      sequenceViewport.scrollTop,
      sequenceViewport.height,
      SEQUENCE_ROW_HEIGHT,
    ),
    [sequenceLineCount, sequenceViewport.height, sequenceViewport.scrollTop],
  );
  const sequenceLines = useMemo(() => sequenceState.sequence
    ? buildSequenceLineRange(
        sequenceState.sequence,
        decorations,
        sequenceWindow.firstIndex,
        sequenceWindow.lastIndexExclusive,
        SEQUENCE_LINE_LENGTH,
      )
    : [], [decorations, sequenceState.sequence, sequenceWindow.firstIndex, sequenceWindow.lastIndexExclusive]);
  const tableWindow = useMemo(
    () => fixedRowWindow(
      filteredFeatures.length,
      tableViewport.scrollTop,
      tableViewport.height,
      FEATURE_ROW_HEIGHT,
    ),
    [filteredFeatures.length, tableViewport.height, tableViewport.scrollTop],
  );
  const windowedFeatures = useMemo(
    () => filteredFeatures.slice(tableWindow.firstIndex, tableWindow.lastIndexExclusive),
    [filteredFeatures, tableWindow.firstIndex, tableWindow.lastIndexExclusive],
  );
  useEffect(() => {
    if (transcript.proteinLength <= 0 && sequenceKind === "protein") setSequenceKind("transcript_full");
  }, [sequenceKind, transcript.id, transcript.proteinLength]);
  useEffect(() => setTableQuery(""), [transcript.id]);
  useLayoutEffect(() => {
    if (tab !== "table" || !tableViewport.element || !selectedFeature) return;
    const index = filteredFeatures.findIndex((feature) => feature.recordId === selectedFeature.recordId);
    if (index < 0) return;
    const top = index * FEATURE_ROW_HEIGHT;
    const bottom = top + FEATURE_ROW_HEIGHT;
    const visibleTop = tableViewport.element.scrollTop;
    const visibleBottom = visibleTop + tableViewport.element.clientHeight;
    if (top < visibleTop || bottom > visibleBottom) tableViewport.element.scrollTop = top;
  }, [filteredFeatures, selectedFeature, tab, tableViewport.element]);
  useEffect(() => {
    if (tab !== "sequence") return;
    const controller = new AbortController();
    setSequenceState({ status: "loading" });
    void loadTranscriptSequence(transcript.id, sequenceKind, controller.signal, buildHash)
      .then((sequence) => setSequenceState(sequence ? { status: "ready", sequence } : { status: "missing" }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setSequenceState({ status: "error" });
      });
    return () => controller.abort();
  }, [buildHash, sequenceKind, sequenceRetry, tab, transcript.id]);
  return (
    <aside className="inspector" aria-label="Selection inspector">
      <header className="inspector-header">
        <div>
          <span className="eyebrow">Selection</span>
          <h2>{selectedFeature?.name ?? transcript.name}</h2>
          <p>{selectedFeature ? `${SOURCE_META[selectedFeature.source].label} · ${selectedFeature.featureId}` : transcript.versionedId}</p>
        </div>
        <button type="button" className="close-inspector" onClick={onClose} aria-label="Close inspector">×</button>
      </header>
      <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
        {TABS.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            key={item.id}
            onClick={() => onTabChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="inspector-content" role="tabpanel">
        {tab === "gene" && (
          <section>
            <div className="entity-heading">
              <span className="entity-monogram">{gene.symbol}</span>
              <div><h3>{gene.name}</h3><p>{gene.versionedId}</p></div>
            </div>
            <dl className="fact-grid">
              <Fact label="Locus" value={formatLocus({ chrom: gene.chrom, start0: gene.start0, end0: gene.end0 })} />
              <Fact label="Strand" value={`${gene.strand} (${gene.strand === "+" ? "forward" : "reverse"})`} />
              <Fact label="Biotype" value={gene.biotype} />
              <Fact label="Transcripts" value={gene.transcripts.length} />
              <Fact label="HGNC" value={gene.hgncId} />
            </dl>
            <div className="id-copy-row"><code>{gene.versionedId}</code><CopyButton value={gene.versionedId} label="versioned gene ID" /></div>
            <div className="export-row" aria-label="Bounded gene exports">
              <a href={`/api/v1/export?entity=gene&id=${encodeURIComponent(gene.versionedId)}&format=json`}>Export JSON</a>
              <a href={`/api/v1/export?entity=gene&id=${encodeURIComponent(gene.versionedId)}&format=tsv`}>Export TSV</a>
            </div>
            <div className="inspector-callout neutral">
              <strong>Authoritative local annotation</strong>
              <p>Transcript models and repeated flags are loaded from the immutable raw-GTF build, not the lossy helper tables.</p>
            </div>
            <InspectorAnnotationEditor
              entityKey={geneAnnotationKey}
              entityLabel={`${gene.symbol} gene`}
              annotation={userAnnotations[geneAnnotationKey]}
              onSave={onSaveUserAnnotation}
              onDelete={onDeleteUserAnnotation}
            />
          </section>
        )}

        {tab === "transcript" && (
          <section>
            <div className="id-copy-row"><code>{transcript.versionedId}</code><CopyButton value={transcript.versionedId} label="versioned transcript ID" /></div>
            {transcript.versionedProteinId ? (
              <div className="id-copy-row"><code>{transcript.versionedProteinId}</code><CopyButton value={transcript.versionedProteinId} label="versioned protein ID" /></div>
            ) : (
              <div className="inspector-callout neutral"><strong>No translated product</strong><p>This transcript remains part of the gene model but has no local protein product or protein-feature lane.</p></div>
            )}
            <div className="export-row" aria-label="Bounded transcript exports">
              <a href={`/api/v1/export?entity=transcript&id=${encodeURIComponent(transcript.versionedId)}&sources=${encodeURIComponent(activeSources.join(","))}&format=json`}>Export JSON</a>
              <a href={`/api/v1/export?entity=transcript&id=${encodeURIComponent(transcript.versionedId)}&sources=${encodeURIComponent(activeSources.join(","))}&format=tsv`}>Export TSV</a>
            </div>
            <dl className="fact-grid">
              <Fact label="Biotype" value={transcript.biotype} />
              <Fact label="Support" value={transcript.tsl} />
              <Fact label="Annotation level" value={transcript.annotationLevel ?? "Not provided"} />
              <Fact label="CCDS" value={transcript.ccdsId ?? "Not assigned"} />
              <Fact label="APPRIS" value={transcript.appris ?? "Not assigned"} />
              <Fact label="Transcript" value={`${transcript.transcriptLength.toLocaleString()} nt`} />
              <Fact label="Translated CDS" value={`${transcript.cdsLength.toLocaleString()} nt`} />
              <Fact label="Protein" value={transcript.proteinLength > 0 ? `${transcript.proteinLength.toLocaleString()} aa` : "No translated product"} />
              <Fact label="Exons" value={transcript.exons.length} />
            </dl>
            {transcript.fastaCdsSpanLength && (
              <p className="data-note">FASTA header CDS span: {transcript.fastaCdsSpanLength.toLocaleString()} nt, including the terminal 3-nt stop codon; translated CDS above excludes it.</p>
            )}
            <h3 className="section-title">Annotation flags</h3>
            <div className="tag-cloud">{[...transcript.badges, ...transcript.tags].map((tag) => <span key={tag}>{tag}</span>)}</div>
            <InspectorAnnotationEditor
              entityKey={transcriptAnnotationKey}
              entityLabel={`${transcript.name} transcript`}
              annotation={userAnnotations[transcriptAnnotationKey]}
              onSave={onSaveUserAnnotation}
              onDelete={onDeleteUserAnnotation}
            />
            <h3 className="section-title">Exon / CDS structure</h3>
            <ol className="exon-list">
              {transcript.exons.map((item) => (
                <li key={`${transcript.id}-${item.rank}`}>
                  <strong>Exon {item.rank}</strong>
                  <span>{item.id}</span>
                  <small>{gene.chrom}:{(item.start0 + 1).toLocaleString()}–{item.end0.toLocaleString()} {item.phase === undefined ? "UTR only" : `· phase ${item.phase}`}</small>
                </li>
              ))}
            </ol>
            {splitCodonBoundaries.length > 0 && (
              <details className="split-codon-details" open>
                <summary>Split-codon boundaries ({splitCodonBoundaries.length})</summary>
                <table>
                  <caption className="sr-only">Phase-aware split-codon boundaries for {transcript.versionedId}</caption>
                  <thead><tr><th>Exon</th><th>GENCODE phase</th><th>Protein position</th></tr></thead>
                  <tbody>{splitCodonBoundaries.map((exon) => (
                    <tr key={`phase-${exon.rank}`} title={`GENCODE CDS phase ${exon.phase}; the residue boundary crosses this coding-exon junction.`}>
                      <td>{exon.rank}</td><td>phase {exon.phase}</td><td>{exon.aaStart === undefined ? "Not mapped" : `aa ${exon.aaStart}`}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </details>
            )}
          </section>
        )}

        {tab === "compare" && comparisonPanel}

        {tab === "feature" && (
          <section>
            {selectedFeature ? (
              <>
                <div className="feature-source-heading">
                  <span style={{ backgroundColor: SOURCE_META[selectedFeature.source].color }} aria-hidden="true" />
                  <div><h3>{SOURCE_META[selectedFeature.source].label}</h3><p>{SOURCE_META[selectedFeature.source].description}</p></div>
                </div>
                <dl className="fact-grid">
                  <Fact label="Accession" value={selectedFeature.featureId} />
                  {selectedFeature.altName && <Fact label="Alternate name" value={selectedFeature.altName} />}
                  <Fact label="Amino acids" value={`${selectedFeature.aaStart}–${selectedFeature.aaEnd}`} />
                  <Fact label="CDS nucleotides" value={selectedFeatureCdsBounds ? `${selectedFeatureCdsBounds.start1}–${selectedFeatureCdsBounds.end1}` : "Not exactly projected"} />
                  <Fact label="Length" value={`${selectedFeature.aaEnd - selectedFeature.aaStart + 1} aa`} />
                  <Fact label={selectedFeature.method.toLowerCase() === "biomart" ? "Retrieval method" : "Method"} value={selectedFeature.method} />
                  <Fact label="Projection status" value={selectedFeature.projectionStatus ?? "Not provided"} />
                  <Fact label="Genomic pieces" value={selectedFeature.segments.length} />
                </dl>
                {selectedFeature.mappingReason && <p className="data-note"><strong>Mapping note:</strong> {selectedFeature.mappingReason}</p>}
                <div className="export-row" aria-label="Bounded feature exports">
                  <a href={`/api/v1/export?entity=feature&id=${encodeURIComponent(selectedFeature.recordId)}&format=json`}>Export JSON</a>
                  <a href={`/api/v1/export?entity=feature&id=${encodeURIComponent(selectedFeature.recordId)}&format=tsv`}>Export TSV</a>
                </div>
                <h3 className="section-title">Projected CDS pieces</h3>
                <ol className="projection-list">
                  {selectedFeature.segments.map((segment, index) => (
                    <li key={`${segment.start0}-${segment.end0}`}>
                      <span>{index + 1}</span>
                      <div>
                        <code>{gene.chrom}:{(segment.start0 + 1).toLocaleString()}–{segment.end0.toLocaleString()}</code>
                        <small>contributing exon {segment.exonRank}{segment.ntStart0 !== undefined && segment.ntEnd0 !== undefined ? ` · CDS nt ${segment.ntStart0 + 1}–${segment.ntEnd0}` : ""}</small>
                      </div>
                    </li>
                  ))}
                </ol>
                {selectedFeature.segments.length > 1 && <div className="inspector-callout split"><strong>Exon-junction feature</strong><p>Rendered as {selectedFeature.segments.length} CDS-confined pieces; no intron-spanning rectangle is drawn.</p></div>}
                {selectedFeature.segments.length === 0 && <div className="inspector-callout neutral"><strong>Amino-acid annotation only</strong><p>The translation mapping is partial or unresolved, so this record is not drawn as genomic pieces.</p></div>}
                {selectedFeature.rawAudit && (
                  <details className="raw-audit-details">
                    <summary>Local source-row audit provenance</summary>
                    <dl className="fact-grid">
                      <Fact label="Raw name" value={selectedFeature.rawAudit.name ?? "Not provided"} />
                      <Fact label="Raw coordinates" value={selectedFeature.rawAudit.chrom && selectedFeature.rawAudit.start1 !== undefined && selectedFeature.rawAudit.end1 !== undefined ? `${selectedFeature.rawAudit.chrom}:${selectedFeature.rawAudit.start1}–${selectedFeature.rawAudit.end1}` : "Not provided"} />
                      <Fact label="Raw strand" value={selectedFeature.rawAudit.strand ?? "Not provided"} />
                      <Fact label="Drawing use" value={selectedFeature.rawAudit.notDrawable ? "Audit only — never drawn" : "Not declared"} />
                    </dl>
                  </details>
                )}
              </>
            ) : transcript.proteinLength <= 0 ? (
              <div className="empty-inspector"><span aria-hidden="true">∅</span><h3>No translated product</h3><p>This noncoding transcript has no protein-feature records or protein coordinate lane.</p></div>
            ) : transcript.featuresState === "loading" || transcript.featuresState === "idle" ? (
              <div className="sequence-status" role="status"><strong>Loading local protein annotations…</strong><span>The transcript model remains available while this panel loads independently.</span></div>
            ) : transcript.featuresState === "error" ? (
              <div className="sequence-status missing" role="alert"><strong>Feature annotations unavailable</strong><span>The local request failed; no empty biological state is inferred.</span><button type="button" className="copy-button" onClick={onRetryFeatures}>Retry</button></div>
            ) : (
              <div className="empty-inspector"><span aria-hidden="true">⌁</span><h3>Select a feature</h3><p>Choose a colored, source-labeled mark in either coordinate lane or use the table.</p></div>
            )}
          </section>
        )}

        {tab === "sequence" && (
          <section>
            <div className="sequence-kind-tabs" role="group" aria-label="Sequence kind">
              {([
                ["protein", "Protein"],
                ["transcript_full", "Full transcript"],
                ["cds", "CDS"],
              ] as const).map(([kind, label]) => (
                <button
                  type="button"
                  key={kind}
                  aria-pressed={sequenceKind === kind}
                  onClick={() => setSequenceKind(kind)}
                  disabled={(kind === "protein" && transcript.proteinLength <= 0) || (kind === "cds" && transcript.cdsLength <= 0)}
                >{label}</button>
              ))}
            </div>
            <div className="sequence-card">
              <span>{sequenceKind === "protein" ? "Protein product" : sequenceKind === "cds" ? "Coding sequence" : "Full spliced transcript"}</span>
              <strong>{sequenceKind === "protein" ? transcript.versionedProteinId || "No translated product" : transcript.versionedId}</strong>
              <b>{sequenceKind === "protein" ? `${transcript.proteinLength} aa` : sequenceKind === "cds" ? `${transcript.cdsLength} nt` : `${transcript.transcriptLength.toLocaleString()} nt`}</b>
            </div>
            {sequenceState.status === "loading" && <div className="sequence-status" role="status">Loading from the local immutable build…</div>}
            {sequenceState.status === "missing" && <div className="sequence-status missing" role="status"><strong>Sequence unavailable</strong><span>The local build has no sequence for this transcript and kind.</span></div>}
            {sequenceState.status === "error" && <div className="sequence-status missing" role="alert"><strong>Local sequence service unavailable</strong><span>No sequence text is synthesized when the immutable record cannot be read.</span><button type="button" className="copy-button" onClick={() => setSequenceRetry((value) => value + 1)}>Retry</button></div>}
            {sequenceState.status === "ready" && sequenceState.sequence && (
              <div className="sequence-output">
                <div><span>{sequenceState.sequence.length.toLocaleString()} characters</span><CopyButton value={sequenceState.sequence} label={`${sequenceKind} sequence`} /></div>
                <div className="sequence-legend" aria-label="Sequence overlays">
                  <span><i className="exon-even" />alternating exon</span>
                  {sequenceKind !== "protein" && <span><i className="cds" />CDS</span>}
                  {selectedFeature && <span><i className="selected-feature" />selected feature</span>}
                </div>
                <div
                  className="sequence-lines"
                  role="region"
                  aria-label={`${sequenceKind} sequence for ${transcript.versionedId}`}
                  ref={sequenceViewport.setElement}
                >
                  <div className="sequence-virtual-spacer" style={{ height: sequenceLineCount * SEQUENCE_ROW_HEIGHT }} role="list">
                  {sequenceLines.map((line) => {
                    const lineIndex = Math.floor((line.start1 - 1) / SEQUENCE_LINE_LENGTH);
                    return (
                    <div
                      className="sequence-line"
                      key={line.start1}
                      role="listitem"
                      aria-posinset={lineIndex + 1}
                      aria-setsize={sequenceLineCount}
                      style={{ top: lineIndex * SEQUENCE_ROW_HEIGHT, height: SEQUENCE_ROW_HEIGHT }}
                    >
                      <span className="sequence-position">{line.start1.toLocaleString()}</span>
                      <code>{line.segments.map((segment, index) => (
                        <span className={segment.className || undefined} key={`${line.start1}-${index}`}>{segment.text}</span>
                      ))}</code>
                    </div>
                    );
                  })}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "table" && (
          <section>
            {transcript.proteinLength <= 0 ? (
              <div className="empty-inspector"><span aria-hidden="true">∅</span><h3>No translated product</h3><p>This noncoding transcript remains visible as a genomic model and has no protein-feature table.</p></div>
            ) : transcript.featuresState === "loading" || transcript.featuresState === "idle" ? (
              <div className="sequence-status" role="status"><strong>Loading local protein annotations…</strong><span>The table is fetched only when requested and does not block genomic navigation.</span></div>
            ) : transcript.featuresState === "error" ? (
              <div className="sequence-status missing" role="alert"><strong>Feature annotations unavailable</strong><span>The local request failed; this is not a valid zero-feature result.</span><button type="button" className="copy-button" onClick={onRetryFeatures}>Retry</button></div>
            ) : <>
              <div className="table-summary"><strong>{filteredFeatures.length}</strong><span>matching source records on {transcript.name}</span></div>
              <label className="table-filter"><span className="sr-only">Filter feature table</span><input value={tableQuery} onChange={(event) => setTableQuery(event.target.value)} placeholder="Filter accession, name, source, or method" /></label>
              {filteredFeatures.length ? (
              <div className="feature-table-wrap" ref={tableViewport.setElement}>
                <table className="feature-table" aria-rowcount={filteredFeatures.length + 1}>
                  <caption className="sr-only">Protein annotations visible for {transcript.name}</caption>
                  <thead><tr><th>Source</th><th>Feature</th><th>AA</th></tr></thead>
                  <tbody>
                    {tableWindow.paddingTop > 0 && (
                      <tr className="virtual-table-spacer" aria-hidden="true"><td colSpan={3} style={{ height: tableWindow.paddingTop }} /></tr>
                    )}
                    {windowedFeatures.map((feature, visibleIndex) => {
                      const featureIndex = tableWindow.firstIndex + visibleIndex;
                      return (
                      <tr
                        key={feature.recordId}
                        className={selectedFeature?.recordId === feature.recordId ? "selected" : ""}
                        aria-rowindex={featureIndex + 2}
                        style={{ height: FEATURE_ROW_HEIGHT }}
                      >
                        <td><span className="table-source-dot" style={{ backgroundColor: SOURCE_META[feature.source].color }} aria-hidden="true" />{SOURCE_META[feature.source].shortLabel}</td>
                        <td><button type="button" onClick={() => onSelectFeature(feature)}>{feature.featureId}<small>{feature.name}</small></button></td>
                        <td>{feature.aaStart}–{feature.aaEnd}</td>
                      </tr>
                      );
                    })}
                    {tableWindow.paddingBottom > 0 && (
                      <tr className="virtual-table-spacer" aria-hidden="true"><td colSpan={3} style={{ height: tableWindow.paddingBottom }} /></tr>
                    )}
                  </tbody>
                </table>
              </div>
              ) : (
                <div className="empty-inspector"><span aria-hidden="true">∅</span><h3>{visibleFeatures.length ? "No feature table matches" : "No features in the selected local sources"}</h3><p>{transcript.name} and {transcript.proteinLength > 0 ? `its ${transcript.proteinLength}-aa product` : "its noncoding transcript model"} remain visible.</p></div>
              )}
            </>}
          </section>
        )}
      </div>
    </aside>
  );
}
