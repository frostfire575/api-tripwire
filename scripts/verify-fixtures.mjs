import { spawnSync } from 'node:child_process';

const fixtures = [
  'express',
  'fastify',
  'hono',
  'next-app',
  'next-pages',
  'axios',
  'ky',
  'tanstack',
];
for (const fixture of [...fixtures, 'demo']) {
  const directory = fixture === 'demo' ? 'examples/demo' : `fixtures/${fixture}`;
  const result = spawnSync(process.execPath, ['dist/cli.js', 'scan', directory, '--json'], {
    encoding: 'utf8',
  });
  const report = JSON.parse(result.stdout);
  const expected = fixture === 'demo' ? 1 : 0;
  if (result.status !== expected || report.summary.matched < 1)
    throw new Error(`${fixture}: exit ${result.status}; ${result.stderr}\n${result.stdout}`);
  process.stdout.write(
    `${fixture}: exit ${result.status}, ${report.summary.routes} routes, ${report.summary.matched} matched, ${report.issues.length} findings\n`,
  );
}
