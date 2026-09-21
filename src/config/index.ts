import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Config } from '../core/models.js';

export const configNames = [
  'api-tripwire.config.ts',
  'api-tripwire.config.js',
  '.api-tripwire.config.ts',
  '.api-tripwire.config.js',
];

export function projectRoot(input?: string): string {
  if (input) {
    const root = path.resolve(input);
    if (!fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
    return root;
  }
  let root = process.cwd();
  while (true) {
    if (
      fs.existsSync(path.join(root, 'package.json')) ||
      configNames.some((n) => fs.existsSync(path.join(root, n)))
    )
      return root;
    const parent = path.dirname(root);
    if (parent === root) return process.cwd();
    root = parent;
  }
}

export function readConfig(root: string): Config {
  const name = configNames.find((n) => fs.existsSync(path.join(root, n)));
  if (!name) return {};
  const file = ts.createSourceFile(
    name,
    fs.readFileSync(path.join(root, name), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  const fail = (): never => {
    throw new Error(
      `${name}: use only export default { ... } or defineConfig({ ... }) with literal values; configuration is never executed`,
    );
  };

  if (
    (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics
      ?.length
  )
    return fail();

  function literal(node: ts.Expression): unknown {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map((n) => literal(n));
    if (ts.isObjectLiteralExpression(node)) {
      const out: Record<string, unknown> = Object.create(null);
      for (const prop of node.properties) {
        if (
          !ts.isPropertyAssignment(prop) ||
          !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        )
          return fail();
        if (prop.name.text in out) return fail();
        out[prop.name.text] = literal(prop.initializer);
      }
      return out;
    }
    return fail();
  }

  let result: unknown;
  let imported = false;
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'api-tripwire' &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.every(
        (e) => e.name.text === 'defineConfig' && !e.propertyName,
      )
    ) {
      imported = true;
      continue;
    }
    if (!ts.isExportAssignment(statement) || statement.isExportEquals || result !== undefined)
      return fail();
    let expr = statement.expression;
    if (ts.isCallExpression(expr)) {
      if (
        !imported ||
        expr.expression.getText(file) !== 'defineConfig' ||
        expr.arguments.length !== 1
      )
        return fail();
      expr = expr.arguments[0]!;
    }
    result = literal(expr);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return fail();
  const record = result as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (['include', 'exclude', 'clients'].includes(key)) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return fail();
    } else if (key === 'confidence') {
      if (!['confirmed', 'high', 'possible'].includes(String(value))) return fail();
    } else throw new Error(`${name}: unknown option ${key}`);
  }
  return record as Config;
}

export function defineConfig(config: Config): Config {
  return config;
}
