import { createHash } from 'node:crypto';
import type { Confidence, Consumer, Issue, Route, Shape } from './models.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).sort().join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export const hash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

export function contract(route: Route): unknown {
  return {
    method: route.method,
    path: route.path,
    request: route.request.map(({ source, path, required, shape }) => ({
      source,
      path,
      required,
      shape,
    })),
    responses: route.responses.map(({ status, shape }) => ({ status, shape })),
  };
}

export function fingerprint(route: Route): string {
  return 'at_' + hash(contract(route));
}

interface Lookup {
  state: 'present' | 'missing' | 'unknown';
  path: string;
  shape: Shape | null;
  optional: boolean;
}

export function lookup(
  shape: Shape,
  keys: string[],
  prefix: string[] = [],
  optional = false,
): Lookup[] {
  if (!keys.length) return [{ state: 'present', path: prefix.join('.'), shape, optional }];
  if (shape.kind === 'union')
    return shape.variants.flatMap((s) => lookup(s, keys, prefix, optional));
  if (shape.kind === 'unknown')
    return [{ state: 'unknown', path: [...prefix, ...keys].join('.'), shape, optional }];
  const key = keys[0]!;
  if (shape.kind === 'array') {
    if (key === '[]') return lookup(shape.element, keys.slice(1), [...prefix, key], optional);
    if (['length', 'map', 'filter', 'find', 'forEach'].includes(key))
      return [{ state: 'present', path: [...prefix, key].join('.'), shape: null, optional }];
  }
  if (shape.kind === 'object') {
    const property = shape.properties[key];
    if (property)
      return lookup(property.shape, keys.slice(1), [...prefix, key], optional || property.optional);
    if (shape.open)
      return [{ state: 'unknown', path: [...prefix, key].join('.'), shape: null, optional }];
  }
  return [{ state: 'missing', path: [...prefix, key].join('.'), shape: null, optional }];
}

export function candidates(consumer: Consumer, routes: Route[]): Route[] {
  if (/^(?:[a-z]+:)?\/\//i.test(consumer.path)) return [];
  const actual = consumer.path.split('?')[0]!.split('/').filter(Boolean);
  const matches = routes.filter((route) => {
    if (consumer.method !== route.method) return false;
    const pattern = route.path.split('/').filter(Boolean);
    let i = 0;
    for (; i < pattern.length; i++) {
      const p = pattern[i]!;
      if (p.startsWith('*')) return true;
      if (!actual[i] || (!p.startsWith(':') && p !== actual[i])) return false;
    }
    return i === actual.length;
  });

  const score = (r: Route): number => r.path.split('/').filter((p) => p && !/^[:*]/.test(p)).length;

  const best = Math.max(...matches.map(score));
  return matches.filter((r) => score(r) === best);
}

function rename(field: string, route: Route): string | null {
  const keys = new Set<string>();
  const parent = field.split('.').slice(0, -1);
  const leaf = field.split('.').at(-1)!;
  for (const response of route.responses)
    for (const value of lookup(response.shape, parent))
      if (value.shape?.kind === 'object')
        Object.keys(value.shape.properties).forEach((k) => keys.add(k));

  const normalize = (s: string): string => s.toLowerCase().replace(/[_-]/g, '');

  const normalized = normalize(leaf);
  const suggestions = [...keys].filter((k) => {
    const n = normalize(k);
    return (
      n === normalized ||
      (normalized.endsWith('id') && n === 'id') ||
      (Math.min(n.length, normalized.length) >= 4 && distance(n, normalized) <= 2)
    );
  });
  return suggestions.length === 1 ? `Did you mean ${[...parent, suggestions[0]].join('.')}?` : null;
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next[j + 1] = Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + (a[i] === b[j] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

export function compare(routes: Route[], consumers: Consumer[]): Issue[] {
  const issues: Issue[] = [];
  for (const consumer of consumers) {
    const matched = candidates(consumer, routes);
    consumer.matchedRouteIds = matched.map((r) => r.id);
    if (!matched.length) continue;
    const route = matched[0]!;
    const relevant = matched.flatMap((r) =>
      r.responses.filter((v) => v.status === null || (v.status >= 200 && v.status < 300)),
    );
    for (const access of consumer.accesses) {
      const results = relevant.flatMap((v) => lookup(v.shape, access.path.split('.')));
      const missing = results.filter((r) => r.state === 'missing');
      if (!missing.length) continue;
      const field = missing.sort((a, b) => a.path.split('.').length - b.path.split('.').length)[0]!
        .path;
      const complete =
        missing.length === results.length &&
        relevant.every((v) => v.status !== null) &&
        matched.length === 1 &&
        results.every((r) => !r.optional);
      const confidence: Confidence = access.guarded || !complete ? 'POSSIBLE' : 'CONFIRMED';
      const issue: Issue = {
        id: '',
        kind: 'response-field-missing',
        confidence,
        severity: access.guarded ? 'warning' : 'error',
        method: route.method,
        route: route.path,
        field,
        message: `${access.guarded ? 'Guarded access to' : 'Consumer reads'} ${field}, absent from ${complete ? 'all known success responses' : 'some response variants'}`,
        expected: null,
        actual: null,
        suggestion: rename(field, route),
        consumer: access.location,
        provider: route.location,
        evidence: relevant.flatMap((v) => v.evidence),
        suppressed: false,
      };
      issue.id = hash([
        issue.method,
        issue.route,
        issue.kind,
        issue.field,
        access.location.file,
        access.context,
      ]);
      if (!issues.some((i) => i.id === issue.id)) issues.push(issue);
    }
    for (const field of route.request) {
      if (field.source === 'params') continue;
      const supplied = field.source === 'body' ? consumer.body : consumer.query;
      const results = lookup(supplied, field.path.split('.'));
      if (results.every((r) => r.state === 'missing')) {
        const confidence: Confidence = field.required && matched.length === 1 ? 'HIGH' : 'POSSIBLE';
        const kind = 'request-field-missing';
        issues.push({
          id: hash([
            route.method,
            route.path,
            kind,
            field.source,
            field.path,
            consumer.location.file,
            consumer.method,
            consumer.path,
          ]),
          kind,
          confidence,
          severity: field.required ? 'error' : 'warning',
          method: route.method,
          route: route.path,
          field: `${field.source}.${field.path}`,
          message: `Request omits ${field.source}.${field.path}${field.required ? ', rejected by a server guard' : '; usage alone does not prove it is required'}`,
          expected: field.shape,
          actual: supplied,
          suggestion: null,
          consumer: consumer.location,
          provider: route.location,
          evidence: field.evidence,
          suppressed: false,
        });
      }
      if (
        field.shape.kind === 'primitive' &&
        results.length &&
        results.every((r) => r.state === 'present' && r.shape && incompatible(r.shape, field.shape))
      ) {
        const kind = 'request-type-incompatible';
        issues.push({
          id: hash([
            route.method,
            route.path,
            kind,
            field.source,
            field.path,
            consumer.location.file,
            consumer.path,
          ]),
          kind,
          confidence: matched.length === 1 ? 'HIGH' : 'POSSIBLE',
          severity: 'error',
          method: route.method,
          route: route.path,
          field: `${field.source}.${field.path}`,
          message: `Request ${field.source}.${field.path} has a value incompatible with the server's runtime type guard`,
          expected: field.shape,
          actual: results[0]!.shape,
          suggestion: null,
          consumer: consumer.location,
          provider: route.location,
          evidence: field.evidence,
          suppressed: false,
        });
      }
    }
  }
  return issues.sort((a, b) => a.id.localeCompare(b.id));
}

function incompatible(actual: Shape, expected: Shape): boolean {
  if (expected.kind !== 'primitive') return false;
  if (actual.kind === 'union') return actual.variants.every((v) => incompatible(v, expected));
  if (actual.kind === 'unknown') return false;
  const type =
    actual.kind === 'primitive'
      ? actual.type
      : actual.kind === 'literal'
        ? actual.value === null
          ? 'null'
          : typeof actual.value
        : actual.kind;
  return type !== expected.type;
}

export function fails(issue: Issue, threshold: 'confirmed' | 'high' | 'possible'): boolean {
  return (
    !issue.suppressed &&
    issue.severity === 'error' &&
    { CONFIRMED: 3, HIGH: 2, POSSIBLE: 1, UNKNOWN: 0 }[issue.confidence] >=
      { confirmed: 3, high: 2, possible: 1 }[threshold]
  );
}
