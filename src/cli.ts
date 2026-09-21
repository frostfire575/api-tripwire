#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { scan } from './core/scan.js';
import { configNames, projectRoot, readConfig } from './config/index.js';
import { applyBaseline, baseline, diffContracts, saveContracts } from './core/persistence.js';
import { fails } from './core/compare.js';
import { render, annotation } from './output/terminal.js';
import type { Report } from './core/models.js';

interface Options {
  json?: boolean;
  debug?: boolean;
  color?: boolean;
  failOn?: 'confirmed' | 'high' | 'possible';
  baseline?: boolean;
  saveContracts?: boolean;
  project?: string;
}

const program = new Command()
  .name('api-tripwire')
  .description('Detect likely API contract drift using local static analysis')
  .version('0.1.0');

function common(command: Command): Command {
  return command
    .option('--json', 'emit schema version 1 JSON')
    .option('--debug', 'write analysis details to stderr')
    .option('--no-color', 'disable terminal colors');
}

function scanning(command: Command): Command {
  return common(command).addOption(
    new Option('--fail-on <confidence>', 'failure threshold (defaults to config or high)').choices([
      'confirmed',
      'high',
      'possible',
    ]),
  );
}

function output(value: unknown, options: Options, plain: string): void {
  process.stdout.write((options.json ? JSON.stringify(value, null, 2) : plain) + '\n');
}

function mergeOptions(options: Options): void {
  const global = program.opts<Options>();
  Object.assign(options, { ...global, ...options });
  for (const key of Object.keys(global))
    if (program.getOptionValueSource(key) === 'cli')
      Object.assign(options, { [key]: global[key as keyof Options] });
}

async function analyze(directory: string | undefined, options: Options): Promise<Report> {
  mergeOptions(options);
  const report = await scan(directory);
  if (options.debug)
    process.stderr.write(
      JSON.stringify(
        { root: report.root, files: report.summary.files, diagnostics: report.diagnostics },
        null,
        2,
      ) + '\n',
    );
  return report;
}

async function runScan(directory: string | undefined, options: Options, ci = false): Promise<void> {
  const report = await analyze(directory, options);
  if (options.baseline) applyBaseline(report);
  if (options.saveContracts) saveContracts(report);
  const threshold = options.failOn ?? report.confidence;
  output(
    report,
    options,
    render(report, {
      color:
        !ci && options.color !== false && !('NO_COLOR' in process.env) && !!process.stdout.isTTY,
      width: process.stdout.columns,
      ci,
    }),
  );
  const qualifying = report.issues.filter((i) => fails(i, threshold));
  if (ci && process.env.GITHUB_ACTIONS === 'true' && !options.json)
    for (const issue of qualifying) process.stdout.write(annotation(issue) + '\n');
  process.exitCode = qualifying.length ? 1 : 0;
}

scanning(program)
  .argument('[project]', 'project directory')
  .option('--save-contracts', 'write a contract snapshot')
  .action((directory: string | undefined, options: Options) => runScan(directory, options));
scanning(program.command('scan [project]').description('Analyze routes and consumers'))
  .option('--save-contracts', 'write a contract snapshot')
  .action((directory: string | undefined, options: Options) => runScan(directory, options));
scanning(program.command('ci [project]').description('Analyze with CI exit codes'))
  .option('--baseline', 'suppress findings in the saved baseline')
  .action((directory: string | undefined, options: Options) => runScan(directory, options, true));
for (const command of ['routes', 'consumers', 'doctor', 'baseline', 'diff'] as const)
  common(program.command(`${command} [project]`)).action(
    async (directory: string | undefined, options: Options) => {
      const report = await analyze(directory, options);
      if (command === 'baseline') {
        const file = baseline(report);
        output(
          { schemaVersion: '1', file, findings: report.issues.length },
          options,
          `Saved ${report.issues.length} findings to ${file}`,
        );
      } else if (command === 'diff') {
        const diff = diffContracts(report);
        output(
          diff,
          options,
          diff.changes.length
            ? diff.changes
                .map(
                  (c) =>
                    `${c.confidence} ${c.kind} ${c.method} ${c.route} ${c.field ?? ''}${c.breaking ? ' (potentially breaking)' : ''}`,
                )
                .join('\n')
            : 'No saved contract changes.',
        );
      } else if (command === 'routes')
        output(
          { schemaVersion: '1', routes: report.routes },
          options,
          report.routes
            .map(
              (r) =>
                `${r.method.padEnd(7)} ${r.path}  ${r.framework}  ${r.location.file}:${r.location.line}`,
            )
            .join('\n') || 'No routes discovered.',
        );
      else if (command === 'consumers')
        output(
          { schemaVersion: '1', consumers: report.consumers },
          options,
          report.consumers
            .map(
              (c) =>
                `${c.method.padEnd(7)} ${c.path}  ${c.client}  ${c.location.file}:${c.location.line}`,
            )
            .join('\n') || 'No consumers discovered.',
        );
      else
        output(
          report,
          options,
          [
            `Root: ${report.root}`,
            `Package manager: ${report.environment.packageManager}`,
            `Languages: ${report.environment.languages.join(', ') || 'none'}`,
            `Frameworks: ${report.environment.frameworks.join(', ') || 'none'}`,
            `Coverage: ${report.coverage.status}`,
            ...report.diagnostics.map(
              (d) =>
                `UNKNOWN ${d.code}: ${d.message}${d.location ? ` (${d.location.file}:${d.location.line})` : ''}`,
            ),
          ].join('\n'),
        );
    },
  );
common(program.command('explain <method> <route>'))
  .option('--project <directory>', 'project directory')
  .action(async (method: string, routePath: string, options: Options) => {
    const report = await analyze(options.project, options);
    const routes = report.routes.filter(
      (r) => r.method === method.toUpperCase() && r.path === routePath,
    );
    const issues = report.issues.filter(
      (i) => i.method === method.toUpperCase() && i.route === routePath,
    );
    const consumers = report.consumers.filter((c) =>
      c.matchedRouteIds.some((id) => routes.some((r) => r.id === id)),
    );
    output(
      { schemaVersion: '1', routes, consumers, issues },
      options,
      routes.length
        ? JSON.stringify({ routes, consumers, issues }, null, 2)
        : `No route matched ${method.toUpperCase()} ${routePath}.`,
    );
  });
common(program.command('init [project]')).action(
  async (directory: string | undefined, options: Options) => {
    mergeOptions(options);
    const root = projectRoot(directory);
    const existing = configNames.find((n) => fs.existsSync(path.join(root, n)));
    if (existing) {
      readConfig(root);
      output(
        { schemaVersion: '1', created: false, message: `Existing ${existing} retained.` },
        options,
        `Existing ${existing} retained.`,
      );
      return;
    }
    const report = await scan(root);
    const customized =
      report.summary.files === 0 &&
      ['examples', 'fixtures'].some((n) => fs.existsSync(path.join(root, n)));
    let message = 'Defaults suffice; no configuration file is needed.';
    if (customized) {
      const file = path.join(root, 'api-tripwire.config.ts');
      fs.writeFileSync(
        file,
        "import { defineConfig } from 'api-tripwire';\n\nexport default defineConfig({ include: ['**/*.{js,jsx,ts,tsx}'] });\n",
        { flag: 'wx' },
      );
      message = `Created ${file} to include the detected example/fixture layout.`;
    }
    output({ schemaVersion: '1', created: customized, message }, options, message);
  },
);
program.exitOverride();
try {
  await program.parseAsync();
} catch (error) {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(String(error.code))
  )
    process.exitCode = 0;
  else {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes('--json'))
      process.stdout.write(JSON.stringify({ schemaVersion: '1', error: message }) + '\n');
    else process.stderr.write(`api-tripwire: ${message}\n`);
    process.exitCode = 2;
  }
}
