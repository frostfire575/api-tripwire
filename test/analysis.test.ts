import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan } from '../src/core/scan.js';
import { baseline, applyBaseline, saveContracts, diffContracts } from '../src/core/persistence.js';
import { fails, fingerprint } from '../src/core/compare.js';
import { readConfig } from '../src/config/index.js';

const temporary: string[] = [];

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripwire-test-'));
  temporary.push(root);
  for (const [file, value] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
  }
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const server = (response: string, extra = ''): string =>
  `import express from 'express'; const app = express(); app.get('/api/users', (req, res) => { ${extra} res.json(${response}); });`;

const client = (access = 'user.userId', url = '/api/users'): string =>
  `async function load() { const user = await (await fetch('${url}')).json(); return ${access}; }`;

async function analyze(response = '{ id: 1 }', access = 'user.userId', extra = '') {
  return scan(project({ 'server.ts': server(response, extra), 'client.ts': client(access) }));
}

describe('framework fixtures', () => {
  for (const fixture of [
    'express',
    'fastify',
    'hono',
    'next-app',
    'next-pages',
    'axios',
    'ky',
    'tanstack',
  ])
    it(fixture, async () => {
      const report = await scan(path.resolve('fixtures', fixture));
      expect(report.summary.routes).toBeGreaterThan(0);
      expect(report.summary.matched).toBeGreaterThan(0);
      expect(report.issues).toEqual([]);
    });
});
it('confirms demo mismatch and suggests id', async () => {
  const r = await scan(path.resolve('examples/demo'));
  expect(r.issues).toHaveLength(1);
  expect(r.issues[0]).toMatchObject({
    confidence: 'CONFIRMED',
    field: 'userId',
    suggestion: 'Did you mean id?',
  });
});
it('reports highest missing ancestor', async () => {
  const r = await analyze('{ id: 1 }', 'user.profile.name');
  expect(r.issues[0]?.field).toBe('profile');
});
it('keeps known unknown-valued keys separate from open objects', async () => {
  const r = await analyze('{ id: database() }');
  expect(r.issues[0]?.confidence).toBe('CONFIRMED');
});
it('does not confirm absent fields behind unknown spreads', async () => {
  const r = await analyze('{ ...database(), id: 1 }');
  expect(r.issues).toEqual([]);
  expect(r.coverage.incompleteRoutes).toBe(1);
});
it('separates error responses', async () => {
  const r = await analyze(
    '{ id: 1 }',
    'user.id',
    `if (!req.query.token) return res.status(401).json({ error: 'no' });`,
  );
  expect(r.issues.filter((i) => i.kind.startsWith('response'))).toEqual([]);
});
it('reduces confidence for unknown status', async () => {
  const r = await scan(
    project({
      'server.ts': `import express from 'express'; const app = express(); app.get('/api/users', (req,res) => res.status(code).json({ id: 1 }));`,
      'client.ts': client(),
    }),
  );
  expect(r.issues[0]?.confidence).toBe('POSSIBLE');
});
it('compares conditional variants conservatively', async () => {
  const r = await analyze('flag ? { id: 1 } : { userId: 1 }');
  expect(r.issues[0]?.confidence).toBe('POSSIBLE');
});
it('guarded missing fields remain warnings', async () => {
  const r = await analyze('{ id: 1 }', 'user?.userId');
  expect(r.issues[0]?.severity).toBe('warning');
  expect(fails(r.issues[0]!, 'possible')).toBe(false);
});
it('destructuring request body alone is possible', async () => {
  const r = await analyze('{ id: 1 }', 'user.id', 'const { name } = req.body;');
  expect(r.issues[0]).toMatchObject({ confidence: 'POSSIBLE', field: 'body.name' });
});
it('explicit rejection establishes required body', async () => {
  const r = await analyze(
    '{ id: 1 }',
    'user.id',
    `if (!req.body.name) return res.status(400).json({ error: 'name' });`,
  );
  expect(r.issues.find((i) => i.field === 'body.name')).toMatchObject({ confidence: 'HIGH' });
});
it('ignores unrelated methods named get and json', async () => {
  const r = await scan(
    project({
      'code.ts': `const app = { get() {} }; app.get('/api/users', (req,res) => res.json({ id: 1 })); const user = unrelated.json(); user.userId;`,
    }),
  );
  expect(r.routes).toEqual([]);
  expect(r.consumers).toEqual([]);
});
it('respects shadowed fetch', async () => {
  const r = await scan(
    project({
      'server.ts': server('{ id: 1 }'),
      'client.ts': `function f(fetch) { return fetch('/api/users').json().userId; }`,
    }),
  );
  expect(r.consumers).toEqual([]);
});
it('respects shadowed framework identifiers', async () => {
  const r = await scan(
    project({
      'server.ts': `import express from 'express'; const app = express(); function f(app) { app.get('/fake', (req,res) => res.json({})); }`,
    }),
  );
  expect(r.routes).toEqual([]);
});
it('does not match external absolute URLs', async () => {
  const r = await scan(
    project({
      'server.ts': server('{ id: 1 }'),
      'client.ts': client('user.userId', 'https://external.test/api/users'),
    }),
  );
  expect(r.summary.matched).toBe(0);
  expect(r.coverage.status).toBe('unverified');
});
it('prefers literal routes', async () => {
  const r = await scan(
    project({
      'server.ts': `import express from 'express'; const app = express(); app.get('/api/:id',(req,res)=>res.json({ wrong: 1 })); app.get('/api/users',(req,res)=>res.json({ id: 1 }));`,
      'client.ts': client('user.id'),
    }),
  );
  expect(r.issues).toEqual([]);
  expect(r.summary.matched).toBe(1);
});
it('ambiguous routes never confirm', async () => {
  const r = await scan(
    project({
      'server.ts': server('{ id: 1 }') + `app.get('/api/users',(req,res)=>res.json({ id: 2 }));`,
      'client.ts': client(),
    }),
  );
  expect(r.issues[0]?.confidence).toBe('POSSIBLE');
  expect(r.diagnostics.some((d) => d.code === 'ambiguous-route')).toBe(true);
});
it('resolves imported handlers and local response helpers', async () => {
  const r = await scan(
    project({
      'server.ts': `import express from 'express'; import { handler } from './handler.js'; const app = express(); app.get('/api/users', handler);`,
      'handler.ts': `function value() { return { id: 1 }; } export function handler(req,res) { res.json(value()); }`,
      'client.ts': client(),
    }),
  );
  expect(r.issues[0]?.confidence).toBe('CONFIRMED');
});
it('traces simple client wrappers', async () => {
  const r = await scan(
    project({
      'server.ts': server('{ id: 1 }'),
      'client.ts': `const get = url => fetch(url).then(r => r.json()); async function load() { const user = await get('/api/users'); return user.userId; }`,
    }),
  );
  expect(r.issues.some((i) => i.field === 'userId')).toBe(true);
});
it('terminates wrapper cycles', async () => {
  const r = await scan(
    project({ 'client.ts': `function a() { return b(); } function b() { return a(); } a().id;` }),
  );
  expect(r.diagnostics.some((d) => d.message.includes('Cyclic'))).toBe(true);
});
it('ignores client type assertions as runtime evidence', async () => {
  const r = await scan(
    project({
      'server.ts': server('{ id: 1 }'),
      'client.ts': `async function f() { const user = await (await fetch('/api/users')).json() as {userId: string}; return user.userId; }`,
    }),
  );
  expect(r.issues[0]?.confidence).toBe('CONFIRMED');
});
it('keeps JSON deterministic', async () => {
  const root = project({ 'server.ts': server('{ id: 1 }'), 'client.ts': client() });
  expect(await scan(root)).toEqual(await scan(root));
});
it('baseline ids survive line shifts', async () => {
  const root = project({ 'server.ts': server('{ id: 1 }'), 'client.ts': client() });
  const first = await scan(root);
  baseline(first);
  fs.writeFileSync(path.join(root, 'client.ts'), '\n\n' + client());
  const second = await scan(root);
  applyBaseline(second);
  expect(second.summary.suppressed).toBe(1);
  expect(second.issues[0]?.id).toBe(first.issues[0]?.id);
});
it('rejects missing and malformed baseline', async () => {
  const r = await analyze();
  expect(() => applyBaseline(r)).toThrow('Cannot read');
  fs.writeFileSync(path.join(r.root, '.api-tripwire-baseline.json'), '{}');
  expect(() => applyBaseline(r)).toThrow('Malformed');
});
it('fingerprints ignore formatting and locations', async () => {
  const a = await analyze('{ id: 1, name: "Ada" }');
  const b = await analyze('{\n name: "Ada", id: 1\n}');
  expect(fingerprint(a.routes[0]!)).toBe(fingerprint(b.routes[0]!));
});
it('saved diff detects removal without modifying snapshot', async () => {
  const root = project({
    'server.ts': server('{ id: 1, name: "Ada" }'),
    'client.ts': client('user.name'),
  });
  const a = await scan(root);
  const file = saveContracts(a);
  const snapshot = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(path.join(root, 'server.ts'), server('{ id: 1 }'));
  const result = diffContracts(await scan(root));
  expect(result.changes.some((c) => c.kind === 'field-removed' && c.breaking)).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe(snapshot);
});
it('rejects malicious configuration without execution', () => {
  const root = project({
    'api-tripwire.config.ts': `export default (() => { throw new Error('executed'); })()`,
  });
  expect(() => readConfig(root)).toThrow('literal');
});
it('rejects getters and dynamic imports in config', () => {
  for (const source of [
    `export default { get confidence() { return 'high' } }`,
    `export default { include: import('malicious') }`,
  ])
    expect(() => readConfig(project({ 'api-tripwire.config.js': source }))).toThrow();
});
it('reads defineConfig and retains all confidence levels', async () => {
  const root = project({
    'api-tripwire.config.ts': `import { defineConfig } from 'api-tripwire'; export default defineConfig({ confidence: 'confirmed' });`,
    'server.ts': server('{ id: 1 }', 'const { name } = req.body;'),
    'client.ts': client('user.id'),
  });
  const r = await scan(root);
  expect(r.confidence).toBe('confirmed');
  expect(r.issues[0]?.confidence).toBe('POSSIBLE');
});
it('always excludes dependencies and artifacts', async () => {
  const root = project({
    'node_modules/evil.ts': server('{}'),
    'dist/evil.ts': server('{}'),
    '.api-tripwire/evil.ts': server('{}'),
  });
  expect((await scan(root, { include: ['**/*.ts'] })).summary.files).toBe(0);
});
it('unknown spread can overwrite an earlier nested object', async () => {
  const r = await analyze('{ profile: { id: 1 }, ...unknownValue }', 'user.profile.name');
  expect(r.issues).toEqual([]);
  expect(r.coverage.incompleteRoutes).toBe(1);
});
it('later explicit properties remain known after an unknown spread', async () => {
  const r = await analyze('{ ...unknownValue, profile: { id: 1 } }', 'user.profile.name');
  expect(r.issues[0]?.confidence).toBe('CONFIRMED');
});
it('dynamic mounts do not invent root-level contracts', async () => {
  const r = await scan(
    project({
      'server.ts': `import express from 'express'; const app = express(); const router = express.Router(); router.get('/api/users',(req,res)=>res.json({id:1})); app.use(prefix, router);`,
      'client.ts': client(),
    }),
  );
  expect(r.routes).toHaveLength(0);
  expect(r.diagnostics.some((d) => d.code === 'dynamic-mount')).toBe(true);
});
it('simple identity handler wrappers resolve', async () => {
  const r = await scan(
    project({
      'server.ts': `import express from 'express'; const app=express(); const wrap = handler => handler; app.get('/api/users',wrap((req,res)=>res.json({id:1})));`,
      'client.ts': client(),
    }),
  );
  expect(r.issues[0]?.confidence).toBe('CONFIRMED');
});
it('unknown return branches prevent confirmed absence', async () => {
  const r = await analyze('{ id: 1 }', 'user.userId', 'if (flag) return otherHandler();');
  expect(r.issues[0]?.confidence).toBe('POSSIBLE');
});
it('separate status mutation lowers confidence', async () => {
  const r = await analyze('{ id: 1 }', 'user.userId', 'res.status(code);');
  expect(r.issues[0]?.confidence).toBe('POSSIBLE');
});
it('method calls on consumed fields still establish expectations', async () => {
  const r = await analyze('{ id: 1 }', 'user.userId.toUpperCase()');
  expect(r.issues[0]?.field).toBe('userId');
});
it('known primitive methods do not fabricate expectations', async () => {
  const r = await analyze('{ id: "one" }', 'user.id.toUpperCase()');
  expect(r.issues).toEqual([]);
});
it('runtime type rejection detects incompatible serialized body', async () => {
  const r = await scan(
    project({
      'server.ts': `import express from 'express'; const app=express(); app.post('/api/users',(req,res)=>{ if(typeof req.body.name !== 'string') return res.status(400).json({error:'name'}); return res.json({id:1}); });`,
      'client.ts': `fetch('/api/users', { method: 'POST', body: JSON.stringify({ name: 123 }) });`,
    }),
  );
  expect(r.issues[0]).toMatchObject({
    kind: 'request-type-incompatible',
    confidence: 'HIGH',
    field: 'body.name',
  });
});
it('valid serialized request satisfies runtime guard', async () => {
  const r = await scan(
    project({
      'server.ts': `import express from 'express'; const app=express(); app.post('/api/users',(req,res)=>{ if(typeof req.body.name !== 'string') return res.status(400).json({error:'name'}); return res.json({id:1}); });`,
      'client.ts': `fetch('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Ada' }) });`,
    }),
  );
  expect(r.issues).toEqual([]);
});
it('literal query keys remain separate from paths', async () => {
  const r = await scan(
    project({
      'server.ts': server('{id:1}', 'const { name } = req.query;'),
      'client.ts': client('user.id', '/api/users?name=Ada'),
    }),
  );
  expect(r.summary.matched).toBe(1);
  expect(r.issues).toEqual([]);
});
it('Hono body and query usage are collected', async () => {
  const r = await scan(
    project({
      'server.ts': `import { Hono } from 'hono'; const app=new Hono(); app.post('/api/users',async c=>{ const { name } = await c.req.json(); const token=c.req.query('token'); return c.json({id:1}); });`,
      'client.ts': `fetch('/api/users',{method:'POST'});`,
    }),
  );
  expect(r.issues.map((i) => i.field).sort()).toEqual(['body.name', 'query.token']);
});
it('destructured request guards establish presence', async () => {
  const r = await analyze(
    '{id:1}',
    'user.id',
    `const { name }=req.body; if(!name) return res.status(400).json({error:'name'});`,
  );
  expect(r.issues[0]?.confidence).toBe('HIGH');
});
it('type-enriched objects stay structurally open', async () => {
  const r = await scan(
    project({
      'server.ts': `import express from 'express'; interface User {id:number} const app=express(); function handler(req,res,user:User){res.json(user)} app.get('/api/users',handler);`,
      'client.ts': client(),
    }),
  );
  expect(r.routes[0]?.responses[0]?.shape).toMatchObject({ kind: 'object', open: true });
  expect(r.issues).toEqual([]);
});
it('a client base URL does not authorize a different origin', async () => {
  const r = await scan(
    project({
      'server.ts': server('{id:1}'),
      'client.ts': `import axios from 'axios'; const api=axios.create({baseURL:'https://local.test'}); async function f(){const {data}=await api.get('https://external.test/api/users'); return data.userId;}`,
    }),
  );
  expect(r.summary.matched).toBe(0);
});
it('Next catch-all matches multiple path segments', async () => {
  const r = await scan(
    project({
      'app/api/[...slug]/route.ts': `export function GET(){return Response.json({id:1})}`,
      'client.ts': client('user.id', '/api/a/b/c'),
    }),
  );
  expect(r.summary.matched).toBe(1);
  expect(r.issues).toEqual([]);
});
it('baseline never hides findings from reports', async () => {
  const r = await analyze();
  baseline(r);
  applyBaseline(r);
  expect(r.issues).toHaveLength(1);
  expect(fails(r.issues[0]!, 'confirmed')).toBe(false);
});
it('diff reports proven new required request fields as potentially breaking', async () => {
  const root = project({ 'server.ts': server('{id:1}'), 'client.ts': client('user.id') });
  saveContracts(await scan(root));
  fs.writeFileSync(
    path.join(root, 'server.ts'),
    server('{id:1}', `if(!req.body.name) return res.status(400).json({error:'name'});`),
  );
  const diff = diffContracts(await scan(root));
  expect(diff.changes.find((c) => c.field === 'request:body.name')).toMatchObject({
    breaking: true,
    confidence: 'HIGH',
  });
});
it('diff reports type and uncertainty changes', async () => {
  const root = project({ 'server.ts': server('{id:1}'), 'client.ts': client('user.id') });
  saveContracts(await scan(root));
  fs.writeFileSync(path.join(root, 'server.ts'), server('{id:"one", ...data}'));
  const diff = diffContracts(await scan(root));
  expect(diff.changes.some((c) => c.kind === 'uncertainty-changed')).toBe(true);
});
it('malformed snapshot fails clearly', async () => {
  const r = await analyze();
  saveContracts(r);
  fs.writeFileSync(
    path.join(r.root, '.api-tripwire/contracts.json'),
    '{"schemaVersion":"1","routes":[null]}',
  );
  expect(() => diffContracts(r)).toThrow('Malformed');
});
it('locations consistently use portable relative paths', async () => {
  const root = project({ 'src/server.ts': server('{id:1}'), 'web/client.ts': client() });
  const r = await scan(root);
  expect(r.issues[0]?.consumer?.file).toBe('web/client.ts');
  expect(r.issues[0]?.provider?.file).toBe('src/server.ts');
  expect(JSON.stringify(r)).not.toContain('\\\\');
});
it('baseline contexts ignore source comments', async () => {
  const root = project({ 'server.ts': server('{id:1}'), 'client.ts': client() });
  baseline(await scan(root));
  fs.writeFileSync(path.join(root, 'client.ts'), client('user /* explanatory comment */ .userId'));
  const r = await scan(root);
  applyBaseline(r);
  expect(r.summary.suppressed).toBe(1);
});
it('doctor detects frameworks from manifests without routes', async () => {
  const r = await scan(
    project({ 'package.json': '{"dependencies":{"express":"*"}}', 'pnpm-lock.yaml': '' }),
  );
  expect(r.environment).toMatchObject({ packageManager: 'pnpm', frameworks: ['express'] });
  expect(r.coverage.status).toBe('unverified');
});
it('tracks simple same-scope framework assignments', async () => {
  const r = await scan(
    project({
      'server.ts': `import express from 'express';let app;app=express();app.get('/api/users',(req,res)=>res.json({id:1}));`,
      'client.ts': client(),
    }),
  );
  expect(r.issues[0]?.confidence).toBe('CONFIRMED');
});
it('reassigned response values use the latest direct assignment', async () => {
  const r = await analyze('value', 'user.userId', 'let value={id:1}; value={userId:1};');
  expect(r.issues).toEqual([]);
});
it('property mutations prevent stale closed response shapes', async () => {
  const r = await analyze('value', 'user.userId', 'const value={id:1}; value.userId=1;');
  expect(r.issues).toEqual([]);
  expect(r.coverage.incompleteRoutes).toBe(1);
});
