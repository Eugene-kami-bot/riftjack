import { Access } from './access.js';
import { Accounts, PublicError } from './accounts.js';
import { resolveProfileTarget } from './bot-profile.js';
import { inlineCode, markdownText } from './manager-format.js';
import { errorMessage } from './errors.js';
import type { InvitationStatus } from './bot-invitations.js';

type BotAccessRequest = { action: 'list'; target: string } | { action: 'allow' | 'remove'; target: string; users: string[] };
export function parseBotAccessRequest(text: string): BotAccessRequest | null {
  const clean = text.trim();
  if (!/^(?:(?:allow|remove) bot|list access bot)(?:\s|$)/i.test(clean)) return null;
  const list = /^list access bot (?:"([^"\r\n]+)"|([^"\r\n]+))$/i.exec(clean);
  if (list) return { action: 'list', target: (list[1] ?? list[2]).trim() };
  const match = /^(allow|remove) bot (?:"([^"\r\n]+)"|([^"\r\n]+?)) for (.+)$/i.exec(clean);
  const users = match?.[4].split(/[\s,]+/).filter(Boolean) ?? [];
  if (!match || !users.length || users.some(id => !/^@[^\s:@,]+:[^\s,]+$/.test(id))) {
    throw new PublicError('Use allow bot Riftjack Codex for @alice:server @bob:server, remove bot Riftjack Codex for @alice:server or list access bot Riftjack Codex.');
  }
  return { action: match[1].toLowerCase() as 'allow' | 'remove', target: (match[2] ?? match[3]).trim(), users: [...new Set(users)] };
}

export async function manageBotAccess(request: BotAccessRequest, options: {
  accounts: Accounts; access: Access; sender: string;
  revoke: (botId: string, userId: string) => void;
  invite?: (botId: string, userId: string) => Promise<InvitationStatus>;
  signal?: AbortSignal;
}): Promise<string> {
  const { accounts, access, sender } = options;
  if (sender !== access.owner) throw new PublicError('Only the initial owner can manage access lists through the manager.');
  const bot = resolveProfileTarget(accounts, request.target, sender, access.owner);
  if (bot.kind === 'manager') throw new PublicError('Manager access requires shared access through allow @user:server. Per-bot lists are supported for Codex, Claude and Grok bots.');
  const invitations: string[] = [];
  options.signal?.throwIfAborted();
  if (request.action !== 'list') {
    if (request.users.some(id => accounts.list().some(account => account.userId === id))) throw new PublicError('Bot accounts cannot be added to user access lists.');
    access.changeBot('manager', sender, request.action, bot.userId, request.users);
    if (request.action === 'remove') for (const userId of request.users) options.revoke(bot.userId, userId);
    else for (const userId of request.users) {
      options.signal?.throwIfAborted();
      try {
        if (!options.invite) throw new PublicError('The bot is disconnected.');
        const status = await options.invite(bot.userId, userId);
        invitations.push(`${inlineCode(userId)} — ${status === 'joined' ? 'already in a DM' : status === 'pending' ? 'invitation already pending' : 'invitation sent; accept it in Element X'}.`);
      } catch (error) {
        options.signal?.throwIfAborted();
        invitations.push(`${inlineCode(userId)} — access granted, invitation unconfirmed. ${markdownText(errorMessage(error))} Retry allow bot or open a DM manually.`);
      }
    }
  }
  const list = (ids: string[]) => ids.length ? ids.map(id => '- ' + inlineCode(id)).join('\n') : 'No users.';
  return `### Access to ${markdownText(bot.name)}\n\n${inlineCode(bot.userId)}\n\n${invitations.length ? '**Invitations**\n' + invitations.join('\n') + '\n\n' : ''}**This bot’s access list**\n${list(access.listBot(bot.userId))}\n\n**Shared access to all bots, including the owner**\n${list(access.list())}\n\nThis list does not grant access to other bots or the manager.`;
}
