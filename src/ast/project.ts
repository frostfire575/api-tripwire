import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { object, unknown, type Shape, type Location } from '../core/models.js';

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function unwrap(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node)
  )
    node = node.expression;
  return node;
}

export function prop(node: ts.Node | undefined, key: string): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return;
  return node.properties.filter(ts.isPropertyAssignment).find((p) => name(p.name) === key)
    ?.initializer;
}

export function name(node: ts.Node): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined;
}

export function textLiteral(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

export function chain(node: ts.Node): { base: ts.Node; keys: string[]; guarded: boolean } {
  node = unwrap(node);
  const keys: string[] = [];
  let guarded = false;
  while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    guarded ||= !!node.questionDotToken;
    keys.unshift(
      ts.isPropertyAccessExpression(node)
        ? node.name.text
        : (textLiteral(node.argumentExpression) ??
            (ts.isNumericLiteral(node.argumentExpression) ? '[]' : '?')),
    );
    node = unwrap(node.expression);
  }
  return { base: node, keys, guarded };
}

export class Project {
  files = new Map<string, ts.SourceFile>();
  private shapes = new Map<ts.Node, Shape>();
  private declarations = new Map<ts.Identifier, ts.Node | null>();
  private writes = new Map<ts.Node, ts.BinaryExpression[]>();
  private indexedWrites = new Set<ts.SourceFile>();
  private checker?: ts.TypeChecker;

  constructor(
    readonly root: string,
    paths: string[],
  ) {
    for (const file of paths) this.parse(file);
  }

  parse(file: string): ts.SourceFile | undefined {
    file = path.resolve(file);
    const relative = path.relative(this.root, file).replaceAll('\\', '/');
    if (
      relative.startsWith('../') ||
      path.isAbsolute(relative) ||
      /(?:^|\/)(?:node_modules|dist|build|coverage|\.git|\.next|\.api-tripwire)(?:\/|$)/.test(
        relative,
      )
    )
      return;
    if (this.files.has(file)) return this.files.get(file);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    this.files.set(file, source);
    return source;
  }

  location(node: ts.Node): Location {
    const file = node.getSourceFile();
    const pos = file.getLineAndCharacterOfPosition(node.getStart(file));
    return {
      file: path.relative(this.root, file.fileName).replaceAll('\\', '/'),
      line: pos.line + 1,
      column: pos.character + 1,
    };
  }

  declaration(id: ts.Identifier): ts.Node | undefined {
    if (this.declarations.has(id)) return this.declarations.get(id) ?? undefined;
    let scope: ts.Node | undefined = id.parent;
    while (scope) {
      if (
        ts.isBlock(scope) ||
        ts.isSourceFile(scope) ||
        ts.isFunctionLike(scope) ||
        ts.isCatchClause(scope)
      ) {
        let found: ts.Node | undefined;

        const search = (n: ts.Node): void => {
          if (n !== scope && (ts.isFunctionLike(n) || ts.isBlock(n))) {
            if (ts.isFunctionDeclaration(n) && n.name?.text === id.text) found = n;
            return;
          }
          if (
            (ts.isVariableDeclaration(n) ||
              ts.isParameter(n) ||
              ts.isBindingElement(n) ||
              ts.isImportSpecifier(n) ||
              ts.isImportClause(n) ||
              ts.isNamespaceImport(n) ||
              ts.isFunctionDeclaration(n) ||
              ts.isClassDeclaration(n)) &&
            n.name &&
            ts.isIdentifier(n.name) &&
            n.name.text === id.text
          )
            found = n;
          ts.forEachChild(n, search);
        };

        search(scope);
        if (found) {
          this.declarations.set(id, found);
          return found;
        }
      }
      scope = scope.parent;
    }
    this.declarations.set(id, null);
    return;
  }

  importInfo(
    id: ts.Identifier,
  ): { module: string; exported: string; declaration: ts.Node } | undefined {
    const decl = this.declaration(id);
    if (!decl) return;
    let n: ts.Node | undefined = decl;
    while (n && !ts.isImportDeclaration(n)) n = n.parent;
    if (n && ts.isStringLiteral(n.moduleSpecifier))
      return {
        module: n.moduleSpecifier.text,
        exported: ts.isImportSpecifier(decl) ? (decl.propertyName ?? decl.name).text : 'default',
        declaration: decl,
      };
  }

  private assignedValue(
    id: ts.Identifier,
    declaration: ts.Node,
  ): { uncertain: boolean; value?: ts.Node } {
    const file = declaration.getSourceFile();
    if (!this.indexedWrites.has(file)) {
      this.indexedWrites.add(file);
      walk(file, (node) => {
        if (
          !ts.isBinaryExpression(node) ||
          node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
          node.operatorToken.kind > ts.SyntaxKind.LastAssignment
        )
          return;
        const base = chain(node.left).base;
        if (!ts.isIdentifier(base)) return;
        const target = this.declaration(base);
        if (target) this.writes.set(target, [...(this.writes.get(target) ?? []), node]);
      });
    }
    const writes = this.writes.get(declaration) ?? [];
    if (!writes.length) return { uncertain: false };

    const scope = (node: ts.Node): ts.Node => {
      while (node.parent && !ts.isBlock(node) && !ts.isSourceFile(node)) node = node.parent;
      return node;
    };

    const preceding = writes.filter((w) => w.end < id.pos);
    if (
      writes.some(
        (w) =>
          !ts.isIdentifier(w.left) ||
          w.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
          !ts.isExpressionStatement(w.parent) ||
          scope(w) !== scope(id),
      )
    )
      return { uncertain: true };
    return { uncertain: false, value: preceding.at(-1)?.right };
  }

  resolve(node: ts.Node, seen = new Set<ts.Node>()): ts.Node {
    node = unwrap(node);
    if (seen.has(node) || seen.size > 24) return node;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const decl = this.declaration(node);
      if (decl) {
        const assigned = this.assignedValue(node, decl);
        if (assigned.uncertain) return node;
        if (assigned.value) return this.resolve(assigned.value, seen);
      }
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
        return this.resolve(decl.initializer, seen);
      if (decl && ts.isFunctionDeclaration(decl)) return decl;
      const info = this.importInfo(node);
      if (info?.module.startsWith('.')) {
        const base = path.resolve(path.dirname(node.getSourceFile().fileName), info.module);
        const bases = [base, base.replace(/\.[cm]?jsx?$/, '')];
        for (const b of bases)
          for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
            const file = this.parse(b + suffix);
            if (!file) continue;
            for (const statement of file.statements) {
              if (info.exported === 'default' && ts.isExportAssignment(statement))
                return this.resolve(statement.expression, seen);
              if (
                ts.isFunctionDeclaration(statement) &&
                (statement.name?.text === info.exported ||
                  (info.exported === 'default' &&
                    statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)))
              )
                return statement;
              if (ts.isVariableStatement(statement))
                for (const d of statement.declarationList.declarations)
                  if (name(d.name) === info.exported && d.initializer)
                    return this.resolve(d.initializer, seen);
            }
          }
      }
    }
    if (ts.isCallExpression(node)) {
      const fn = this.resolve(node.expression, seen);
      if (
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) &&
        fn.body
      ) {
        const returns: ts.ReturnStatement[] = [];
        if (ts.isBlock(fn.body)) walkReturns(fn.body, (r) => returns.push(r));
        const returned = ts.isBlock(fn.body)
          ? returns.length === 1
            ? returns[0]!.expression
            : undefined
          : fn.body;
        if (returned && ts.isIdentifier(returned)) {
          const declaration = this.declaration(returned);
          const index = fn.parameters.findIndex((p) => p === declaration);
          if (index >= 0 && node.arguments[index])
            return this.resolve(node.arguments[index]!, seen);
        }
        if (returned && (ts.isArrowFunction(returned) || ts.isFunctionExpression(returned)))
          return returned;
      }
    }
    return node;
  }

  string(node: ts.Node | undefined): string | undefined {
    return node ? textLiteral(this.resolve(node)) : undefined;
  }

  shape(
    node: ts.Node | undefined,
    seen = new Set<ts.Node>(),
    env = new Map<ts.Node, ts.Node>(),
  ): Shape {
    if (!node) return unknown('no value');
    node = unwrap(node);
    if (seen.has(node) || seen.size > 32) return unknown('cyclic or deep expression');
    if (!env.size && this.shapes.has(node)) return this.shapes.get(node)!;
    const next = new Set(seen).add(node);

    const infer = (n: ts.Node | undefined): Shape => this.shape(n, next, env);

    let result: Shape;
    if (ts.isIdentifier(node)) {
      const decl = this.declaration(node);
      if (decl && env.has(decl)) return infer(env.get(decl));
      const resolved = this.resolve(node);
      if (resolved !== node) return infer(resolved);
      if (node.text === 'undefined') return { kind: 'primitive', type: 'undefined' };
      if (decl && (ts.isParameter(decl) || ts.isVariableDeclaration(decl)) && decl.type)
        return this.typeShape(decl.type);
      return unknown(`unresolved value ${node.text}`);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      result = { kind: 'literal', value: node.text };
    else if (ts.isNumericLiteral(node)) result = { kind: 'literal', value: Number(node.text) };
    else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
      result = { kind: 'literal', value: node.kind === ts.SyntaxKind.TrueKeyword };
    else if (node.kind === ts.SyntaxKind.NullKeyword) result = { kind: 'literal', value: null };
    else if (ts.isTemplateExpression(node)) result = { kind: 'primitive', type: 'string' };
    else if (ts.isObjectLiteralExpression(node)) {
      const out = object();
      for (const p of node.properties) {
        if (ts.isSpreadAssignment(p)) {
          const spread = infer(p.expression);
          if (spread.kind !== 'object' || spread.open)
            for (const previous of Object.values(out.properties))
              previous.shape = unknown('later unknown spread may overwrite this value');
          if (spread.kind === 'object') {
            for (const [key, value] of Object.entries(spread.properties))
              out.properties[key] = { ...value };
            out.open ||= spread.open;
          } else out.open = true;
        } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
          const key = name(p.name);
          if (key)
            out.properties[key] = {
              shape: infer(ts.isPropertyAssignment(p) ? p.initializer : p.name),
              optional: false,
            };
          else out.open = true;
        } else out.open = true;
      }
      result = out;
    } else if (ts.isArrayLiteralExpression(node))
      result = { kind: 'array', element: union(node.elements.map(infer)) };
    else if (ts.isConditionalExpression(node))
      result = union([infer(node.whenTrue), infer(node.whenFalse)]);
    else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const { base, keys } = chain(node);
      result = infer(base);
      for (const key of keys)
        result =
          result.kind === 'object'
            ? (result.properties[key]?.shape ?? unknown(`unresolved property ${key}`))
            : result.kind === 'array' && key === '[]'
              ? result.element
              : unknown('unresolved property receiver');
    } else if (ts.isCallExpression(node)) {
      const fn = this.resolve(node.expression);
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) {
        const bound = new Map(env);
        fn.parameters.forEach((p, i) => {
          if (node.arguments[i]) bound.set(p, node.arguments[i]!);
        });
        const values: Shape[] = [];
        if (fn.body && !ts.isBlock(fn.body)) values.push(this.shape(fn.body, next, bound));
        else if (fn.body)
          walkReturns(fn.body, (r) => {
            if (r.expression) values.push(this.shape(r.expression, next, bound));
          });
        result = union(values);
      } else result = unknown('unresolved call or transformation');
    } else result = unknown(`unsupported ${ts.SyntaxKind[node.kind]}`);
    if (!env.size) this.shapes.set(node, result);
    return result;
  }

  typeShape(node: ts.TypeNode): Shape {
    if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: 'primitive', type: 'string' };
    if (node.kind === ts.SyntaxKind.NumberKeyword) return { kind: 'primitive', type: 'number' };
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: 'primitive', type: 'boolean' };
    if (ts.isArrayTypeNode(node))
      return { kind: 'array', element: this.typeShape(node.elementType) };
    if (ts.isUnionTypeNode(node)) return union(node.types.map((t) => this.typeShape(t)));
    if (ts.isLiteralTypeNode(node)) return this.shape(node.literal);
    if (ts.isTypeLiteralNode(node)) {
      const out = object();
      out.open = true;
      for (const m of node.members)
        if (ts.isPropertySignature(m) && m.type && name(m.name))
          out.properties[name(m.name)!] = {
            shape: this.typeShape(m.type),
            optional: !!m.questionToken,
          };
      return out;
    }
    if (!this.checker) {
      const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.Latest,
        noResolve: true,
        noLib: true,
        allowJs: true,
      };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = (file) => this.files.get(path.resolve(file));
      host.writeFile = () => {
        throw new Error('Analysis cannot emit application code');
      };
      this.checker = ts.createProgram([...this.files.keys()], options, host).getTypeChecker();
    }
    return this.enrichType(this.checker.getTypeFromTypeNode(node), new Set());
  }

  private enrichType(type: ts.Type, seen: Set<ts.Type>): Shape {
    if (seen.has(type) || seen.size > 12) return unknown('cyclic type');
    const next = new Set(seen).add(type);
    if (type.flags & ts.TypeFlags.StringLike) return { kind: 'primitive', type: 'string' };
    if (type.flags & ts.TypeFlags.NumberLike) return { kind: 'primitive', type: 'number' };
    if (type.flags & ts.TypeFlags.BooleanLike) return { kind: 'primitive', type: 'boolean' };
    if (type.isUnion()) return union(type.types.map((t) => this.enrichType(t, next)));
    if (type.flags & ts.TypeFlags.Object) {
      const out = object();
      out.open = true;
      for (const symbol of type.getProperties()) {
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (declaration)
          out.properties[symbol.name] = {
            shape: this.enrichType(
              this.checker!.getTypeOfSymbolAtLocation(symbol, declaration),
              next,
            ),
            optional: !!(symbol.flags & ts.SymbolFlags.Optional),
          };
      }
      return out;
    }
    return unknown('unresolved type annotation');
  }
}

export function walkReturns(node: ts.Node, visit: (node: ts.ReturnStatement) => void): void {
  if (ts.isReturnStatement(node)) visit(node);
  else if (!ts.isFunctionLike(node)) ts.forEachChild(node, (child) => walkReturns(child, visit));
}

export function union(shapes: Shape[]): Shape {
  const unique = [...new Map(shapes.map((s) => [JSON.stringify(s), s])).values()];
  return unique.length === 1
    ? unique[0]!
    : unique.length
      ? { kind: 'union', variants: unique }
      : unknown('empty or unresolved branches');
}
