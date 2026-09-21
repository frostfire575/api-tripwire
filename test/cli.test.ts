import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { render, annotation } from '../src/output/terminal.js';
import { scan } from '../src/core/scan.js';

const run = (...args: string[]) =>
  spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });

it('CLI returns 1 for broken demo and pure JSON', () => {
  const r = run('scan', 'examples/demo', '--json', '--debug');
  expect(r.status).toBe(1);
  expect(JSON.parse(r.stdout).issues[0].field).toBe('userId');
  expect(r.stderr).toContain('diagnostics');
});
it('CLI defaults to scan', () => {
  expect(run('examples/demo', '--no-color').status).toBe(1);
});
it('inspection commands return 0', () => {
  for (const command of ['routes', 'consumers', 'doctor', 'init'])
    expect(run(command, 'fixtures/express', '--json').status).toBe(0);
});
it('explain selects project', () => {
  const r = run('explain', 'GET', '/api/users/:id', '--project', 'examples/demo', '--json');
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).issues).toHaveLength(1);
});
it('help and version succeed', () => {
  expect(run('--help').status).toBe(0);
  expect(run('--version').stdout.trim()).toBe('0.1.0');
});
it('invalid options and missing snapshots return 2', () => {
  expect(run('--fail-on', 'bogus').status).toBe(2);
  expect(run('diff', 'examples/demo', '--json').status).toBe(2);
});
it('terminal plain, colored and narrow snapshots', async () => {
  const r = await scan('examples/demo');
  for (const [label, opts] of Object.entries({
    plain: { color: false, width: 100 },
    color: { color: true, width: 100 },
    narrow: { color: false, width: 32 },
    ci: { ci: true },
  }))
    expect(render(r, opts)).toMatchSnapshot(label);
});
it('escapes GitHub annotations', async () => {
  const r = await scan('examples/demo');
  const issue = r.issues[0]!;
  issue.message = 'bad%\n::warning::';
  issue.consumer!.file = 'file,a:b.ts';
  expect(annotation(issue)).toContain('file%2Ca%3Ab.ts');
  expect(annotation(issue)).toContain('bad%25%0A');
});
it('narrow layouts stay within their width, including long paths', async () => {
  const r = await scan('examples/demo');
  r.issues[0]!.consumer!.file = 'very-long-directory-name/'.repeat(4) + 'client.ts';
  expect(
    render(r, { width: 32 })
      .split('\n')
      .every((line) => line.length <= 32),
  ).toBe(true);
});
