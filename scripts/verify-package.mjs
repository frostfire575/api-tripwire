import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const npm = process.env.npm_execpath;
if (!npm)
  throw new Error('Run through npm run verify:package so npm can be located without a shell');
const npx = path.join(path.dirname(npm), 'npx-cli.js');

function command(executable, args, cwd, expected = 0) {
  const isPackageManager = executable === npm || executable === npx;
  const result = spawnSync(
    isPackageManager ? process.execPath : executable,
    isPackageManager ? [executable, ...args] : args,
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== expected)
    throw new Error(
      `${executable} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tripwire-package-'));
try {
  // Pack into the workspace; the package has no install-time scripts.
  command(npm, ['pack', '--pack-destination', '.'], root);
  const tarball = path.join(root, 'api-tripwire-0.1.0.tgz');
  fs.writeFileSync(
    path.join(temporary, 'package.json'),
    JSON.stringify({ name: 'tripwire-install-check', private: true, type: 'module' }),
  );
  command(npm, ['install', '--offline', '--ignore-scripts', tarball], temporary);
  fs.cpSync(path.join(root, 'examples/demo'), path.join(temporary, 'demo'), { recursive: true });
  const report = JSON.parse(
    command(
      npx,
      ['--no-install', '--offline', 'api-tripwire', 'scan', 'demo', '--json'],
      temporary,
      1,
    ),
  );
  if (report.issues[0]?.field !== 'userId')
    throw new Error('Installed command did not detect the demo mismatch');
  fs.writeFileSync(
    path.join(temporary, 'exports.mjs'),
    "import { scan, defineConfig } from 'api-tripwire'; if (typeof scan !== 'function' || defineConfig({}).constructor !== Object) process.exit(1);\n",
  );
  command(process.execPath, ['exports.mjs'], temporary);
  fs.writeFileSync(
    path.join(temporary, 'types.ts'),
    "import { scan, defineConfig, type Report, type Config } from 'api-tripwire'; const config: Config = defineConfig({ confidence: 'high' }); const report: Promise<Report> = scan('.', config); void report;\n",
  );
  command(
    process.execPath,
    [
      path.join(temporary, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--skipLibCheck',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2023',
      'types.ts',
    ],
    temporary,
  );
  process.stdout.write(
    'Tarball installed offline. Local npx: exit 1, userId mismatch. ESM exports and declarations: passed.\n',
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
