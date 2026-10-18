# Changelog

## Unreleased

- Allow package verification to fetch dependencies when the npm cache is incomplete.
- Enforce LF checkout and run the full CI matrix without cancelling other jobs on failure.
- Add README badges, published installation instructions, and package support links.

## 0.1.0

Initial release, published on [npm](https://www.npmjs.com/package/api-tripwire/v/0.1.0).

- Analyze local JavaScript and TypeScript for likely API contract drift without executing application code or configuration.
- Inspect Express, Fastify, Hono, Next.js App Router, and Next.js Pages API routes.
- Connect fetch, Axios, ky, and TanStack Query consumers to provider contracts.
- Report findings with confidence levels, source locations, JSON output, and CI exit codes.
- Provide route and consumer inspection, baselines, contract snapshots, and diffs.
- Export `scan`, `defineConfig`, and TypeScript declarations for programmatic use.
- Require Node.js 22.12.0 or newer.
