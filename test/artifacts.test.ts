import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary: string[] = [];

function copy(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripwire-cli-'));
  temporary.push(root);
  fs.cpSync('examples/demo', root, { recursive: true });
  return root;
}

const run = (...args: string[]) =>
  spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('CLI baseline suppresses failure but preserves findings', () => {
  const root = copy();
  expect(run('baseline', root, '--json').status).toBe(0);
  const result = run('ci', root, '--baseline', '--json');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).summary.suppressed).toBe(1);
});
it('CLI saves snapshots only on explicit request', () => {
  const root = copy();
  run('scan', root);
  expect(fs.existsSync(path.join(root, '.api-tripwire/contracts.json'))).toBe(false);
  expect(run('scan', root, '--save-contracts', '--json').status).toBe(1);
  const result = run('diff', root, '--json');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).changes).toEqual([]);
});
it('init leaves defaults alone and retains existing config', () => {
  const root = copy();
  const first = run('init', root, '--json');
  expect(JSON.parse(first.stdout).created).toBe(false);
  const file = path.join(root, 'api-tripwire.config.ts');
  const config = 'export default { confidence: "possible" };\n';
  fs.writeFileSync(file, config);
  expect(run('init', root).status).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe(config);
});
it('CI annotations are omitted from JSON', () => {
  const root = copy();
  const result = spawnSync(process.execPath, ['dist/cli.js', 'ci', root, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
  expect(result.status).toBe(1);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  expect(result.stdout).not.toContain('::error');
});
it('CLI threshold overrides config', () => {
  const root = copy();
  fs.writeFileSync(
    path.join(root, 'server.ts'),
    `import express from 'express';const app=express();app.get('/api/users/:id',(req,res)=>res.status(code).json({id:1}));`,
  );
  fs.writeFileSync(
    path.join(root, 'api-tripwire.config.ts'),
    `export default {confidence:'confirmed'};`,
  );
  expect(run('scan', root, '--json').status).toBe(0);
  expect(run('scan', root, '--fail-on', 'possible', '--json').status).toBe(1);
});
