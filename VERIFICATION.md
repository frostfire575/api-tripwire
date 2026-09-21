# v0.1.0 verification record

Executed locally on Windows, 2026-09-21, using Node 24.20.0 and npm 11.19.0. Linux, macOS and Node 22.12 checks are configured in GitHub Actions; they have not been executed in this local session.

## Measured results

| Check                         | Result                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm.cmd install`             | 169 packages installed; audit reported 0 vulnerabilities at installation time                             |
| `npm.cmd run build`           | Exit 0                                                                                                    |
| `npm.cmd run typecheck`       | Exit 0                                                                                                    |
| `npm.cmd run lint`            | Exit 0                                                                                                    |
| `npm.cmd test`                | Exit 0; **77 tests**, 3 test files, 4 terminal snapshots; final suite duration 3.28 s                     |
| `npm.cmd run verify:fixtures` | Exit 0; all 9 expected CLI outcomes verified                                                              |
| `npm.cmd run verify:package`  | Exit 0; offline tarball installation, installed local npx, ESM exports and declaration compilation passed |

The dependency installation and package checks needed access to npm's cache outside the workspace sandbox. No application fixtures were executed, and nothing was published. Package verification uses Node subprocess APIs without a shell and deletes only the temporary directory it created.

## Actual fixture scans

Each row was invoked through `node dist/cli.js scan <directory> --json`, parsed as JSON and checked for a uniquely matched consumer.

| Directory           | Exit | Routes | Matched consumers | Findings |
| ------------------- | ---- | ------ | ----------------- | -------- |
| fixtures/express    | 0    | 1      | 1                 | 0        |
| fixtures/fastify    | 0    | 2      | 1                 | 0        |
| fixtures/hono       | 0    | 1      | 1                 | 0        |
| fixtures/next-app   | 0    | 1      | 1                 | 0        |
| fixtures/next-pages | 0    | 2      | 1                 | 0        |
| fixtures/axios      | 0    | 1      | 1                 | 0        |
| fixtures/ky         | 0    | 1      | 1                 | 0        |
| fixtures/tanstack   | 0    | 1      | 1                 | 0        |
| examples/demo       | 1    | 1      | 1                 | 1        |

CLI subprocess tests also exercised default scan, help/version, init, explain, routes, consumers, doctor, baseline creation, CI baseline suppression, snapshot creation, diff, configuration threshold overrides, missing snapshots, invalid options, JSON purity and annotation suppression.

## Captured demo output

`node dist/cli.js scan examples/demo --no-color`:

```text
api-tripwire · API contract drift

× CONFIRMED GET /api/users/:id
  Consumer reads userId, absent from all known success responses
  consumer client.ts:4:10
  provider server.ts:3:1
  Did you mean id?
  Evidence: Static json response

1 routes · 1 consumers · 1 matched
1 findings · 0 suppressed · 0 coverage diagnostics
```

The same mismatch was verified after installing `api-tripwire-0.1.0.tgz` into a temporary project and invoking `npx --no-install --offline api-tripwire scan demo --json`. Expected/observed exit: 1. The installed `scan` and `defineConfig` exports were imported, and a TypeScript consumer of `Report` and `Config` compiled successfully.

## Regression coverage

Tests cover framework identity/shadowing, static mounts/plugin prefixes, Next groups/catch-all/method dispatch, local imports and wrappers, cyclic wrappers, unrelated get/json methods, fetch/Axios/ky/TanStack propagation, nested and array reads, literal-vs-dynamic matching, ambiguous routes, external origins, error/success branches, unknown statuses/returns/spreads, spread overwrite order, optional access, request destructuring, rejection/type guards, query strings, serialized bodies, handler wrappers, type enrichment, simple assignments and mutation uncertainty.

Persistence checks cover deterministic reports, fingerprints across formatting/property-order changes, baseline stability across line/comment changes, preserved suppression metadata, malformed/missing artifacts, snapshot immutability, response removals, required request additions and uncertainty changes. Terminal tests cover colored/plain/CI output, narrow width, long-path wrapping and escaped annotations. Location separators are tested locally on Windows; the configured OS matrix will exercise the same expectations on POSIX.

## Important files

```text
src/
  cli.ts                 commands and exit behavior
  index.ts               public ESM exports
  ast/project.ts         parser cache, lexical resolution, shapes, lazy types
  adapters/routes.ts     provider discovery and request/response inference
  config/index.ts        project roots and literal-only configuration
  core/
    models.ts            public report and contract types
    consumers.ts         client provenance and field observations
    compare.ts           matching, confidence, fingerprints, IDs
    scan.ts              discovery and report assembly
    persistence.ts       atomic baselines, snapshots and diffs
  output/terminal.ts     wrapping, color and Actions annotations
test/                    77 tests and terminal snapshots
fixtures/                eight clean provider/client fixture projects
examples/demo/           intentional userId/id mismatch
scripts/                 CLI fixture and tarball installation checks
.github/workflows/ci.yml  Windows/Linux/macOS × Node 22.12/24 matrix
```

## Limits and review notes

The implementation is bounded static analysis, not a runtime contract verifier. Unknown shapes and branches can prevent findings. Complex wrappers, serializers, middleware, control flow, route-builder chains, Pages switch dispatch, package export/re-export graphs, path aliases and reassignment-heavy code are not fully modeled. Some unsupported syntax is omitted rather than diagnosed individually. Reports with no uniquely matched contracts are explicitly unverified. Guard analysis can conservatively downgrade unrelated conditional reads.

The major source modules were reviewed for placeholders, unsafe `any`, silent error handling, fabricated framework matches and duplicated confidence logic. The intended repository metadata placeholder remains documented; replace it before publication. CI is configured but has not been run on hosted platforms. The support matrix describes tested patterns, not exhaustive support for framework APIs.

## Five prioritized v1.1 improvements

1. Add scope-aware control-flow and mutation analysis, including precise guards, status assignments and required-field dominance.
2. Expand wrapper/import resolution to path aliases, re-exports, nested destructuring, array callbacks and more TanStack query patterns.
3. Expand provider adapters with Express route-builder chains, Pages switch dispatch, middleware/schema evidence and explicit unsupported-syntax diagnostics.
4. Improve saved diffs with variant correspondence, field-specific affected-consumer filtering and optional Git-ref snapshots.
5. Add large monorepo performance benchmarks, incremental caches and a broader cross-platform fixture corpus before expanding strong-support claims.
