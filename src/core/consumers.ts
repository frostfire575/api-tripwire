import ts from 'typescript';
import { Project, prop, unwrap, name, walk, walkReturns } from '../ast/project.js';
import {
  object,
  unknown,
  type Config,
  type Consumer,
  type Diagnostic,
  type Shape,
} from './models.js';
import { methods } from '../adapters/routes.js';

interface Origin {
  consumer: Consumer;
  stage: 'response' | 'axios' | 'value' | 'query';
  keys: string[];
  guarded: boolean;
}

interface Client {
  kind: 'fetch' | 'axios' | 'ky' | 'configured';
  base?: string;
}

export function discoverConsumers(
  project: Project,
  config: Config,
  diagnostics: Diagnostic[],
): Consumer[] {
  const found = new Map<ts.Node, Consumer>();
  const warned = new Set<ts.Node>();
  const printer = ts.createPrinter({ removeComments: true });

  function warn(node: ts.Node, message: string): void {
    if (warned.has(node)) return;
    warned.add(node);
    diagnostics.push({
      code: 'unsupported-consumer',
      message,
      location: project.location(node),
      confidence: 'UNKNOWN',
    });
  }

  function client(node: ts.Node, seen = new Set<ts.Node>()): Client | undefined {
    if (seen.has(node)) return;
    seen.add(node);
    node = unwrap(node);
    if (ts.isIdentifier(node)) {
      const info = project.importInfo(node);
      if (info?.module === 'axios') return { kind: 'axios' };
      if (info?.module === 'ky') return { kind: 'ky' };
      if (node.text === 'fetch' && !project.declaration(node)) return { kind: 'fetch' };
      if (config.clients?.includes(node.text)) return { kind: 'configured' };
      const resolved = project.resolve(node);
      if (resolved !== node) return client(resolved, seen);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['create', 'extend'].includes(node.expression.name.text)
    ) {
      const parent = client(node.expression.expression, seen);
      if (!parent) return;
      return {
        ...parent,
        base: project.string(
          prop(node.arguments[0], parent.kind === 'axios' ? 'baseURL' : 'prefixUrl'),
        ),
      };
    }
    return;
  }

  function url(node: ts.Node | undefined, env: Map<ts.Node, ts.Node>): string | undefined {
    if (!node) return;
    node = unwrap(node);
    if (ts.isIdentifier(node)) {
      const d = project.declaration(node);
      if (d && env.has(d)) return url(env.get(d), new Map());
    }
    const value = project.string(node);
    if (value !== undefined) return value;
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans
          .map((span) => (url(span.expression, env) ?? ':dynamic') + span.literal.text)
          .join('')
      );
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = url(node.left, env);
      const right = url(node.right, env);
      if (left !== undefined) return left + (right ?? ':dynamic');
    }
    return;
  }

  function request(
    node: ts.CallExpression,
    env: Map<ts.Node, ts.Node>,
    site: ts.Node,
  ): Origin | undefined {
    let c = client(node.expression);
    let method = 'GET';
    let options: ts.Node | undefined;
    let bodyNode: ts.Node | undefined;
    if (!c && ts.isPropertyAccessExpression(node.expression)) {
      c = client(node.expression.expression);
      method = node.expression.name.text.toUpperCase();
      if (!methods.includes(method)) return;
    }
    if (!c) return;
    const first = node.arguments[0];
    const raw = url(first, env) ?? url(prop(first, 'url'), env);
    if (raw === undefined) {
      warn(node, 'Client URL or wrapper argument cannot be resolved statically');
      return;
    }
    options = ts.isObjectLiteralExpression(first ?? node) ? first : node.arguments[1];
    method = (project.string(prop(options, 'method')) ?? method).toUpperCase();
    if (c.kind === 'axios' && ['POST', 'PUT', 'PATCH'].includes(method)) {
      bodyNode = node.arguments[1];
      options = node.arguments[2];
    } else
      bodyNode = prop(options, c.kind === 'ky' ? 'json' : c.kind === 'axios' ? 'data' : 'body');
    if (
      bodyNode &&
      ts.isCallExpression(bodyNode) &&
      bodyNode.expression.getText() === 'JSON.stringify' &&
      ts.isPropertyAccessExpression(bodyNode.expression) &&
      ts.isIdentifier(bodyNode.expression.expression) &&
      !project.declaration(bodyNode.expression.expression)
    )
      bodyNode = bodyNode.arguments[0];
    let routePath = raw;
    if (c.base) {
      if (/^https?:\/\//.test(c.base)) {
        try {
          const base = new URL(c.base);
          const full = new URL(
            /^https?:\/\//.test(raw)
              ? raw
              : raw.startsWith('/')
                ? new URL(raw, base).href
                : c.base.replace(/\/$/, '') + '/' + raw,
          );
          if (full.origin === base.origin) routePath = full.pathname + full.search;
        } catch {
          warn(node, 'Client base URL could not be normalized');
        }
      } else routePath = c.base.replace(/\/$/, '') + '/' + raw.replace(/^\//, '');
    }
    const query = object();
    const queryString = routePath.split('?')[1];
    if (queryString)
      for (const [key, value] of new URLSearchParams(queryString))
        query.properties[key] = { shape: { kind: 'literal', value }, optional: false };
    const params = project.shape(prop(options, c.kind === 'ky' ? 'searchParams' : 'params'));
    if (params.kind === 'object') Object.assign(query.properties, params.properties);
    const key = site === node ? node : site;
    let consumer = found.get(key);
    if (!consumer) {
      const location = project.location(key);
      consumer = {
        id: `${location.file}:${location.line}:${location.column}`,
        method,
        path: routePath,
        client: c.kind,
        location,
        accesses: [],
        body: bodyNode ? project.shape(bodyNode) : object(),
        query,
        matchedRouteIds: [],
      };
      found.set(key, consumer);
    }
    return {
      consumer,
      stage: c.kind === 'axios' ? 'axios' : c.kind === 'fetch' ? 'response' : 'value',
      keys: [],
      guarded: false,
    };
  }

  function origin(
    node: ts.Node,
    seen = new Set<ts.Node>(),
    env = new Map<ts.Node, ts.Node>(),
    site?: ts.Node,
  ): Origin | undefined {
    node = unwrap(node);
    if (seen.has(node) || seen.size > 40) {
      warn(node, 'Cyclic or deep client wrapper');
      return;
    }
    const next = new Set(seen).add(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const source = origin(node.expression, next, env, site);
      if (!source) return;
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isNumericLiteral(node.argumentExpression)
          ? '[]'
          : (project.string(node.argumentExpression) ?? '?');
      if (source.stage === 'axios' || source.stage === 'query')
        return key === 'data'
          ? { ...source, stage: 'value', guarded: source.guarded || !!node.questionDotToken }
          : undefined;
      if (source.stage !== 'value') return;
      return {
        ...source,
        keys: [...source.keys, key],
        guarded: source.guarded || !!node.questionDotToken,
      };
    }
    if (ts.isIdentifier(node)) {
      const d = project.declaration(node);
      if (d && env.has(d)) return origin(env.get(d)!, next, new Map(), site);
      if (d && ts.isBindingElement(d)) {
        const pattern = d.parent;
        const parent = pattern.parent;
        let source: Origin | undefined;
        if (ts.isVariableDeclaration(parent) && parent.initializer)
          source = origin(parent.initializer, next, env, site);
        if (source) {
          const key = name(d.propertyName ?? d.name);
          if (!key) return;
          if (source.stage === 'axios' || source.stage === 'query')
            return key === 'data' ? { ...source, stage: 'value' } : undefined;
          return {
            ...source,
            keys: [...source.keys, key],
            guarded: source.guarded || !!d.initializer,
          };
        }
      }
      if (d && ts.isParameter(d)) {
        const fn = d.parent;
        const parent = fn.parent;
        if (
          ts.isCallExpression(parent) &&
          ts.isPropertyAccessExpression(parent.expression) &&
          parent.expression.name.text === 'then'
        )
          return origin(parent.expression.expression, next, env, site);
      }
      const resolved = project.resolve(node);
      if (resolved !== node) return origin(resolved, next, env, site);
      return;
    }
    if (ts.isCallExpression(node)) {
      const direct = request(node, env, site ?? node);
      if (direct) return direct;
      if (ts.isPropertyAccessExpression(node.expression)) {
        const operation = node.expression.name.text;
        const source = origin(node.expression.expression, next, env, site);
        if (source && operation === 'json' && ['response', 'value'].includes(source.stage))
          return { ...source, stage: 'value' };
        if (source && operation === 'then') {
          const callback = node.arguments[0];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            if (!ts.isBlock(callback.body)) return origin(callback.body, next, env, site);
            const returns: ts.ReturnStatement[] = [];
            walkReturns(callback.body, (r) => returns.push(r));
            if (returns.length === 1 && returns[0]!.expression)
              return origin(returns[0]!.expression!, next, env, site);
          }
        }
      }
      if (ts.isIdentifier(node.expression)) {
        const info = project.importInfo(node.expression);
        if (
          info?.module === '@tanstack/react-query' &&
          ['useQuery', 'useSuspenseQuery'].includes(info.exported)
        ) {
          const queryFn = prop(node.arguments[0], 'queryFn');
          if (queryFn) {
            const resolved = project.resolve(queryFn);
            if (ts.isArrowFunction(resolved) || ts.isFunctionExpression(resolved)) {
              const body = !ts.isBlock(resolved.body)
                ? resolved.body
                : resolved.body.statements.find(ts.isReturnStatement)?.expression;
              const source = body && origin(body, next, env);
              if (source) return { ...source, stage: 'query' };
            }
          }
        }
      }
      const fn = project.resolve(node.expression);
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) {
        const bound = new Map(env);
        fn.parameters.forEach((p, i) => {
          if (node.arguments[i]) bound.set(p, node.arguments[i]!);
        });
        if (fn.body && !ts.isBlock(fn.body)) return origin(fn.body, next, bound, site ?? node);
        if (fn.body) {
          const returns: ts.ReturnStatement[] = [];
          walkReturns(fn.body, (r) => returns.push(r));
          if (returns.length === 1 && returns[0]!.expression)
            return origin(returns[0]!.expression!, next, bound, site ?? node);
          let hasClient = false;
          walk(fn.body, (child) => {
            if (
              ts.isCallExpression(child) &&
              (client(child.expression) ||
                (ts.isPropertyAccessExpression(child.expression) &&
                  client(child.expression.expression)))
            )
              hasClient = true;
          });
          if (hasClient)
            warn(node, 'Client wrapper has multiple return paths or unsupported transformations');
        }
      }
    }
    return;
  }

  function addAccess(node: ts.Node, source: Origin | undefined): void {
    if (!source || source.stage !== 'value' || !source.keys.length || source.keys.includes('?'))
      return;
    let guarded = source.guarded;
    let ancestor: ts.Node | undefined = node.parent;
    while (ancestor && !ts.isFunctionLike(ancestor)) {
      if (
        ts.isIfStatement(ancestor) &&
        ancestor.thenStatement.pos <= node.pos &&
        node.end <= ancestor.thenStatement.end
      )
        guarded = true;
      if (
        ts.isBinaryExpression(ancestor) &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(
          ancestor.operatorToken.kind,
        )
      )
        guarded = true;
      ancestor = ancestor.parent;
    }
    const location = project.location(node);
    const field = source.keys.join('.');
    if (
      !source.consumer.accesses.some(
        (a) =>
          a.path === field &&
          a.location.line === location.line &&
          a.location.column === location.column,
      )
    )
      source.consumer.accesses.push({
        path: field,
        guarded,
        location,
        context: printer
          .printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
          .replace(/\s+/g, ''),
      });
  }

  for (const file of project.files.values())
    walk(file, (node) => {
      if (ts.isCallExpression(node)) {
        origin(node);
        if (ts.isPropertyAccessExpression(node.expression))
          addAccess(node.expression.expression, origin(node.expression.expression));
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        if (
          (ts.isPropertyAccessExpression(node.parent) ||
            ts.isElementAccessExpression(node.parent)) &&
          node.parent.expression === node
        )
          return;
        if (ts.isCallExpression(node.parent) && node.parent.expression === node) return;
        addAccess(node, origin(node));
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      )
        for (const binding of node.name.elements)
          if (ts.isIdentifier(binding.name)) addAccess(binding, origin(binding.name));
    });
  // Collapse duplicate observations at one site without hiding distinct consumer accesses.
  return [...found.values()].sort(
    (a, b) =>
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line ||
      a.location.column - b.location.column,
  );
}

export function shapeAt(shape: Shape, key: string): Shape {
  return shape.kind === 'object'
    ? (shape.properties[key]?.shape ?? unknown('missing'))
    : unknown('not an object');
}
