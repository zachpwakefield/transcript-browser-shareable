import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

test("production source has no external runtime URL, telemetry, or remote font dependency", () => {
  const files = [join(root, "index.html"), ...filesBelow(join(root, "src"))];
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /https?:\/\//i);
  assert.doesNotMatch(source, /google-analytics|segment\.com|sentry|telemetry/i);
  assert.doesNotMatch(source, /@import\s+url|fonts\.(?:googleapis|gstatic)/i);
});

test("transcript disclosure and pin affordances are native keyboard controls", () => {
  const source = readFileSync(join(root, "src/components/TranscriptLabels.tsx"), "utf8");
  const command = readFileSync(join(root, "src/components/CommandBar.tsx"), "utf8");
  const styles = readFileSync(join(root, "src/styles.css"), "utf8");
  const orderMenu = readFileSync(join(root, "src/components/TranscriptOrderMenu.tsx"), "utf8");
  const filterBar = readFileSync(join(root, "src/components/FilterBar.tsx"), "utf8");
  assert.match(source, /<button[\s\S]*className="disclosure-button"[\s\S]*aria-expanded=/);
  assert.match(source, /<button[\s\S]*className="pin-button"[\s\S]*aria-pressed=/);
  assert.doesNotMatch(source, /disabled=\{displayMode !== "expanded"/);
  assert.match(command, /<option value="expanded">Protein features<\/option>/);
  assert.match(command, /<option value="labeled">Exon structures<\/option>/);
  assert.match(styles, /\.track-scroller[^}]*overflow-anchor:\s*none/);
  assert.match(orderMenu, /className="transcript-order-trigger"[\s\S]*aria-expanded=/);
  assert.match(orderMenu, /Place directly above selected/);
  assert.match(orderMenu, /Move down one visible row/);
  assert.match(filterBar, /Restore original transcript order/);
});

test("PDF export is a bounded accessible dialog rather than a Canvas screenshot", () => {
  const actions = readFileSync(join(root, "src/components/SessionActions.tsx"), "utf8");
  const dialog = readFileSync(join(root, "src/components/PdfExportDialog.tsx"), "utf8");
  const api = readFileSync(join(root, "src/api.ts"), "utf8");
  assert.match(actions, />Save PDF<\/button>/);
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /event\.key !== "Tab"/);
  assert.match(dialog, /Transcript summary/);
  assert.match(dialog, /Exon and CDS structure/);
  assert.match(dialog, /Protein annotations/);
  assert.match(dialog, /Sequence excerpt/);
  assert.match(dialog, /Nothing is silently truncated/);
  assert.match(api, /POST/);
  assert.match(api, /application\/pdf/);
  assert.doesNotMatch(dialog, /toDataURL|canvas\.toBlob|window\.print/);
});

test("release shell exposes local performance marks without network reporting", () => {
  const main = readFileSync(join(root, "src/main.tsx"), "utf8");
  const app = readFileSync(join(root, "src/App.tsx"), "utf8");
  assert.match(main, /performance\.mark\("transcript-browser-app-start"\)/);
  assert.match(app, /performance\.measure\(\s*"transcript-browser-first-gene-render"/);
});

test("distinct empty and off-screen states are explicit rather than collapsed into one error", () => {
  const app = readFileSync(join(root, "src/App.tsx"), "utf8");
  const labels = readFileSync(join(root, "src/components/TranscriptLabels.tsx"), "utf8");
  const inspector = readFileSync(join(root, "src/components/Inspector.tsx"), "utf8");
  assert.match(app, /No annotated gene in this interval/);
  assert.match(app, /outside the current genomic view/);
  assert.match(labels, /No features in the selected local sources/);
  assert.match(labels, /No translated product/);
  assert.match(inspector, /Sequence unavailable/);
});

test("production startup never renders the SP1 data fixture as a service fallback", () => {
  const app = readFileSync(join(root, "src/App.tsx"), "utf8");
  assert.doesNotMatch(app, /SP1_GENE|readyFixture/);
  assert.match(app, /EMPTY_GENE/);
  assert.match(app, /region\?\.emptyState/);
});

test("feature loading and modal keyboard states remain distinct and bounded", () => {
  const app = readFileSync(join(root, "src/App.tsx"), "utf8");
  const canvas = readFileSync(join(root, "src/components/GenomeCanvas.tsx"), "utf8");
  const inspector = readFileSync(join(root, "src/components/Inspector.tsx"), "utf8");
  const help = readFileSync(join(root, "src/components/HelpOverlay.tsx"), "utf8");
  assert.match(app, /featureDemandKey/);
  assert.match(canvas, /Loading local protein annotations/);
  assert.match(canvas, /Feature annotations unavailable/);
  assert.match(inspector, /this is not a valid zero-feature result/);
  assert.match(help, /event\.key === "Tab"/);
  assert.match(canvas, /Split-codon boundary/);
  assert.match(inspector, /Split-codon boundaries/);
  assert.match(inspector, /Local source-row audit provenance/);
});

test("startup build identity stays neutral until the local manifest is verified", () => {
  const command = readFileSync(join(root, "src/components/CommandBar.tsx"), "utf8");
  assert.match(command, /manifestState === "ready"/);
  assert.match(command, /Verifying local build/);
  assert.match(command, /Release identity pending/);
  assert.match(command, /title=\{manifestState === "ready"/);
});

test("transcript expansion cannot leave an inspector feature owned by another transcript", () => {
  const app = readFileSync(join(root, "src/App.tsx"), "utf8");
  assert.match(app, /function toggleExpanded[\s\S]*featureSelectionForTranscript\(/);
});
