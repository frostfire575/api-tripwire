import pc from 'picocolors';
import type { Issue, Report } from '../core/models.js';

export interface RenderOptions {
  color?: boolean;
  width?: number;
  ci?: boolean;
}

export function render(report: Report, options: RenderOptions = {}): string {
  const colors = pc.createColors(options.color ?? false);
  const width = Math.max(24, options.width ?? 100);
  const lines: string[] = [];

  const emit = (text: string, color: (value: string) => string = (value) => value): void => {
    const indent = text.match(/^\s*/)?.[0] ?? '';
    for (const part of wrap(text.trimStart(), width - indent.length))
      lines.push(color(indent + part));
  };

  emit(options.ci ? 'api-tripwire' : 'api-tripwire · API contract drift', colors.bold);
  lines.push('');
  for (const issue of report.issues) {
    const symbol = issue.suppressed ? '–' : issue.severity === 'warning' ? '!' : '×';
    const label = `${options.ci ? '' : symbol + ' '}${issue.confidence}${issue.suppressed ? ' (baseline)' : ''} ${issue.method} ${issue.route}`;
    emit(label, issue.severity === 'error' && !issue.suppressed ? colors.red : colors.yellow);
    emit('  ' + issue.message);
    if (issue.consumer)
      emit(`  consumer ${issue.consumer.file}:${issue.consumer.line}:${issue.consumer.column}`);
    if (issue.provider)
      emit(`  provider ${issue.provider.file}:${issue.provider.line}:${issue.provider.column}`);
    if (issue.suggestion)
      emit('  ' + issue.suggestion, (value) => '  ' + colors.cyan(value.trimStart()));
    for (const evidence of issue.evidence.slice(0, 2)) emit(`  Evidence: ${evidence.message}`);
    lines.push('');
  }
  const s = report.summary;
  emit(`${s.routes} routes · ${s.consumers} consumers · ${s.matched} matched`);
  emit(
    `${s.issues} findings · ${s.suppressed} suppressed · ${report.diagnostics.length} coverage diagnostics`,
  );
  if (report.coverage.status === 'unverified')
    emit('Unverified: no uniquely matched contracts.', colors.yellow);
  else if (report.coverage.status === 'partial')
    emit('Partial coverage: inspect doctor or --json for unresolved analysis.');
  else if (!s.issues) emit('No drift found in the analyzed contracts.', colors.green);
  return lines.join('\n');
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (let word of text.split(' ')) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = '';
    }
    while (word.length > width) {
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    line += (line ? ' ' : '') + word;
  }
  if (line) out.push(line);
  return out;
}

export function annotation(issue: Issue): string {
  const data = (s: string): string =>
    s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

  const property = (s: string): string => data(s).replaceAll(':', '%3A').replaceAll(',', '%2C');

  return `::error${issue.consumer ? ` file=${property(issue.consumer.file)},line=${issue.consumer.line},col=${issue.consumer.column}` : ''}::${data(`${issue.confidence} ${issue.method} ${issue.route}: ${issue.message}`)}`;
}
