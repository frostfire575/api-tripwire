# api-tripwire

Find likely API contract drift before a consumer reaches production. Tripwire reads local JavaScript and TypeScript, connects HTTP consumers to backend routes, and compares the fields they exchange. It never runs your application or configuration.

```text
× CONFIRMED GET /api/users/:id
  Consumer reads userId, absent from all known success responses
  consumer client.ts:4:10
  provider server.ts:3:1
  Did you mean id?
```

Version 0.1.0 requires Node ≥22.12.0. This repository is a package implementation; no npm publication is implied. The repository URL in package.json is a placeholder to replace before publishing.

## Install and try

After publication, install with `npm install --save-dev api-tripwire`. To try this checkout:

```sh
npm install
npm run build
node dist/cli.js scan examples/demo
```

The demo intentionally exits **1**. Its server returns `{ id: 'u_123', name: 'Ada' }`; its consumer reads `user.userId`.

For local tarball installation:

```sh
npm pack
npm install --save-dev /path/to/api-tripwire-0.1.0.tgz
npx --no-install api-tripwire scan .
```

On PowerShell, use `npm.cmd` and `npx.cmd` if script execution policy blocks the `.ps1` launchers.

## Commands

| Command                                                 | Purpose                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `api-tripwire [project]`                                | Default scan                                                                                  |
| `api-tripwire scan [project]`                           | Analyze contracts and findings                                                                |
| `api-tripwire init [project]`                           | Explain defaults or create minimal configuration when only example/fixture layout is detected |
| `api-tripwire routes [project]`                         | Inspect provider contracts                                                                    |
| `api-tripwire consumers [project]`                      | Inspect client calls and accesses                                                             |
| `api-tripwire explain GET /api/users/:id --project app` | Inspect one method and normalized route                                                       |
| `api-tripwire doctor [project]`                         | Inspect environment and coverage diagnostics                                                  |
| `api-tripwire ci [project] [--baseline]`                | CI scan with optional suppression                                                             |
| `api-tripwire baseline [project]`                       | Save current findings                                                                         |
| `api-tripwire scan [project] --save-contracts`          | Explicitly save a contract snapshot                                                           |
| `api-tripwire diff [project]`                           | Compare current contracts to the saved snapshot                                               |

Every command supports `--json`, `--debug`, and `--no-color`. Scan and CI support `--fail-on confirmed|high|possible`; the default is **high**. `--help` and `--version` are available. Debug output goes to stderr. `NO_COLOR` disables colors; redirected output is plain. CI output has no decorative symbols.

Exit codes: **0** means no unsuppressed error reached the threshold, **1** means qualifying drift, and **2** means a tool/configuration failure. Inspection and successful artifact creation return 0. Warnings and UNKNOWN diagnostics never fail CI. An exit of 0 with no matched contracts means **unverified**, not verified health.

## Configuration and discovery

Most projects need no configuration. An explicit project argument selects the root. Otherwise Tripwire searches upward for package.json or its config, falling back to the working directory.

```ts
import { defineConfig } from 'api-tripwire';

export default defineConfig({
  include: ['apps/**/*.{ts,tsx,js,jsx}', 'packages/**/*.{ts,tsx,js,jsx}'],
  exclude: ['**/generated/**'],
  confidence: 'high',
  clients: ['internalFetch'],
});
```

Save as `api-tripwire.config.ts` or `.js` (dot-prefixed equivalents also work). Only literal exported objects and the shown `defineConfig` import/call are accepted. Variables, executable expressions, getters, spreads, arbitrary calls and dynamic imports are rejected. Config is parsed, never loaded as a module. `init` never overwrites existing files.

`confidence` sets the default failure threshold; it does not filter the report. CLI `--fail-on` overrides it. Explicit `clients` names opt in to fetch-style URL/options discovery; they do not certify arbitrary wrapper transformations.

Defaults discover JS, JSX, TS and TSX. Tests, fixtures and examples are excluded by default inside a scan root. Scanning `examples/demo` directly includes its own files. Custom `include` opts into those directories. Dependencies, build outputs, coverage, Git and Tripwire artifact directories are always excluded. Symlink directories are not followed. Local import resolution stays inside the project root.

## Support matrix

These common patterns have fixture and regression coverage. The analyzer is deliberately bounded; this is not a full model of any framework's runtime.

| Provider        | Tested patterns                                                                                 | Limits                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Express         | Imported factory/Router, method calls, literal mounts, referenced handlers                      | Computed paths, route-builder chains and middleware transformations are not modeled |
| Fastify         | Shorthand methods, route objects, static plugin prefixes                                        | Dynamic plugin registration and schemas/serialization hooks are not modeled         |
| Hono            | Imported Hono, method calls, mounted subapps, c.json, basic c.req usage                         | Complex middleware and validator effects are not modeled                            |
| Next App Router | Named method exports, route groups, `[id]`, catch-all segments, Response.json/NextResponse.json | Re-exports and advanced route interception are not modeled                          |
| Next Pages API  | Default handlers with literal `req.method === 'GET'` branches                                   | Switch-based dispatch and dynamic dispatch are not modeled                          |

| Consumer       | Tested patterns                                                        |
| -------------- | ---------------------------------------------------------------------- |
| fetch          | Await/json, then/json, aliases, simple local wrappers, literal options |
| Axios          | Calls/methods, static create baseURL, `.data` and destructuring        |
| ky             | Calls/methods, static create prefixUrl, `.json()`                      |
| TanStack Query | Imported useQuery/useSuspenseQuery, inline queryFn, result `.data`     |

Simple local imports, value aliases, function-returned objects, known spreads, nested object/array access, literals and conditional response variants are modeled. Parsed files, declarations and shape summaries are cached per scan. Type checking is created lazily for unresolved type annotations and restricted to parsed project files. Type-derived object shapes remain open; assertions and client generics are never runtime proof.

## Confidence and evidence

- **CONFIRMED:** one resolved route; a consumed field is absent from every relevant known success variant, with no structural uncertainty at that path.
- **HIGH:** strong evidence with an inference step, such as a missing request field explicitly rejected by a runtime guard.
- **POSSIBLE:** partial response variants, unknown status, ambiguous routes, optional access, or request usage without a rejection guard.
- **UNKNOWN:** analysis coverage information. It never independently fails CI.

Recognized error responses are separate from success responses. Unknown status lowers confidence. Known keys with unknown values stay distinct from unknown object structure. Unknown spreads may overwrite earlier values. Optional or guarded accesses produce warnings. Guard handling is conservative and can lower confidence more than necessary. Tripwire reports the highest missing response ancestor at each observed consumption site. Rename suggestions use conservative name similarity and never increase confidence.

Request body/query/parameter usage is collected. Destructuring alone establishes only a POSSIBLE expectation. Direct rejection guards can establish required fields; direct `typeof` rejection guards can establish primitive type requirements. Literal query strings and JSON.stringify request bodies are recognized. These checks do not infer validation-library schemas or arbitrary middleware behavior.

Literal routes outrank dynamic matches. Equally specific matches remain ambiguous. Absolute external URLs remain unmatched unless a statically known client base URL establishes the same origin. Relative URLs are interpreted against the local route table; deploy-time rewrites and proxies are outside the model.

## JSON and programmatic API

```sh
api-tripwire scan . --json > tripwire.json
```

Reports use `schemaVersion: "1"` and contain `summary`, `routes`, `consumers`, `issues`, `diagnostics`, `coverage`, `environment`, `root` and the effective config `confidence`. Each issue includes ID, kind, confidence, severity, method, route, field, message, expected/actual shapes, suggestion, consumer/provider locations, evidence and suppression state. Unavailable issue values are explicit nulls. Successful JSON stdout contains only JSON; timing and timestamps are omitted for determinism. Root paths are absolute and location paths are relative with `/` separators.

```ts
import { scan, defineConfig, type Report } from 'api-tripwire';

const config = defineConfig({ confidence: 'high' });
const report: Report = await scan('./app', config);
console.log(report.coverage, report.issues);
```

The ESM API returns all findings and performs no artifact writes. Declarations and all public report/configuration types are exported.

## Baselines and saved changes

```sh
api-tripwire baseline .
api-tripwire ci . --baseline
api-tripwire scan . --save-contracts
# edit provider contracts
api-tripwire diff .
```

Baselines atomically write `.api-tripwire-baseline.json`. IDs use route, issue kind, field, relative consumer file and normalized source context rather than line numbers. Matching findings remain in reports with `suppressed: true`; suppression affects failure decisions. Missing/malformed explicitly requested baselines fail with exit 2.

Only `scan --save-contracts` writes `.api-tripwire/contracts.json`. Route fingerprints are `at_` plus SHA-256 over canonical request/response structures, excluding locations and timestamps. `diff` never modifies the snapshot. It reports additions, removals, type/optionality changes, uncertainty changes and currently related consumers. Response removals and newly proven required request fields are potentially breaking. A diff is an inspection command and exits 0 even when changes are breaking. Git-ref comparison is not included.

Commit baselines/snapshots when your team wants shared history; remove the matching ignore entries or explicitly add those files. A baseline is an acknowledgment of existing findings, not evidence that they are safe.

## GitHub Actions

```yaml
name: API contracts
on: [push, pull_request]
jobs:
  contracts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npx --no-install api-tripwire ci . --baseline
```

Create and commit a baseline first, or omit `--baseline`. In GitHub Actions, qualifying CI findings emit escaped error annotations. `--json` suppresses annotations on stdout. This repository also configures Windows/Linux/macOS package checks; see `.github/workflows/ci.yml`.

## Privacy and limitations

Analysis is local only: no telemetry, uploads, application execution, configuration execution, network requests, or package publishing. Installing npm dependencies is a separate network operation. Reports contain source locations and inferred literal values; treat report artifacts like source code.

Runtime-generated routes, arbitrary middleware/serializer changes, reflective objects, complex control flow, reassignment-heavy data flow, deep/cyclic wrappers and unresolved imports remain incomplete. Unsupported framework syntax may be omitted; doctor and coverage summaries expose recognized uncertainty but cannot enumerate every omitted pattern. Zero matched contracts is always shown as unverified. There is no claim that absence of findings proves compatibility.

## Development

```sh
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run verify:fixtures
npm run verify:package
```

The package check packs a tarball, installs it offline into a temporary project, invokes local npx without registry fallback, checks the demo exit code, imports the public API and compiles a declaration consumer. Run the build before tests because CLI tests exercise `dist/cli.js`. See [CONTRIBUTING.md](CONTRIBUTING.md) and [VERIFICATION.md](VERIFICATION.md).

## License

MIT. See [LICENSE](LICENSE).
