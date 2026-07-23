# Local Transcript Browser frontend

The frontend is a local-only React and TypeScript single-page application for
the full GENCODE v45 browser and its SP1 acceptance fixture. It renders genomic
structure and protein-feature projections with a high-DPI Canvas while keeping
navigation, labels, filters, inspection, and tabular data in accessible HTML.

Search, genes, transcript detail, semantic-detail regions, density bins,
protein features, and sequences are loaded from the versioned local API.
Feature and sequence requests are lazy and cancellable. Deep URLs and exported
session JSON include the immutable build hash; restoration refuses stale build
state rather than silently resolving it against different annotations.

## Commands

Requires Node.js 22.13 or newer and pnpm.

```bash
pnpm install
pnpm dev
pnpm test
pnpm build
```

During development, Vite proxies `/api` to `http://127.0.0.1:8000`. The
production build is emitted to `dist/`; the project FastAPI service serves that
directory and provides the same-origin `/api/v1` endpoints.

Startup uses a neutral empty frame until the local manifest validates; no SP1
fixture data is rendered as a fallback. A missing or invalid API is a visible
startup failure and never triggers a network request. Sequence text is never
synthesized: the Sequence inspector distinguishes a valid absent sequence from
a local service error.
