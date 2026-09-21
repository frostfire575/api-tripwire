# Contributing

Run `npm run format` to format the repository before submitting changes. It applies ESLint fixes, including blank lines between functions, types, interfaces and class methods, then runs Prettier. `npm run format:check` checks Prettier formatting without changing files; `npm run lint` also enforces declaration spacing. CI runs both checks. Prettier uses two-space indentation, single quotes, a 100-column print width and LF line endings.

Use Node ≥22.12 and the committed npm lockfile. Run `npm ci`, then build, typecheck, lint, tests, fixture verification and package verification as listed in the README. Use `npm.cmd` on Windows where needed.

Keep inference independent from presentation. Add provider adapters in `src/adapters`, syntax handling in `src/ast`, comparison/persistence in `src/core`, literal configuration parsing in `src/config`, and terminal rendering in `src/output`. Public types are exported from `src/index.ts`.

For analysis changes, add a regression that exercises both the intended finding and a nearby case that must remain uncertain. Never execute a fixture to infer a contract. Do not treat type assertions, generic client types, unknown spreads or unmatched routes as runtime proof. Record unknown reasons rather than inventing shapes.

Keep baseline IDs independent of line numbers and fingerprints independent of formatting. Snapshot changes should explain a user-visible output change. CLI tests exercise built artifacts; rebuild after changing source. Test fixtures intentionally omit framework dependencies because they are parsed, not executed.

Before proposing a release, replace placeholder repository metadata, inspect `npm pack --dry-run`, run tarball installation verification, and review README claims against tests. This workflow does not publish packages.
