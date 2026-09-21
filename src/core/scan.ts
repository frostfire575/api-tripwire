import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import ts from 'typescript';
import { Project } from '../ast/project.js';
import { discoverRoutes } from '../adapters/routes.js';
import { readConfig, projectRoot } from '../config/index.js';
import { discoverConsumers } from './consumers.js';
import { compare, fingerprint } from './compare.js';
import type { Config, Report, Diagnostic, Shape } from './models.js';

export const alwaysExcluded = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.git/**',
  '**/.next/**',
  '**/.api-tripwire/**',
];

export function incomplete(shape: Shape): boolean {
  return (
    shape.kind === 'unknown' ||
    (shape.kind === 'object' &&
      (shape.open || Object.values(shape.properties).some((p) => incomplete(p.shape)))) ||
    (shape.kind === 'array' && incomplete(shape.element)) ||
    (shape.kind === 'union' && shape.variants.some(incomplete))
  );
}

export async function scan(input?: string, overrides: Config = {}): Promise<Report> {
  const root = projectRoot(input);
  const config = { ...readConfig(root), ...overrides };
  const files = await fg(config.include ?? ['**/*.{js,jsx,ts,tsx}'], {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: [
      ...alwaysExcluded,
      '**/*.d.ts',
      '**/*tripwire.config.*',
      ...(config.include
        ? []
        : [
            '**/test/**',
            '**/tests/**',
            '**/__tests__/**',
            '**/fixtures/**',
            '**/examples/**',
            '**/*.test.*',
            '**/*.spec.*',
          ]),
      ...(config.exclude ?? []),
    ],
  });
  files.sort();
  const project = new Project(root, files);
  const diagnostics: Diagnostic[] = [];
  for (const file of project.files.values()) {
    const parsed = file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
    for (const diagnostic of parsed.parseDiagnostics ?? [])
      diagnostics.push({
        code: 'parse-error',
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        location: project.location(file),
        confidence: 'UNKNOWN',
      });
  }
  const routes = discoverRoutes(project, diagnostics);
  const consumers = discoverConsumers(project, config, diagnostics);
  const issues = compare(routes, consumers);
  routes.forEach((route) => {
    route.fingerprint = fingerprint(route);
  });
  const matched = consumers.filter((c) => c.matchedRouteIds.length === 1).length;
  for (const consumer of consumers)
    if (consumer.matchedRouteIds.length !== 1)
      diagnostics.push({
        code: consumer.matchedRouteIds.length ? 'ambiguous-route' : 'unmatched-consumer',
        message: `${consumer.method} ${consumer.path}: ${consumer.matchedRouteIds.length ? 'multiple equally specific routes' : 'no local route matched'}`,
        location: consumer.location,
        confidence: 'UNKNOWN',
      });
  const incompleteRoutes = routes.filter((r) =>
    r.responses.some((v) => v.status === null || incomplete(v.shape)),
  ).length;
  const packageManager = fs.existsSync(path.join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : fs.existsSync(path.join(root, 'yarn.lock'))
      ? 'yarn'
      : fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))
        ? 'bun'
        : 'npm';
  const frameworks = new Set(routes.map((r) => r.framework));

  const detect = (value: string): void => {
    const framework = value.split('/')[0]!;
    if (['express', 'fastify', 'hono', 'next'].includes(framework)) frameworks.add(framework);
  };

  for (const file of project.files.values())
    for (const statement of file.statements)
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))
        detect(statement.moduleSpecifier.text);
  const manifest = path.join(root, 'package.json');
  if (fs.existsSync(manifest)) {
    let metadata: {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    try {
      metadata = JSON.parse(fs.readFileSync(manifest, 'utf8')) as typeof metadata;
    } catch {
      throw new Error(`Invalid package manifest: ${manifest}`);
    }
    if (metadata && typeof metadata === 'object')
      for (const dependency of Object.keys({
        ...metadata.dependencies,
        ...metadata.devDependencies,
      }))
        detect(dependency);
  }
  return {
    schemaVersion: '1',
    root: root.replaceAll('\\', '/'),
    summary: {
      files: project.files.size,
      routes: routes.length,
      consumers: consumers.length,
      matched,
      issues: issues.length,
      suppressed: 0,
    },
    routes,
    consumers,
    issues,
    diagnostics,
    coverage: {
      matched,
      unmatched: consumers.length - matched,
      incompleteRoutes,
      status: !matched
        ? 'unverified'
        : diagnostics.length || incompleteRoutes
          ? 'partial'
          : 'analyzed',
    },
    environment: {
      packageManager,
      languages: [
        ...new Set(files.map((f) => (/\.tsx?$/.test(f) ? 'TypeScript' : 'JavaScript'))),
      ].sort(),
      frameworks: [...frameworks].sort(),
    },
    confidence: config.confidence ?? 'high',
  };
}
