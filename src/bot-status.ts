import type { Config } from './config.js';
import type { Session } from './state.js';

export type EngineReport = {
  reportedAt: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  cwd?: string;
  permissionMode?: string;
  fastMode?: string;
};

// Keep only display metadata, never the complete CLI response or its credentials.
export function engineReport(fields: Record<string, unknown>): EngineReport {
  const result: EngineReport = { reportedAt: new Date().toISOString() };
  for (const key of ['model', 'reasoningEffort', 'serviceTier', 'cwd', 'permissionMode', 'fastMode'] as const) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim() && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)) result[key] = value;
  }
  return result;
}

function display(value: string | undefined, fallback: string): string {
  return (value || fallback).replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&');
}

export function botStatus(kind: 'codex' | 'claude', config: Config, session: Session): string {
  const codex = kind === 'codex';
  const report = codex ? session.codexReport : session.claudeReport;
  const row = (label: string, value?: string, fallback = 'unknown (not reported)') => `- ${label}: ${display(value, fallback)}`;
  const configured = 'automatic (inherited from CLI settings)';
  const settings = [
    row('Workspace', config.workspace),
    row('Model', codex ? config.codexModel : config.claudeModel, configured),
    ...(codex ? [row('Reasoning', config.codexReasoningEffort, configured)] : []),
    row('Service tier', codex ? config.codexServiceTier : config.claudeServiceTier, configured),
  ].join('\n');
  const reported = report ? [
    row('Reported at', report.reportedAt),
    row('Model', report.model), row('Workspace', report.cwd),
    row('Reasoning', report.reasoningEffort),
    ...(codex ? [row('Service tier', report.serviceTier)] : [row('Fast mode', report.fastMode), row('Permission mode', report.permissionMode)]),
  ].join('\n') + '\n\nThis is the last session report, not a live query. Settings may have changed since then.'
    : 'No report yet. Values will appear when the CLI starts a task in this conversation.';
  return [
    `**${codex ? 'Codex' : 'Claude Code'} status**`,
    '**Riftjack settings**', settings,
    '**Last CLI session report**', reported,
  ].join('\n\n');
}
