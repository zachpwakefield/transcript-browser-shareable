# Contributing

Contributions should preserve the browser's source-only, offline-first boundary.

## Before opening a pull request

```bash
./scripts/verify_publication.sh
python3 -m unittest discover -s tests/data -p 'test_*.py' -v
.venv/bin/python -m unittest discover -s backend/tests -p 'test_*.py' -v
cd frontend && pnpm test && pnpm run typecheck && pnpm run build
```

Do not commit GENCODE/Ensembl FASTA files, RDS caches, SQLite builds, local notes, logs, credentials, virtual environments, `node_modules`, or generated desktop bundles. The repository's ignore rules and publication audit are intentionally conservative.

Changes to coordinates, translation projection, feature-source semantics, release constants, or schema require focused regression tests and an entry in the critical review/release documentation. A new GENCODE or Ensembl release is a new scientific build, not a routine dependency bump: update the release pairing, expected counts/checksums, provenance, and manual domain-review plan together.

Keep automated tests, browser interaction evidence, and biological interpretation sign-off separate. Review failure states and privacy boundaries as deliberately as successful workflows; see [`docs/critical_review_addendum.md`](docs/critical_review_addendum.md).
