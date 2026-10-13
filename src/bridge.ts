import type { BackgroundAction } from './background-tasks.js';
import type { CompactionPhase } from './compaction-notices.js';
import { taskTyping } from './task-typing.js';
import { roomMessageDelivery, type MessageRequest, type RoomMessageTool } from './room-messages.js';
import type { SendAttachments } from './attachment-delivery.js';
import type { State } from './state.js';
import { PublicError } from './accounts.js';
import { errorMessage } from './errors.js';
import type { RestartTarget } from './restart-notice.js';
import type { RestartScope } from './restart.js';
import { MANAGER_HELP } from './manager-help.js';
import { botHelp } from './bot-help.js';
import { isMedia, type MediaContent, type IncomingAttachment, type OutgoingAttachment, type BackendReply } from './media.js';
import { Interactions, type Interact, type ReactionControls } from './interactions.js';
import type { PublishAction } from './publish-mcp.js';
import { feedbackMeaning, reactionFeedback, type ReactionReader } from './reaction-feedback.js';

// Connector-defined content fields. A trigger marks a turn started by a peer
// agent's mention; it is created locally and never accepted from Matrix.
// A reply ID is shared by the parts of one split reply.
// A grant is the ID of the peer credit paid for a mention. A notice marks a
// locally created turn in the human's approval scope (a background result, a
// timer or reaction feedback), so it is not presented as the human's words.
export const AGENT_TRIGGER = 'riftjack.trigger', SERVICE = 'riftjack.service', REPLY = 'riftjack.reply', GRANT = 'riftjack.grant',
  NOTICE = 'riftjack.notice';
export type Notice = 'background' | 'timer' | 'reaction' | 'restart';
export const RESTART_PROMPT = 'Riftjack restarted. Check current work and background tasks; continue if there is work to do.';
export type MatrixEvent = {
  type?: string; event_id?: string; sender?: string; origin_server_ts?: number; room_id?: string;
  content?: MediaContent & { 'm.mentions'?: { user_ids?: string[] }; 'm.relates_to'?: { rel_type?: string; event_id?: string; key?: string; 'm.in_reply_to'?: { event_id: string } };
    [AGENT_TRIGGER]?: { agent: string; event: string; events?: string[] }; [SERVICE]?: unknown; [REPLY]?: unknown; [GRANT]?: unknown; [NOTICE]?: Notice };
};
export type Mentions = { text: string; mentions: string[]; error?: string };
export type Mode = 'codex' | 'claude' | 'grok' | 'manager';
export type BackendHooks = { background?: BackgroundAction; progress?: (text: string) => Promise<void>; compaction?: (phase: CompactionPhase) => Promise<void>; sendAttachments?: SendAttachments; roomMessages?: RoomMessageTool };
export type Backend = (mode: Mode, prompt: string, key: string, signal: AbortSignal, sender: string, attachments?: IncomingAttachment[], interact?: Interact, publish?: PublishAction, hooks?: BackendHooks) => Promise<string | BackendReply>;
export type Steer = (prompt: string, key: string, signal: AbortSignal, sender: string, attachments?: IncomingAttachment[]) => Promise<boolean>;
type Options = {
  botId: string; isAuthorized: (user: string) => boolean; kind: Mode; since: number; timeoutMs: number;
  isPrivateRoom: (room: string, sender: string) => Promise<boolean>;
  state: State; run: Backend;
  steer?: Steer;
  recoverMessages?: boolean;
  queuedUpdateMessage?: string;
  owner?: string;
  ownerDiagnostic?: (error: unknown, context: { room: string; sender: string }) => Promise<void>;
  isStopping?: () => boolean;
  restart?: (reply: (text: string) => Promise<void>, target: RestartTarget, scope: RestartScope) => Promise<void>;
  reply: (room: string, event: MatrixEvent, text: string, markdown?: boolean, msgtype?: 'm.text' | 'm.notice', mentions?: string[]) => Promise<void>;
  typing?: (room: string, typing: boolean, timeout: number) => Promise<unknown>;
  confirmation?: (room: string, event: MatrixEvent, text: string, controls: ReactionControls, markdown: string) => Promise<void>;
  receive?: (event: MatrixEvent, key: string, signal: AbortSignal, authorize: () => Promise<void>) => Promise<IncomingAttachment>;
  transcribe?: (file: IncomingAttachment, signal: AbortSignal) => Promise<IncomingAttachment>;
  reactionTarget?: ReactionReader;
  acceptManagerAvatar?: (prompt: string, sender: string) => boolean;
  sendAttachments?: (room: string, event: MatrixEvent, files: OutgoingAttachment[], signal: AbortSignal) => Promise<void>;
  status?: (key: string) => string;
  publish?: (input: unknown, signal: AbortSignal, interact: Interact, authorize: () => Promise<void>) => Promise<string>;
  background?: (input: unknown, context: { room: string; event: MatrixEvent; key: string }, signal: AbortSignal) => Promise<string>;
  roomMessages?: (request: MessageRequest, context: { room: string; event: MatrixEvent; key: string }, signal: AbortSignal) => Promise<string>;
  // Account usage and limits of the engine.
  usage?: (signal: AbortSignal) => Promise<string>;
  report: (error: unknown) => void;
  // Compaction notices may be routed to a private home while work runs in a shared room.
  compactionRoom?: string;
  compaction?: (phase: CompactionPhase, context: { room: string; sender: string }) => Promise<void>;
  linkedSession?: (room: string, event: MatrixEvent) => string;
  decoratePrompt?: (room: string, event: MatrixEvent, prompt: string, steering?: boolean) => string;
  promptDelivered?: () => void;
  // Extracts a validated peer mention request from a final reply in a shared room.
  mentions?: (room: string, text: string) => Mentions | undefined;
  // Shared rooms: the agent may decline a human message with NO_REPLY, so no
  // acknowledgement is sent before it decides.
  shared?: (room: string) => boolean;
  // Called once for each newly accepted human message (not commands, reactions,
  // notices or replays), after access and privacy checks.
  accepted?: (room: string, event: MatrixEvent) => void;
};
function help(kind: Mode): string {
  return kind === 'manager' ? MANAGER_HELP : botHelp(kind);
}

type Followup = { prompt: string; event: MatrixEvent; attachments: IncomingAttachment[] };
type Active = {
  room: string; event: MatrixEvent;
  key: string; backendKey: string; sender: string; controller: AbortController; running: boolean; failed: boolean;
  ready: Promise<void>; markReady: () => void; steering: Promise<void>; buffered: number; followups: Followup[];
  inputIds: string[]; cancelled?: boolean;
  interactions: Interactions; publication?: boolean; typing?: ReturnType<typeof taskTyping>;
};

export function sessionKey(room: string, event: MatrixEvent) {
  const relation = event.content?.['m.relates_to'];
  return JSON.stringify([room, event.sender, relation?.rel_type === 'm.thread' ? relation.event_id : null]);
}

export class Bridge {
  private active?: Active;
  private stopped = false;
  private draining = false;
  private retained = new Set<string>();
  private replaying = new Set<string>();
  private recoveryNotes = new Set<string>();
  private restartNotice?: { room: string; event: MatrixEvent; key: string; session: string };
  private admission = Promise.resolve();
  constructor(private options: Options) {}
  private deliver<T>(room: string, send: () => Promise<T>): Promise<T> {
    const typing = this.active?.room === room ? this.active.typing : undefined;
    return typing ? typing.message(send) : send();
  }
  private reply(...args: Parameters<Options['reply']>): Promise<void> {
    return this.deliver(args[0], () => this.options.reply(...args));
  }
  get busy(): boolean { return !!this.active || this.draining || (!!(this.options.linkedSession || this.options.recoverMessages) && this.options.state.queued(this.options.botId) > 0); }
  stop() { this.stopped = true; this.active?.controller.abort(); }
  revoke(sender: string) {
    if (this.restartNotice?.event.sender === sender) this.restartNotice = undefined;
    if (this.active?.sender === sender) this.active.controller.abort();
  }
  // One notice per bot startup, only for an existing conversation. No private
  // task files are read to decide whether to start a turn.
  scheduleRestart(id: string, room: string, sender: string, session: string, thread?: string): void {
    if (this.options.kind !== 'codex' && this.options.kind !== 'claude') return;
    const event: MatrixEvent = { type: 'm.room.message', event_id: `restart:${id}:${this.options.botId}`,
      sender, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: RESTART_PROMPT, [NOTICE]: 'restart',
        ...(thread && { 'm.relates_to': { rel_type: 'm.thread', event_id: thread } }) } };
    const key = this.options.linkedSession?.(room, event) ?? sessionKey(room, event);
    this.restartNotice = { room, event, key, session };
  }
  async resumeRestart(): Promise<void> {
    const notice = this.restartNotice, o = this.options;
    if (!notice || this.busy || this.stopped || o.isStopping?.()) return;
    if (!o.isAuthorized(notice.event.sender!) || o.state.session(notice.key)[o.kind as 'codex' | 'claude'] !== notice.session) {
      this.restartNotice = undefined; return;
    }
    await this.resumeBackground(notice.room, notice.event, notice.session, () => {}, () => this.restartNotice === notice);
  }
  // Called synchronously by the Matrix inbox before /sync advances its checkpoint.
  capture(room: string, event: MatrixEvent): void {
    const o = this.options;
    if (!o.recoverMessages || !event.sender || !o.isAuthorized(event.sender) || event.sender === o.botId ||
        event.type !== 'm.room.message' || !event.event_id || event.content?.[AGENT_TRIGGER] || event.content?.[NOTICE] ||
        event.content?.[SERVICE] || event.content?.['m.relates_to']?.rel_type === 'm.replace' ||
        !Number.isFinite(event.origin_server_ts) || event.origin_server_ts! < o.since ||
        (event.content?.msgtype !== 'm.text' && !isMedia(event.content?.msgtype)) ||
        (!isMedia(event.content?.msgtype) && event.content?.body?.replace(/^>[^\n]*(?:\r?\n>[^\n]*)*\r?\n\r?\n/, '').trim().startsWith('!'))) return;
    o.state.rememberMessage(o.botId, { room, event, feedback: false });
  }
  async recoverMessages(route: (room: string, event: MatrixEvent) => Promise<boolean> = async () => true): Promise<void> {
    if (!this.options.recoverMessages || this.active || this.draining) return;
    const o = this.options, pending = o.state.recoverable(o.botId);
    this.draining = true;
    try {
      for (const message of pending) {
        if (this.stopped || o.isStopping?.()) break;
        const id = message.event.event_id!;
        if (!o.state.recoverable(o.botId).some(m => m.event.event_id === id)) continue;
        if (!message.event.sender || !o.isAuthorized(message.event.sender) || !(await route(message.room, message.event))) {
          o.state.completeMessages(o.botId, [id]); continue;
        }
        o.state.removePending(o.botId, [id]);
        this.replaying.add(id);
        if (message.attempted) this.recoveryNotes.add(id);
        try {
          await this.handleMessage(message.room, message.event, false, undefined, true);
          if (!this.retained.has(id)) o.state.completeMessages(o.botId, [id]);
        }
        catch (error) { o.report(error); }
        finally { this.replaying.delete(id); this.recoveryNotes.delete(id); }
      }
    } finally { this.draining = false; void this.drainQueued().catch(o.report); }
  }
  async handle(room: string, event: MatrixEvent): Promise<void> {
    const o = this.options;
    // Locally created turns are never accepted from Matrix.
    if (!event.sender || !o.isAuthorized(event.sender) || event.sender === o.botId || event.content?.[AGENT_TRIGGER] || event.content?.[NOTICE]) return;
    if (event.type === 'm.reaction') { await this.handleReaction(room, event); return; }
    if (this.replaying.has(event.event_id!)) return;
    this.capture(room, event);
    await this.handleMessage(room, event);
    if (o.recoverMessages && event.event_id && !this.retained.has(event.event_id)) o.state.completeMessages(o.botId, [event.event_id]);
  }

  // A budgeted peer mention prepared by the conversation links. It runs in the
  // human's approval scope, never steers a running task and may end silently.
  async handleAgentMention(room: string, event: MatrixEvent): Promise<void> {
    if (!this.options.linkedSession || !event.content?.[AGENT_TRIGGER]) return;
    await this.handleMessage(room, event, true);
  }

  // `ready` is rechecked synchronously right before admission, after the privacy check.
  async resumeBackground(room: string, event: MatrixEvent, session: string, admitted: () => void, ready?: () => boolean): Promise<boolean> {
    if (this.busy || this.stopped || this.options.isStopping?.()) return false;
    let accepted = false;
    await this.handleMessage(room, event, true, { session, ready, admitted: () => { admitted(); accepted = true; } });
    return accepted;
  }

  async drainQueued(): Promise<void> {
    if ((!this.options.linkedSession && !this.options.recoverMessages) || this.draining || this.active || this.stopped || this.options.isStopping?.()) return;
    this.draining = true;
    try {
      while (!this.active && !this.stopped && !this.options.isStopping?.()) {
        const batch = this.options.state.dequeueBatch(this.options.botId);
        const next = batch[0];
        if (!next) break;
        try { await this.handleMessage(next.room, next.event, next.feedback, undefined, true, batch.map(m => m.event)); }
        catch (error) { this.options.report(error); }
      }
    } finally { this.draining = false; }
  }

  private async handleMessage(room: string, event: MatrixEvent, feedback = false, background?: { session: string; admitted: () => void; ready?: () => boolean }, fromQueue = false, batch: MatrixEvent[] = []): Promise<void> {
    // A watch is lower priority than a human message arriving during its
    // privacy check. It must not reserve the human admission queue.
    if (background) return this.acceptMessage(room, event, feedback, background, fromQueue, batch, () => {});
    const previous = this.admission;
    let admitted!: () => void;
    this.admission = new Promise<void>(resolve => { admitted = resolve; });
    await previous;
    try { await this.acceptMessage(room, event, feedback, background, fromQueue, batch, admitted); }
    finally { admitted(); }
  }

  private async acceptMessage(room: string, event: MatrixEvent, feedback: boolean, background: { session: string; admitted: () => void; ready?: () => boolean } | undefined,
    fromQueue: boolean, batch: MatrixEvent[], admitted: () => void): Promise<void> {
    const o = this.options;
    if (!event.sender || !o.isAuthorized(event.sender) || event.sender === o.botId) return;
    const media = isMedia(event.content?.msgtype);
    if (event.type !== 'm.room.message' || (event.content?.msgtype !== 'm.text' && !media) || !event.event_id) return;
    if (!Number.isFinite(event.origin_server_ts) || (!fromQueue && event.origin_server_ts! < o.since)) return;
    if (event.content?.['m.relates_to']?.rel_type === 'm.replace') return;
    const body = !media && event.content?.['m.relates_to']?.['m.in_reply_to']
      ? event.content.body?.replace(/^>[^\n]*(?:\r?\n>[^\n]*)*\r?\n\r?\n/, '') : event.content?.body;
    const prompt = body?.trim() || (media ? 'An attachment was sent. Describe what you can inspect, or ask what to do with it.' : '');
    if (!prompt || !(await o.isPrivateRoom(room, event.sender)) || !o.isAuthorized(event.sender)) return;
    if (background) {
      if (this.active || this.stopped || o.isStopping?.() || (o.kind !== 'codex' && o.kind !== 'claude') ||
        o.state.session(o.linkedSession?.(room, event) ?? sessionKey(room, event))[o.kind] !== background.session || background.ready?.() === false) return;
    } else if (!fromQueue) {
      if (!o.state.claim(JSON.stringify([o.botId, event.event_id]))) return;
      if (!feedback && !event.content?.[AGENT_TRIGGER] && !prompt.startsWith('!')) o.accepted?.(room, event);
    }
    // Attachments never execute conversation controls. Manager avatar captions are allowed explicitly below.
    const publishCommand = !media && /^!publish(?:\s|$)/.test(prompt);
    const restartSupervisor = !media && /^!restart\s+supervisor$/.test(prompt);
    const verb = publishCommand ? 'publish' : restartSupervisor ? 'restart' : (!media && /^!(help|reset|cancel|restart|usage|status)$/.exec(prompt)?.[1]) || o.kind;
    // All local bots share State. Claim this connector-wide command once,
    // after authorization but before even the stopping/busy reply. Persisting
    // the claim also silences delayed copies received after the restart.
    if (verb === 'restart' && event.sender === o.owner &&
      !o.state.claim(JSON.stringify(['connector-restart', room, event.event_id]))) return;
    const key = sessionKey(room, event);
    const backendKey = o.linkedSession?.(room, event) ?? key;
    // Room-state requests may finish out of order. Preserve incoming admission
    // order, then release before any model work so controls/steering can proceed.
    admitted();
    const reply = (text: string) => this.reply(room, event, text);
    if (this.stopped || o.isStopping?.()) {
      const saved = o.recoverMessages && o.state.recoverable(o.botId).some(m => m.event.event_id === event.event_id);
      if (saved) this.retained.add(event.event_id);
      await reply(saved ? 'The connector is restarting or stopping. Your message will be recovered after restart.'
        : 'The connector is restarting or stopping. Please retry in a few seconds.');
      return;
    }
    if (!media && /^!(approve|deny|answer)(?:\s|$)/.test(prompt)) {
      const current = this.active;
      if (!current || current.key !== key || current.sender !== event.sender) { await reply('No pending confirmation in this conversation.'); return; }
      await this.authorize(room, current);
      await reply(current.interactions.answer(prompt));
      return;
    }
    if (!media && /^!plugin(?:\s|$)/.test(prompt)) {
      if (o.kind !== 'codex') { await reply('Plugin installation is available through Codex bots only.'); return; }
      if (event.sender !== o.owner) { await reply('Only the initial owner can install plugins shared by the Codex account.'); return; }
      if (!/^!plugin install [a-z0-9][a-z0-9-]*(?:@openai-curated-remote)?$/.test(prompt)) { await reply('Use !plugin install NAME, for example !plugin install github.'); return; }
      if (this.active) { await reply('Wait for the current task to finish before installing a plugin.'); return; }
    } else if (!media && prompt.startsWith('!') && verb === o.kind) {
      await reply('Unknown command or invalid syntax. Send !help to see the available commands.');
      return;
    }
    let publication: unknown;
    if (verb === 'publish') {
      if (!o.publish) { await reply('Reviewed publication is not available for this bot.'); return; }
      try { publication = JSON.parse(prompt.slice('!publish'.length).trim()); }
      catch { await reply('Use !publish {"repository":".","remote":"origin","branch":"main"}.'); return; }
    }
    if (verb === 'restart') {
      if (event.sender !== o.owner) { await reply('Only the initial owner can restart the connector.'); return; }
      try {
        if (!o.restart) throw new PublicError('Restart is not configured for this connector.');
        const relation = event.content?.['m.relates_to'];
        await o.restart(reply, { botId: o.botId, roomId: room, sender: event.sender, eventId: event.event_id,
          threadId: relation?.rel_type === 'm.thread' ? relation.event_id : undefined }, restartSupervisor ? 'supervisor' : 'connector');
      } catch (error) {
        o.report(error);
        if (error instanceof PublicError) await reply(error.message);
        // A failed acknowledgement must not cause a restart or a second unsafe delivery attempt.
      }
      return;
    }
    if (media && o.kind === 'manager') {
      try {
        if (event.content?.msgtype !== 'm.image' || !o.acceptManagerAvatar?.(prompt, event.sender)) {
          await reply('The manager only accepts avatar images: use set avatar <bot name> as the caption. Only the connector owner or bot creator can change its profile. Send other files to a Codex or Claude bot.'); return;
        }
      } catch (error) {
        if (!(error instanceof PublicError)) throw error;
        await reply(error.message); return;
      }
    }
    if (verb === 'help') { await this.reply(room, event, help(o.kind), true); return; }
    if (verb === 'status') {
      if (!o.status) { await reply('!status is not available for this bot.'); return; }
      const current = this.active;
      const task = !current ? 'Idle' : current.key !== key ? 'Busy in another conversation'
        : current.controller.signal.aborted ? 'Cancelling' : current.running ? 'Running' : 'Preparing or delivering';
      const queued = current?.key === key ? `\nQueued follow-ups: ${current.followups.length}. Pending updates: ${current.buffered}.` : '';
      await this.reply(room, event, o.status(backendKey) + `\n\n**Task:** ${task}${queued}`
        + (o.linkedSession ? `\nMessages queued across linked rooms: ${o.state.queued(o.botId)}.` : ''), true);
      return;
    }
    // Reads the account's limits without a model request, so it is allowed while a task runs.
    if (verb === 'usage') {
      if (!o.usage) { await reply('!usage is not available for this bot.'); return; }
      if (event.sender !== o.owner) { await reply('Only the initial owner can view the account usage.'); return; }
      try { await this.reply(room, event, await o.usage(AbortSignal.timeout(30_000)), true); }
      catch (error) { o.report(error); await reply(errorMessage(error, 'Could not read account usage')); }
      return;
    }
    if (verb === 'cancel') {
      if (this.restartNotice?.key === key) this.restartNotice = undefined;
      const relation = event.content?.['m.relates_to'];
      const thread = relation?.rel_type === 'm.thread' ? relation.event_id ?? null : null;
      const removed = (o.linkedSession || o.recoverMessages) ? o.state.cancelQueued(o.botId, room, event.sender, thread) : 0;
      const saved = o.recoverMessages ? o.state.cancelMessages(o.botId, room, event.sender, thread) : 0;
      if (this.active?.key === key) {
        this.active.cancelled = true;
        this.active.controller.abort();
        await reply('Cancellation requested. Changes already made are retained.');
      } else await reply(removed || saved ? `Cancelled ${Math.max(removed, saved)} unfinished message(s) in this conversation.` : 'No active task in your conversation.');
      return;
    }
    if (!prompt || prompt.length > 16_000) { await this.reply(room, event, 'Supply a prompt of 1–16,000 characters.\n' + help(o.kind), true); return; }
    if (verb === 'reset' && o.linkedSession) {
      await reply('This agent continues a pinned session across linked rooms. Reset is disabled; explicitly reconfigure its session link to replace that history.'); return;
    }
    const agentTurn = !!event.content?.[AGENT_TRIGGER];
    if (this.active || (this.draining && !fromQueue) || (!fromQueue && o.linkedSession && o.state.queued(o.botId) > 0)) {
      if (agentTurn) {
        // Peer mentions are delivered as their own turn after the current one.
        if (o.state.enqueue(o.botId, { room, event, feedback })) void this.drainQueued().catch(o.report);
        else o.report(new PublicError('A peer mention was dropped because the linked-room queue is full.'));
      } else if ((o.linkedSession || o.recoverMessages) && (verb === 'codex' || verb === 'claude') &&
          (!this.active || (this.active.key !== key && (o.recoverMessages || this.active.backendKey === backendKey)))) {
        if (o.recoverMessages) this.retained.add(event.event_id);
        const accepted = o.state.enqueue(o.botId, { room, event, feedback });
        await reply(accepted ? 'Queued for this agent after its current conversation.' : (o.recoverMessages ? 'The live queue is full. Your message is saved for recovery after restart.' : 'The linked-room queue is full. Please resend after the agent finishes.'));
        void this.drainQueued().catch(o.report);
      } else if ((verb === 'codex' || verb === 'claude') && this.active?.key === key && !this.active.publication && o.steer) {
        await this.steer(this.active, room, event, prompt, feedback);
      } else {
        if (o.recoverMessages) this.retained.add(event.event_id);
        await reply(this.active?.publication
          ? 'A publication review is pending. Use its confirmation controls or !cancel; ordinary messages cannot change the publication.'
          : 'A task is running in this bot. Only messages in its active conversation can steer it; wait before resetting or starting another conversation.');
      }
      return;
    }
    if (verb === 'reset') {
      const relation = event.content?.['m.relates_to'];
      if (o.recoverMessages) o.state.cancelMessages(o.botId, room, event.sender,
        relation?.rel_type === 'm.thread' ? relation.event_id ?? null : null);
      o.state.reset(key); await reply('Your conversation state has been reset.'); return;
    }
    const controller = new AbortController();
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const current: Active = { room, event, key, backendKey, sender: event.sender, controller, running: false, failed: false,
      ready, markReady, inputIds: (batch.length ? batch : [event]).map(e => e.event_id!), publication: verb === 'publish', steering: Promise.resolve(), buffered: 0, followups: [], interactions: new Interactions() };
    if (o.recoverMessages) {
      for (const id of current.inputIds) this.retained.add(id);
      o.state.attempted(o.botId, current.inputIds);
    }
    this.active = current;
    current.typing = o.typing ? taskTyping((typing, timeout) => o.typing!(room, typing, timeout),
      async () => await o.isPrivateRoom(room, current.sender) && o.isAuthorized(current.sender), o.report, controller.signal) : undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, o.timeoutMs);
    try {
      background?.admitted();
      if (verb === 'publish') await reply('Preparing the complete publication review…');
      const attachments: IncomingAttachment[] = [];
      for (const input of batch.length ? batch : [event]) attachments.push(...await this.receive(room, input, current));
      const initialPrompt = batch.length > 1 ? 'Queued messages from the same human in this conversation, in order:\n'
        + JSON.stringify(batch.map(e => ({ id: e.event_id, text: e.content?.body, type: e.content?.msgtype }))) : prompt;
      let next: Followup | undefined = { prompt: this.recoveryNotes.has(event.event_id!)
        ? 'Connector recovery after restart: the previous turn for this message did not finish successfully. It may have performed actions or sent replies already. Inspect the existing results before continuing; do not blindly repeat external actions or reuse expired confirmations. Original message follows:\n\n' + initialPrompt
        : initialPrompt, event, attachments };
      while (next) {
        controller.signal.throwIfAborted();
        await this.authorize(room, current);
        current.running = true;
        const requestEvent = next.event;
        const turnLifetime = new AbortController();
        const interact: Interact = (request, requestSignal) => current.interactions.ask(request,
          AbortSignal.any([controller.signal, requestSignal]), async (text, controls, markdown) => {
            await this.authorize(room, current);
            if (request.attachments?.length) {
              if (!o.sendAttachments) throw new PublicError('Review attachment delivery is not configured.');
              await this.deliver(room, () => o.sendAttachments!(room, requestEvent, request.attachments!, AbortSignal.any([controller.signal, requestSignal])));
              await this.authorize(room, current);
              requestSignal.throwIfAborted();
            }
            if (o.confirmation) await this.deliver(room, () => o.confirmation!(room, requestEvent, text, controls, markdown));
            else await this.reply(room, requestEvent, text);
          });
        const publish: PublishAction | undefined = o.publish ? async (input, callSignal) => {
          if (current.publication) throw new PublicError('A publication review is already pending.');
          const signal = AbortSignal.any([controller.signal, turnLifetime.signal, callSignal]);
          signal.throwIfAborted();
          current.publication = true;
          try {
            await this.authorize(room, current);
            signal.throwIfAborted();
            return await o.publish!(input, signal, interact, () => this.authorize(room, current));
          }
          finally { current.publication = false; }
        } : undefined;
        const messages = o.roomMessages && roomMessageDelivery((request, signal) =>
          o.roomMessages!(request, { room, event: requestEvent, key: backendKey }, signal));
        const hooks: BackendHooks = {
          compaction: o.compaction ? async phase => {
            try {
              // Unlike progress, an interrupted-compaction notice is useful after
              // cancellation too. The destination rechecks access independently.
              if (!o.isAuthorized(current.sender)) return;
              const destination = o.compactionRoom ?? room;
              await this.deliver(destination, () => o.compaction!(phase, { room: destination, sender: current.sender }));
            } catch (error) { o.report(error); }
          } : undefined,
          roomMessages: messages ? async (input, callSignal, outbox) => {
            const signal = AbortSignal.any([controller.signal, turnLifetime.signal, callSignal]);
            signal.throwIfAborted();
            await this.authorize(room, current);
            signal.throwIfAborted();
            return messages(input, signal, outbox);
          } : undefined,
          sendAttachments: o.sendAttachments ? async (files, callSignal) => {
            const signal = AbortSignal.any([controller.signal, turnLifetime.signal, callSignal]);
            signal.throwIfAborted();
            await this.authorize(room, current);
            signal.throwIfAborted();
            await this.deliver(room, () => o.sendAttachments!(room, requestEvent, files, signal));
          } : undefined,
          background: o.background ? async (input, callSignal) => {
            const signal = AbortSignal.any([controller.signal, turnLifetime.signal, callSignal]);
            signal.throwIfAborted();
            await this.authorize(room, current);
            signal.throwIfAborted();
            return o.background!(input, { room, event: requestEvent, key: backendKey }, signal);
          } : undefined,
          progress: async text => {
            turnLifetime.signal.throwIfAborted();
            await this.authorize(room, current);
            turnLifetime.signal.throwIfAborted();
            await this.reply(room, requestEvent, text, true, 'm.text');
          },
        };
        let modelPrompt = next.prompt.startsWith('!') ? next.prompt
          : o.decoratePrompt?.(room, next.event, next.prompt) ?? next.prompt;
        if (next.event.content?.[NOTICE] === 'restart' && !o.decoratePrompt) {
          modelPrompt = 'Connector restart notice (not a human message):\n' + modelPrompt;
        }
        const restart = this.restartNotice;
        if (verb !== 'publish' && !next.prompt.startsWith('!') && restart?.key === backendKey &&
            o.state.session(backendKey)[o.kind as 'codex' | 'claude'] === restart.session) {
          if (next.event.content?.[NOTICE] !== 'restart') modelPrompt += '\n\nConnector restart notice:\n' + RESTART_PROMPT;
          // Consume only when a model turn actually begins, not at privacy
          // checks or admission. A backend failure gets no immediate retry.
          this.restartNotice = undefined;
        }
        const task = verb === 'publish' ? o.publish!(publication, controller.signal, interact, () => this.authorize(room, current))
          : o.run(verb as Mode, modelPrompt,
            backendKey, controller.signal, event.sender, next.attachments, interact, publish, hooks);
        current.markReady();
        let result: string | BackendReply;
        try { result = await task; if (verb !== 'publish' && !next.prompt.startsWith('!')) o.promptDelivered?.(); }
        finally { turnLifetime.abort(); current.running = false; current.interactions.close(); }
        while (current.buffered) await current.steering;
        controller.signal.throwIfAborted();
        const command = next.prompt.startsWith('!'), responseEvent = next.event;
        const files = typeof result === 'string' ? [] : result.attachments;
        const mention = command ? undefined : o.mentions?.(room, typeof result === 'string' ? result : result.text);
        const text = mention?.text ?? (typeof result === 'string' ? result : result.text);
        const mentions = mention?.mentions.length ? mention.mentions : undefined;
        const sendFiles = async () => {
          if (!files.length) return;
          if (!o.sendAttachments) throw new PublicError('Attachment sending is not configured.');
          await this.deliver(room, () => o.sendAttachments!(room, responseEvent, files, controller.signal));
        };
        // A peer-started turn, or any turn in a shared room, may decline to
        // answer: the text is dropped, attachments are still sent. Commands
        // always report their result.
        const peerTurn = !!responseEvent.content?.[AGENT_TRIGGER];
        const quiet = (responseEvent.content?.[NOTICE] === 'restart' || peerTurn || (!command && !!o.shared?.(room))) && (text.trim() === 'NO_REPLY' || (peerTurn && !text.trim()));
        if (!quiet || files.length) {
          // A mention wakes the peer, so it goes out only after everything else.
          if (mentions) await sendFiles();
          const respond = (body: string) => this.reply(room, responseEvent, body, !command, command ? 'm.notice' : 'm.text', mentions);
          // A declined reply sends no text and wakes nobody.
          if (!quiet && (text || mentions)) await respond(text);
          else if (!quiet && !files.length) await respond(typeof result === 'string' ? 'The task completed without a text response.' : 'The task completed without a response.');
          if (!mentions) await sendFiles();
          if (!quiet && mention?.error) await this.reply(room, responseEvent, mention.error);
        }
        while (current.buffered) await current.steering;
        const completed = current.inputIds.filter(id => !current.followups.some(f => f.event.event_id === id));
        if (o.recoverMessages) o.state.completeMessages(o.botId, completed);
        for (const id of completed) this.retained.delete(id);
        current.inputIds = current.inputIds.filter(id => !completed.includes(id));
        next = current.followups.shift();
      }
    } catch (error) {
      current.failed = true;
      current.markReady();
      while (current.buffered) await current.steering;
      o.report(error);
      if (current.sender === o.owner && o.isAuthorized(current.sender)) {
        try { await o.ownerDiagnostic?.(error, { room, sender: current.sender }); }
        catch (deliveryError) { o.report(deliveryError); }
      }
      await reply(o.recoverMessages && !current.cancelled && current.inputIds.some(id => o.state.recoverable(o.botId).some(m => m.event.event_id === id))
        ? errorMessage(error) + ' Your unfinished messages are saved. Restart Riftjack to resume them; actions already performed may need checking.'
        : controller.signal.aborted
        ? `Task ${timedOut ? 'timed out' : 'cancelled'}. Pending follow-ups were discarded. Changes already made are retained.`
        : errorMessage(error) + (current.followups.length ? ' Pending follow-ups were not run; please resend them.' : ''));
    } finally {
      if (current.cancelled || !o.isAuthorized(current.sender)) {
        if (o.recoverMessages) o.state.completeMessages(o.botId, current.inputIds);
        for (const id of current.inputIds) this.retained.delete(id);
      }
      current.interactions.close();
      clearTimeout(timeout);
      await current.typing?.close();
      this.active = undefined;
      void this.drainQueued().catch(o.report);
    }
  }

  private async handleReaction(room: string, event: MatrixEvent): Promise<void> {
    const o = this.options, current = this.active;
    const relation = event.content?.['m.relates_to'];
    if (feedbackMeaning(relation?.key)) {
      if (this.stopped || o.isStopping?.() || o.kind === 'manager' || !o.reactionTarget ||
        !Number.isFinite(event.origin_server_ts) || event.origin_server_ts! < o.since) return;
      const feedback = await reactionFeedback(room, event, { botId: o.botId, authorized: o.isAuthorized,
        privateRoom: o.isPrivateRoom, read: o.reactionTarget });
      if (feedback) await this.handleMessage(room, feedback, true);
      return;
    }
    if (this.stopped || o.isStopping?.() || !current || current.failed || current.room !== room || current.sender !== event.sender ||
      !event.event_id || !Number.isFinite(event.origin_server_ts) || event.origin_server_ts! < o.since ||
      relation?.rel_type !== 'm.annotation' || !relation.event_id || !['✅', '❌', '🔖', '✅\uFE0F', '❌\uFE0F', '🔖\uFE0F'].includes(relation.key || '') ||
      !current.interactions.hasReactionTarget(relation.event_id)) return;
    // Reactions carry the confirmation event ID, not a thread relation. The
    // exact bound message supplies the room/thread scope; never guess a request.
    await this.authorize(room, current);
    if (this.active !== current || !o.state.claim(JSON.stringify([o.botId, event.event_id]))) return;
    const answer = current.interactions.react(relation.event_id, relation.key!);
    if (answer) await this.reply(room, current.event, answer);
  }

  private async authorize(room: string, active: Active): Promise<void> {
    if (!this.options.isAuthorized(active.sender) || !(await this.options.isPrivateRoom(room, active.sender))) throw new PublicError('Task stopped because access or room membership changed.');
    active.controller.signal.throwIfAborted();
    if (!this.options.isAuthorized(active.sender)) throw new PublicError('Account access was revoked.');
  }

  private async receive(room: string, event: MatrixEvent, active: Active): Promise<IncomingAttachment[]> {
    await this.authorize(room, active);
    if (!isMedia(event.content?.msgtype)) return [];
    if (!this.options.receive) throw new PublicError('Attachment reception is not configured.');
    let file = await this.options.receive(event, active.key, active.controller.signal, () => this.authorize(room, active));
    await this.authorize(room, active);
    if (this.options.transcribe) {
      file = await this.options.transcribe(file, active.controller.signal);
      await this.authorize(room, active);
    }
    return [file];
  }

  private async steer(active: Active, room: string, event: MatrixEvent, prompt: string, feedback = false): Promise<void> {
    const o = this.options;
    if (active.buffered + active.followups.length >= 10) {
      if (o.recoverMessages) this.retained.add(event.event_id!);
      await this.reply(room, event, o.recoverMessages
        ? 'Too many pending updates. Your message is saved for recovery after restart.'
        : 'Too many pending messages. Wait for the agent to catch up.'); return;
    }
    if (o.recoverMessages) {
      this.retained.add(event.event_id!);
      active.inputIds.push(event.event_id!);
      o.state.attempted(o.botId, [event.event_id!]);
    }
    active.buffered++;
    const operation = active.steering.then(async () => {
      const attachments = await this.receive(room, event, active);
      await active.ready;
      active.controller.signal.throwIfAborted();
      if (active.failed) throw new PublicError('The task failed before your update could be applied. Please resend your message.');
      await this.authorize(room, active);
      const accepted = active.running && await o.steer!(o.decoratePrompt?.(room, event, prompt, true) ?? prompt,
        active.backendKey, active.controller.signal, active.sender, attachments);
      if (!accepted) active.followups.push({ prompt, event, attachments });
      try {
        if (!feedback) await this.reply(room, event, accepted ? 'Added your message to the current task.' : o.queuedUpdateMessage || 'The current task is finishing. Your message will be processed next.');
      } catch (error) { o.report(error); }
    }).catch(async error => {
      active.inputIds = active.inputIds.filter(id => id !== event.event_id);
      o.report(error);
      const message = active.controller.signal.aborted ? 'Your update was not applied because the task was stopped.'
        : errorMessage(error, 'Could not confirm delivery of your update to the agent') + ' Please check the task result before resending.';
      try { await this.reply(room, event, message); } catch (replyError) { o.report(replyError); }
    }).finally(() => { active.buffered--; });
    active.steering = operation;
    await operation;
  }
}

export function messageParts(text: string): string[] {
  const parts: string[] = [];
  // 3000 Unicode code points stay below Matrix's event size limit, including escaping.
  const points = Array.from(text.slice(0, 100_000));
  for (let i = 0; i < points.length; i += 3000) parts.push(points.slice(i, i + 3000).join(''));
  if (text.length > 100_000) parts.push('[Response truncated at 100,000 characters.]');
  return parts;
}
