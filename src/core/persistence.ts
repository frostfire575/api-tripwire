import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { candidates, canonical } from './compare.js';
import { union } from '../ast/project.js';
import type { Consumer, Report, Route, Shape } from './models.js';

export function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function baseline(report: Report): string {
  const file = path.join(report.root, '.api-tripwire-baseline.json');
  atomicWrite(file, {
    schemaVersion: '1',
    findings: [...new Set(report.issues.map((i) => i.id))].sort(),
  });
  return file;
}

export function applyBaseline(report: Report): void {
  const file = path.join(report.root, '.api-tripwire-baseline.json');
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Cannot read baseline ${file}; create one with api-tripwire baseline`);
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !('schemaVersion' in data) ||
    data.schemaVersion !== '1' ||
    !('findings' in data) ||
    !Array.isArray(data.findings) ||
    !data.findings.every((v) => typeof v === 'string' && /^[a-f\d]{64}$/.test(v))
  )
    throw new Error(`Malformed baseline ${file}`);
  const ids = new Set(data.findings);
  for (const issue of report.issues) issue.suppressed = ids.has(issue.id);
  report.summary.suppressed = report.issues.filter((i) => i.suppressed).length;
}

export function saveContracts(report: Report): string {
  const file = path.join(report.root, '.api-tripwire/contracts.json');
  atomicWrite(file, { schemaVersion: '1', routes: report.routes });
  return file;
}

export interface ContractChange {
  kind: string;
  method: string;
  route: string;
  field: string | null;
  before: unknown;
  after: unknown;
  confidence: 'HIGH' | 'POSSIBLE';
  breaking: boolean;
  consumers: Consumer[];
}

function flatten(
  shape: Shape,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  if (shape.kind === 'object') {
    out[prefix || '$'] = { kind: 'object', open: shape.open };
    for (const [key, property] of Object.entries(shape.properties)) {
      const field = prefix ? prefix + '.' + key : key;
      out[field + '?'] = property.optional;
      flatten(property.shape, field, out);
    }
  } else if (shape.kind === 'array') {
    out[prefix || '$'] = { kind: 'array' };
    flatten(shape.element, prefix + '[]', out);
  } else out[prefix || '$'] = shape;
  return out;
}

export function diffContracts(report: Report): { schemaVersion: '1'; changes: ContractChange[] } {
  const file = path.join(report.root, '.api-tripwire/contracts.json');
  let data: { schemaVersion?: string; routes?: Route[] };
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof data;
  } catch {
    throw new Error(`Cannot read snapshot ${file}; run api-tripwire scan --save-contracts first`);
  }
  if (
    data?.schemaVersion !== '1' ||
    !Array.isArray(data.routes) ||
    !data.routes.every(
      (r) =>
        r &&
        typeof r.method === 'string' &&
        typeof r.path === 'string' &&
        Array.isArray(r.responses) &&
        Array.isArray(r.request) &&
        r.responses.every((v) => v && validShape(v.shape)) &&
        r.request.every(
          (v) =>
            v &&
            typeof v.path === 'string' &&
            typeof v.required === 'boolean' &&
            validShape(v.shape),
        ),
    )
  )
    throw new Error(`Malformed contract snapshot ${file}`);
  const changes: ContractChange[] = [];

  const key = (r: Route): string => r.method + ' ' + r.path;

  const old = new Map(data.routes.map((r) => [key(r), r]));
  const current = new Map(report.routes.map((r) => [key(r), r]));

  const add = (
    route: Route,
    kind: string,
    field: string | null,
    before: unknown,
    after: unknown,
    breaking: boolean,
    uncertain = false,
  ): void => {
    changes.push({
      kind,
      method: route.method,
      route: route.path,
      field,
      before: before ?? null,
      after: after ?? null,
      confidence: uncertain ? 'POSSIBLE' : 'HIGH',
      breaking,
      consumers: report.consumers.filter((c) => candidates(c, [route]).length > 0),
    });
  };

  for (const [id, previous] of old)
    if (!current.has(id)) add(previous, 'route-removed', null, previous.fingerprint, null, true);
  for (const [id, route] of current) {
    const previous = old.get(id);
    if (!previous) {
      add(route, 'route-added', null, null, route.fingerprint, false);
      continue;
    }
    if (route.fingerprint === previous.fingerprint) continue;

    const responseFields = (r: Route): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      const variants = new Map<number | null, Shape[]>();
      for (const response of r.responses)
        variants.set(response.status, [...(variants.get(response.status) ?? []), response.shape]);
      for (const [status, shapes] of variants)
        for (const [field, shape] of Object.entries(flatten(union(shapes))))
          out[`response:${status ?? 'unknown'}.${field}`] = shape;
      for (const field of r.request)
        out[`request:${field.source}.${field.path}`] = {
          required: field.required,
          shape: field.shape,
        };
      return out;
    };

    const before = responseFields(previous);
    const after = responseFields(route);
    for (const field of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (canonical(before[field]) === canonical(after[field])) continue;
      const removed = !(field in after);
      const added = !(field in before);
      const uncertain =
        field.startsWith('response:') &&
        /unknown|"open":true/.test(JSON.stringify([before[field], after[field]]));
      const breaking =
        (removed && field.startsWith('response:')) ||
        (field.startsWith('request:') &&
          !!(after[field] as { required?: boolean } | undefined)?.required);
      add(
        route,
        uncertain
          ? 'uncertainty-changed'
          : added
            ? 'field-added'
            : removed
              ? 'field-removed'
              : field.endsWith('?')
                ? 'optionality-changed'
                : 'type-changed',
        field,
        before[field],
        after[field],
        breaking,
        uncertain,
      );
    }
  }
  return { schemaVersion: '1', changes };
}

function validShape(value: unknown, depth = 0): value is Shape {
  if (!value || typeof value !== 'object' || !('kind' in value) || depth > 50) return false;
  const v = value as Shape;
  if (v.kind === 'unknown') return typeof v.reason === 'string';
  if (v.kind === 'primitive')
    return ['string', 'number', 'boolean', 'null', 'undefined'].includes(v.type);
  if (v.kind === 'literal')
    return v.value === null || ['string', 'number', 'boolean'].includes(typeof v.value);
  if (v.kind === 'array') return validShape(v.element, depth + 1);
  if (v.kind === 'union')
    return Array.isArray(v.variants) && v.variants.every((s) => validShape(s, depth + 1));
  return (
    v.kind === 'object' &&
    typeof v.open === 'boolean' &&
    !!v.properties &&
    Object.values(v.properties).every(
      (p) => typeof p.optional === 'boolean' && validShape(p.shape, depth + 1),
    )
  );
}
