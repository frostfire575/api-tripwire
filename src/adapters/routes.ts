import ts from 'typescript';
import path from 'node:path';
import { Project, walk, unwrap, prop, chain, name, union } from '../ast/project.js';
import {
  unknown,
  type Route,
  type Diagnostic,
  type ResponseVariant,
  type RequestField,
} from '../core/models.js';

export const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export const normalizePath = (value: string): string =>
  '/' + value.split('?')[0]!.split('/').filter(Boolean).join('/');

type Handler = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function isHandler(n: ts.Node): n is Handler {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}

interface Instance {
  node: ts.Node;
  framework: string;
}

interface Mount {
  parent: Instance;
  child: Instance;
  prefix: string;
}

export function discoverRoutes(project: Project, diagnostics: Diagnostic[]): Route[] {
  const instances = new Map<ts.Node, Instance>();
  const mounts: Mount[] = [];
  const blockedMounts = new Set<Instance>();
  const pending: {
    instance: Instance;
    method: string;
    path: string;
    handler: ts.Node;
    node: ts.Node;
  }[] = [];

  const diagnostic = (code: string, message: string, node: ts.Node): void => {
    diagnostics.push({ code, message, location: project.location(node), confidence: 'UNKNOWN' });
  };

  function instance(node: ts.Node): Instance | undefined {
    const resolved = project.resolve(node);
    if (instances.has(resolved)) return instances.get(resolved);
    if (ts.isIdentifier(resolved)) {
      const d = project.declaration(resolved);
      if (d && instances.has(d)) return instances.get(d);
    }
    if (!ts.isCallExpression(resolved) && !ts.isNewExpression(resolved)) return;
    const origin = chain(resolved.expression).base;
    if (!ts.isIdentifier(origin)) return;
    const info = project.importInfo(origin);
    if (!info) return;
    const members = chain(resolved.expression).keys;
    if (members.length && !(info.module === 'express' && members.join('.') === 'Router')) return;
    const framework =
      info.module === 'express'
        ? 'express'
        : info.module === 'fastify'
          ? 'fastify'
          : info.module === 'hono'
            ? 'hono'
            : undefined;
    if (!framework) return;
    const out = { node: resolved, framework };
    instances.set(resolved, out);
    return out;
  }

  // Register plugin parameters before collecting calls inside their bodies.
  for (const file of project.files.values())
    walk(file, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== 'register'
      )
        return;
      const parent = instance(node.expression.expression);
      const fn = node.arguments[0] && project.resolve(node.arguments[0]);
      if (parent?.framework !== 'fastify' || !fn || !isHandler(fn) || !fn.parameters[0]) return;
      const child = { node: fn.parameters[0], framework: 'fastify' };
      instances.set(child.node, child);
      const prefixNode = prop(node.arguments[1], 'prefix');
      const prefix = prefixNode ? project.string(prefixNode) : '';
      if (prefix === undefined) {
        blockedMounts.add(child);
        diagnostic('dynamic-mount', 'Fastify plugin prefix is not static', node);
      } else mounts.push({ parent, child, prefix });
    });
  for (const file of project.files.values())
    walk(file, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const target = instance(node.expression.expression);
      if (!target) return;
      const operation = node.expression.name.text;
      if (
        (operation === 'use' && target.framework === 'express') ||
        (operation === 'route' && target.framework === 'hono')
      ) {
        const rootChild =
          node.arguments.length === 1 && node.arguments[0]
            ? instance(node.arguments[0])
            : undefined;
        const prefix = rootChild ? '' : project.string(node.arguments[0]);
        const child = rootChild || (node.arguments[1] && instance(node.arguments[1]));
        if (child && prefix !== undefined) mounts.push({ parent: target, child, prefix });
        else if (child || prefix === undefined) {
          if (child) blockedMounts.add(child);
          diagnostic('dynamic-mount', 'Mount cannot be resolved statically', node);
        }
        return;
      }
      if (operation === 'route' && target.framework === 'fastify') {
        const options = node.arguments[0] && project.resolve(node.arguments[0]);
        const url = project.string(prop(options, 'url'));
        const methodNode = prop(options, 'method');
        const handler = prop(options, 'handler');
        const values =
          methodNode && ts.isArrayLiteralExpression(methodNode)
            ? methodNode.elements.map((n) => project.string(n))
            : [project.string(methodNode)];
        if (url && handler && values.every((v) => v && methods.includes(v.toUpperCase())))
          for (const method of values)
            pending.push({
              instance: target,
              method: method!.toUpperCase(),
              path: url,
              handler,
              node,
            });
        else
          diagnostic(
            'unsupported-route',
            'Fastify route object requires static method, url and handler',
            node,
          );
        return;
      }
      if (!methods.includes(operation.toUpperCase()) && operation !== 'all') return;
      const routePath = project.string(node.arguments[0]);
      const handler = node.arguments.at(-1);
      if (routePath === undefined || !handler) {
        diagnostic('unsupported-route', 'Route path or handler is not static', node);
        return;
      }
      for (const method of operation === 'all' ? methods : [operation.toUpperCase()])
        pending.push({ instance: target, method, path: routePath, handler, node });
    });

  const prefixes = (target: Instance, seen = new Set<Instance>()): string[] => {
    if (blockedMounts.has(target)) return [];
    if (seen.has(target)) {
      diagnostic('mount-cycle', 'Cyclic framework mounts', target.node);
      return [];
    }
    const parents = mounts.filter((m) => m.child === target);
    if (!parents.length) return [''];
    return parents.flatMap((m) =>
      prefixes(m.parent, new Set(seen).add(target)).map((p) => p + '/' + m.prefix),
    );
  };

  const routes: Route[] = [];

  function add(
    method: string,
    routePath: string,
    framework: string,
    handler: ts.Node,
    source: ts.Node,
  ): void {
    const fn = project.resolve(handler);
    const location = project.location(source);
    const route: Route = {
      id: `${method} ${normalizePath(routePath)} @ ${location.file}:${location.line}`,
      method,
      path: normalizePath(routePath),
      framework,
      location,
      responses: [],
      request: [],
      fingerprint: '',
    };
    if (isHandler(fn)) analyzeHandler(project, fn, route, diagnostics);
    else
      diagnostic(
        'unresolved-handler',
        'Handler reference or wrapper could not be resolved',
        handler,
      );
    if (!route.responses.length)
      route.responses.push({
        status: null,
        shape: unknown('no statically recognized JSON response'),
        evidence: [],
      });
    routes.push(route);
  }

  for (const item of pending)
    for (const prefix of prefixes(item.instance))
      add(item.method, prefix + '/' + item.path, item.instance.framework, item.handler, item.node);
  for (const file of project.files.values()) {
    const relative = path.relative(project.root, file.fileName).replaceAll('\\', '/');
    const app = relative.match(/(?:^|\/)app\/(.*\/)?route\.[jt]sx?$/);
    const pages = relative.match(/(?:^|\/)pages\/api\/(.*)\.[jt]sx?$/);

    const url = (parts: string): string =>
      '/' +
      parts
        .split('/')
        .filter((p) => p && !/^\(.*\)$/.test(p) && !p.startsWith('@'))
        .map((p) => p.replace(/^\[\[?\.\.\.(.*?)\]\]?$/, '*$1').replace(/^\[(.*?)\]$/, ':$1'))
        .join('/');

    if (app)
      for (const statement of file.statements) {
        if (
          !ts.canHaveModifiers(statement) ||
          !ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        )
          continue;
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.name &&
          methods.includes(statement.name.text)
        )
          add(statement.name.text, url(app[1] ?? ''), 'next-app', statement, statement);
        if (ts.isVariableStatement(statement))
          for (const d of statement.declarationList.declarations)
            if (ts.isIdentifier(d.name) && methods.includes(d.name.text) && d.initializer)
              add(d.name.text, url(app[1] ?? ''), 'next-app', d.initializer, d);
      }
    if (pages)
      for (const statement of file.statements) {
        const handler = ts.isExportAssignment(statement)
          ? statement.expression
          : ts.isFunctionDeclaration(statement) &&
              statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
            ? statement
            : undefined;
        if (!handler) continue;
        const fn = project.resolve(handler);
        const recognized = new Set<string>();
        if (isHandler(fn))
          walk(fn, (node) => {
            if (
              ts.isBinaryExpression(node) &&
              ['===', '=='].includes(node.operatorToken.getText()) &&
              ts.isPropertyAccessExpression(node.left) &&
              node.left.name.text === 'method'
            ) {
              const m = project.string(node.right);
              if (m && methods.includes(m)) recognized.add(m);
            }
          });
        if (!recognized.size)
          diagnostic(
            'pages-method',
            'Pages API handler needs a recognizable request.method branch',
            handler,
          );
        for (const method of recognized)
          add(
            method,
            '/api' + url(pages[1]!.replace(/(?:^|\/)index$/, '')),
            'next-pages',
            handler,
            statement,
          );
      }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function analyzeHandler(
  project: Project,
  fn: Handler,
  route: Route,
  diagnostics: Diagnostic[],
): void {
  if (!fn.body) return;
  const request = fn.parameters[0];
  const response = route.framework === 'hono' ? request : fn.parameters[1];

  const refers = (node: ts.Node, param: ts.ParameterDeclaration | undefined): boolean =>
    ts.isIdentifier(node) && !!param && project.declaration(node) === param;

  let separateStatus = false;
  walk(fn.body, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['status', 'code'].includes(node.expression.name.text) &&
      refers(node.expression.expression, response) &&
      !ts.isPropertyAccessExpression(node.parent)
    )
      separateStatus = true;
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'statusCode' &&
      refers(node.left.expression, response)
    )
      separateStatus = true;
  });

  const addRequest = (
    source: RequestField['source'],
    field: string,
    node: ts.Node,
    required = false,
  ): void => {
    if (!field || field.includes('?')) return;
    const previous = route.request.find((r) => r.source === source && r.path === field);
    if (previous) {
      previous.required ||= required;
      return;
    }
    route.request.push({
      source,
      path: field,
      required,
      shape: unknown('request usage has no runtime type proof'),
      evidence: [
        {
          message: required
            ? 'Explicit rejection guard'
            : 'Request usage; presence is not proven required',
          location: project.location(node),
        },
      ],
    });
  };

  function reqPath(
    node: ts.Node,
    seen = new Set<ts.Node>(),
  ): { source: RequestField['source']; keys: string[] } | undefined {
    if (seen.has(node) || seen.size > 20) return;
    seen.add(node);
    const c = chain(node);
    if (refers(c.base, request) && ['body', 'query', 'params'].includes(c.keys[0] ?? ''))
      return { source: c.keys[0] as RequestField['source'], keys: c.keys.slice(1) };
    if (ts.isIdentifier(c.base)) {
      const d = project.declaration(c.base);
      if (d && ts.isVariableDeclaration(d) && d.initializer) {
        const origin = reqPath(d.initializer, seen);
        if (origin) return { ...origin, keys: [...origin.keys, ...c.keys] };
      }
      if (
        d &&
        ts.isBindingElement(d) &&
        ts.isVariableDeclaration(d.parent.parent) &&
        d.parent.parent.initializer
      ) {
        const origin = reqPath(d.parent.parent.initializer, seen);
        const key = name(d.propertyName ?? d.name);
        if (origin && key) return { ...origin, keys: [...origin.keys, key, ...c.keys] };
      }
    }
    const base = unwrap(c.base);
    if (
      ts.isCallExpression(base) &&
      ts.isPropertyAccessExpression(base.expression) &&
      base.expression.name.text === 'json' &&
      refers(base.expression.expression, request)
    )
      return { source: 'body', keys: c.keys };
    if (
      route.framework === 'hono' &&
      ts.isCallExpression(base) &&
      ts.isPropertyAccessExpression(base.expression)
    ) {
      const receiver = chain(base.expression.expression);
      const method = base.expression.name.text;
      if (
        refers(receiver.base, request) &&
        receiver.keys.join('.') === 'req' &&
        ['json', 'query', 'param'].includes(method)
      ) {
        const key = project.string(base.arguments[0]);
        return {
          source: method === 'json' ? 'body' : method === 'query' ? 'query' : 'params',
          keys: [...(key ? [key] : []), ...c.keys],
        };
      }
    }
    return;
  }

  function responseCall(node: ts.CallExpression): ResponseVariant | undefined {
    if (
      !ts.isPropertyAccessExpression(node.expression) ||
      !['json', 'send'].includes(node.expression.name.text)
    )
      return;
    let receiver: ts.Node = node.expression.expression;
    let status: number | null = separateStatus ? null : 200;
    if (
      ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      ['status', 'code'].includes(receiver.expression.name.text)
    ) {
      const code = receiver.arguments[0] && project.shape(receiver.arguments[0]);
      status = code?.kind === 'literal' && typeof code.value === 'number' ? code.value : null;
      receiver = receiver.expression.expression;
    }
    let recognized = refers(receiver, response);
    if (route.framework === 'next-app' && ts.isIdentifier(receiver)) {
      const info = project.importInfo(receiver);
      recognized =
        (receiver.text === 'Response' && !project.declaration(receiver)) ||
        (info?.module === 'next/server' && info.exported === 'NextResponse');
      const option = prop(node.arguments[1], 'status');
      if (option) {
        const s = project.shape(option);
        status = s.kind === 'literal' && typeof s.value === 'number' ? s.value : null;
      }
    }
    if (route.framework === 'hono' && node.arguments[1]) {
      const s = project.shape(node.arguments[1]);
      status = s.kind === 'literal' && typeof s.value === 'number' ? s.value : null;
    }
    if (!recognized) return;
    return {
      status,
      shape: project.shape(node.arguments[0]),
      evidence: [
        {
          message: `Static ${node.expression.name.text} response`,
          location: project.location(node),
        },
      ],
    };
  }

  function visit(node: ts.Node): void {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (
      route.framework === 'next-pages' &&
      ts.isIfStatement(node) &&
      ts.isBinaryExpression(node.expression)
    ) {
      const e = node.expression;
      const c = chain(e.left);
      const method = project.string(e.right);
      if (
        refers(c.base, request) &&
        c.keys.join('.') === 'method' &&
        method &&
        ['===', '=='].includes(e.operatorToken.getText())
      ) {
        if (method === route.method) visit(node.thenStatement);
        else if (node.elseStatement) visit(node.elseStatement);
        return;
      }
    }
    if (ts.isCallExpression(node)) {
      const variant = responseCall(node);
      if (variant) route.responses.push(variant);
      const p = reqPath(node);
      if (p) addRequest(p.source, p.keys.join('.'), node);
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const expr = unwrap(node.expression);
      let recognized = false;
      walk(expr, (child) => {
        if (ts.isCallExpression(child) && responseCall(child)) recognized = true;
      });
      if (!recognized && !refers(expr, response))
        route.responses.push({
          status: null,
          shape: unknown('unresolved handler return branch'),
          evidence: [
            {
              message: 'Handler returns a value outside a recognized JSON response',
              location: project.location(node),
            },
          ],
        });
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const p = reqPath(node);
      if (p) addRequest(p.source, p.keys.join('.'), node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const p = reqPath(node.initializer);
      if (p)
        for (const binding of node.name.elements) {
          const key = name(binding.propertyName ?? binding.name);
          if (key) addRequest(p.source, [...p.keys, key].join('.'), binding);
        }
    }
    if (
      ts.isIfStatement(node) &&
      ts.isPrefixUnaryExpression(node.expression) &&
      node.expression.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const p = reqPath(node.expression.operand);
      let rejects = false;
      walk(node.thenStatement, (child) => {
        if (ts.isThrowStatement(child)) rejects = true;
        if (
          ts.isReturnStatement(child) &&
          child.expression &&
          ts.isCallExpression(child.expression)
        ) {
          const r = responseCall(child.expression);
          if (r?.status && r.status >= 400) rejects = true;
        }
      });
      if (p && rejects) addRequest(p.source, p.keys.join('.'), node.expression, true);
    }
    if (
      ts.isIfStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(
        node.expression.operatorToken.kind,
      ) &&
      ts.isTypeOfExpression(node.expression.left)
    ) {
      const p = reqPath(node.expression.left.expression);
      const type = project.string(node.expression.right);
      let rejects = false;
      walk(node.thenStatement, (child) => {
        if (ts.isThrowStatement(child)) rejects = true;
        if (
          ts.isReturnStatement(child) &&
          child.expression &&
          ts.isCallExpression(child.expression)
        ) {
          const r = responseCall(child.expression);
          if (r?.status && r.status >= 400) rejects = true;
        }
      });
      if (p && rejects && ['string', 'number', 'boolean'].includes(type ?? '')) {
        addRequest(p.source, p.keys.join('.'), node.expression, true);
        const field = route.request.find(
          (r) => r.source === p.source && r.path === p.keys.join('.'),
        );
        if (field)
          field.shape = { kind: 'primitive', type: type as 'string' | 'number' | 'boolean' };
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(fn.body);
  // Implicit expression bodies and direct helper returns are resolved statically by shape inference.
  if (route.responses.some((r) => r.shape.kind === 'unknown'))
    diagnostics.push({
      code: 'partial-response',
      message: `Some response structures for ${route.method} ${route.path} are unknown`,
      location: route.location,
      confidence: 'UNKNOWN',
    });
  route.request.sort((a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path));
  route.responses = [
    ...new Map(route.responses.map((r) => [JSON.stringify([r.status, r.shape]), r])).values(),
  ];
  for (const r of route.responses) if (r.shape.kind === 'union') r.shape = union(r.shape.variants);
}
