export type Confidence = 'CONFIRMED' | 'HIGH' | 'POSSIBLE' | 'UNKNOWN';

export type Shape =
  | { kind: 'unknown'; reason: string }
  | { kind: 'primitive'; type: 'string' | 'number' | 'boolean' | 'null' | 'undefined' }
  | { kind: 'literal'; value: string | number | boolean | null }
  | {
      kind: 'object';
      properties: Record<string, { shape: Shape; optional: boolean }>;
      open: boolean;
    }
  | { kind: 'array'; element: Shape }
  | { kind: 'union'; variants: Shape[] };

export interface Location {
  file: string;
  line: number;
  column: number;
}

export interface Evidence {
  message: string;
  location: Location | null;
}

export interface ResponseVariant {
  status: number | null;
  shape: Shape;
  evidence: Evidence[];
}

export interface RequestField {
  source: 'body' | 'query' | 'params';
  path: string;
  required: boolean;
  shape: Shape;
  evidence: Evidence[];
}

export interface Route {
  id: string;
  method: string;
  path: string;
  framework: string;
  location: Location;
  responses: ResponseVariant[];
  request: RequestField[];
  fingerprint: string;
}

export interface Access {
  path: string;
  guarded: boolean;
  location: Location;
  context: string;
}

export interface Consumer {
  id: string;
  method: string;
  path: string;
  client: string;
  location: Location;
  accesses: Access[];
  body: Shape;
  query: Shape;
  matchedRouteIds: string[];
}

export interface Issue {
  id: string;
  kind: string;
  confidence: Confidence;
  severity: 'error' | 'warning';
  method: string;
  route: string;
  field: string | null;
  message: string;
  expected: Shape | null;
  actual: Shape | null;
  suggestion: string | null;
  consumer: Location | null;
  provider: Location | null;
  evidence: Evidence[];
  suppressed: boolean;
}

export interface Diagnostic {
  code: string;
  message: string;
  location: Location | null;
  confidence: 'UNKNOWN';
}

export interface Config {
  include?: string[];
  exclude?: string[];
  confidence?: 'confirmed' | 'high' | 'possible';
  clients?: string[];
}

export interface Report {
  schemaVersion: '1';
  root: string;
  summary: {
    files: number;
    routes: number;
    consumers: number;
    matched: number;
    issues: number;
    suppressed: number;
  };
  routes: Route[];
  consumers: Consumer[];
  issues: Issue[];
  diagnostics: Diagnostic[];
  coverage: {
    matched: number;
    unmatched: number;
    incompleteRoutes: number;
    status: 'analyzed' | 'partial' | 'unverified';
  };
  environment: { packageManager: string; languages: string[]; frameworks: string[] };
  confidence: 'confirmed' | 'high' | 'possible';
}

export const unknown = (reason: string): Shape => ({ kind: 'unknown', reason });

export const object = (): Extract<Shape, { kind: 'object' }> => ({
  kind: 'object',
  properties: {},
  open: false,
});
