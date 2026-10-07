import { Accounts } from './accounts.js';
import { resolveProfileTarget } from './bot-profile.js';
import { PublicError } from './errors.js';
import { inlineCode, markdownText } from './manager-format.js';
import { type EngineSettings, validateEngineSettings, withEngineSettings } from './engine-settings.js';
import type { Config } from './config.js';

type SettingsRequest = { action: 'show'; target: string } |
  { action: 'set' | 'reset'; target: string; field: keyof EngineSettings; value?: string };
const usage = 'Use set model bot Builder to MODEL, set reasoning bot Builder to high, set tier bot Builder to default, reset model bot Builder, or show settings bot Builder.';
export function parseBotSettingsRequest(text: string): SettingsRequest | null {
  const clean = text.trim();
  if (!/^(?:(?:set|reset) (?:model|reasoning|tier) bot|show settings bot)(?:\s|$)/i.test(clean)) return null;
  const show = /^show settings bot (?:"([^"\r\n]+)"|([^"\r\n]+))$/i.exec(clean);
  if (show) return { action: 'show', target: (show[1] ?? show[2]).trim() };
  const match = /^(set|reset) (model|reasoning|tier) bot (?:"([^"\r\n]+)"|([^"\r\n]+?))(?: to ([^\s]+))?$/i.exec(clean);
  if (!match || (match[1].toLowerCase() === 'set') !== !!match[5]) throw new PublicError(usage);
  return { action: match[1].toLowerCase() as 'set' | 'reset', field: match[2].toLowerCase() as keyof EngineSettings,
    target: (match[3] ?? match[4]).trim(), value: match[5] };
}

export function manageBotSettings(request: SettingsRequest, options: {
  accounts: Accounts; owner: string; sender: string; config: Config;
}): string {
  const bot = resolveProfileTarget(options.accounts, request.target, options.sender, options.owner);
  const settings = { ...bot.engineSettings };
  validateEngineSettings(settings, bot.kind);
  if (request.action !== 'show') {
    if (bot.kind === 'claude' && request.field === 'reasoning') throw new PublicError('Reasoning settings are supported only for Codex bots.');
    if (request.action === 'reset') delete settings[request.field];
    else settings[request.field] = request.value!;
    validateEngineSettings(settings, bot.kind);
    options.accounts.setEngineSettings(bot.userId, settings);
  }
  const config = withEngineSettings(options.config, { ...bot, engineSettings: settings });
  const fields: [keyof EngineSettings, string | undefined][] = bot.kind === 'codex'
    ? [['model', config.codexModel], ['reasoning', config.codexReasoningEffort], ['tier', config.codexServiceTier]]
    : [['model', config.claudeModel], ['tier', config.claudeServiceTier]];
  return `### Settings for ${markdownText(bot.name)}\n\n` + fields.map(([key, value]) =>
    `- ${key}: ${value ? inlineCode(value) : 'automatic (CLI settings)'} — ${settings[key] ? 'bot override' : 'inherited'}`).join('\n') +
    '\n\nChanges apply to the next task; running tasks keep their settings. No restart or conversation reset is required. Model and option availability is checked by the CLI when a task starts.';
}
