import type { Config } from './config.js';
import { PublicError } from './errors.js';

export type EngineSettings = { model?: string; reasoning?: string; tier?: string };
export function validateEngineSettings(value: unknown, kind: string): asserts value is EngineSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['codex', 'claude'].includes(kind)) {
    throw new PublicError('Model settings are supported only for Codex and Claude bots.');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!['model', 'tier', ...(kind === 'codex' ? ['reasoning'] : [])].includes(key) ||
        typeof entry !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(entry)) {
      throw new PublicError('Invalid model setting. Use model or tier identifiers; reasoning settings are supported only for Codex bots.');
    }
    if (kind === 'claude' && key === 'tier' && !['default', 'fast'].includes(entry)) {
      throw new PublicError('Claude tier must be default or fast. Use reset tier bot Research to inherit the shared or CLI setting.');
    }
  }
}

export function withEngineSettings(config: Config, account: { kind: string; engineSettings?: EngineSettings }): Config {
  const settings = account.engineSettings ?? {};
  if (account.kind === 'codex') return { ...config,
    codexModel: settings.model ?? config.codexModel,
    codexReasoningEffort: settings.reasoning ?? config.codexReasoningEffort,
    codexServiceTier: settings.tier ?? config.codexServiceTier };
  if (account.kind === 'claude') return { ...config, claudeModel: settings.model ?? config.claudeModel,
    claudeServiceTier: settings.tier ?? config.claudeServiceTier };
  return { ...config };
}
