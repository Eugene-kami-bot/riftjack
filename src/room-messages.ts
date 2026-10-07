import { PublicError } from './errors.js';
import type { ConversationLinks } from './conversation-links.js';
import { GRANT, type MatrixEvent } from './bridge.js';
import { attachmentDelivery } from './attachment-delivery.js';
import { isMedia, outgoingAttachments, type IncomingAttachment, type OutgoingAttachment } from './media.js';

// mention: also start the other agent of that shared room, paid with peer credit.
export type MessageRequest = { action: 'list' }
  | { action: 'send'; room: string; text: string; id: string; mention?: boolean }
  | { action: 'receive_attachment'; room: string; event_id: string }
  | { action: 'send_files'; room: string; id: string; files: { path: string; name?: string }[]; outbox: string };
export type MessageAction = (request: MessageRequest, signal: AbortSignal) => Promise<string>;
export type RoomMessageTool = (input: unknown, signal: AbortSignal, outbox?: string) => Promise<string>;

export function linkedRoomMessages(links: ConversationLinks, bot: string,
  context: { event: MatrixEvent; key: string }, transport: {
    allowed(room: string, sender: string): Promise<boolean>;
    stopping(): boolean;
    send(room: string, content: { msgtype: 'm.text'; body: string; 'm.mentions': { user_ids: string[] }; [GRANT]?: string }): Promise<string>;
    read?(room: string, eventId: string): Promise<MatrixEvent | undefined>;
    receive?(event: MatrixEvent, key: string, signal: AbortSignal, authorize: () => Promise<void>): Promise<IncomingAttachment>;
    maxBytes?: number;
    sendFiles?(room: string, files: OutgoingAttachment[], signal: AbortSignal, authorize: () => Promise<void>): Promise<void>;
  }): MessageAction {
  return async (request, signal) => {
    // The agent's own DM with the same human is also a destination, so a result
    // that arrived in a shared room can be returned where the human asked for it.
    const home = links.agent(bot)?.home;
    const allowed = async (target: string) => {
      signal.throwIfAborted();
      const linked = () => (target === home || !!links.room(bot, target)) && links.key(bot, target, context.event) === context.key && !transport.stopping();
      if (!linked() || !(await transport.allowed(target, context.event.sender!)) || !linked()) {
        throw new PublicError('Room message withheld: destination access, membership or privacy changed.');
      }
      signal.throwIfAborted();
    };
    if (request.action === 'list') {
      const rooms: { room: string; type: 'shared' | 'private' }[] = [];
      for (const target of [...links.sharedRooms(bot), ...home ? [home] : []]) {
        try { await allowed(target); rooms.push({ room: target, type: target === home ? 'private' : 'shared' }); }
        catch { signal.throwIfAborted(); }
      }
      return JSON.stringify({ rooms });
    }
    await allowed(request.room);
    if (request.action === 'receive_attachment') {
      const shared = links.room(bot, request.room);
      if (!shared || !transport.read || !transport.receive) throw new PublicError('Attachment retrieval requires a linked shared room.');
      const event = await transport.read(request.room, request.event_id);
      await allowed(request.room);
      if (!event || event.event_id !== request.event_id || (event.room_id && event.room_id !== request.room) ||
          event.type !== 'm.room.message' || ![shared.owner, ...shared.bots].includes(event.sender!) ||
          !isMedia(event.content?.msgtype) || !event.content?.file || event.content['m.relates_to']?.rel_type === 'm.replace') {
        throw new PublicError('No encrypted attachment found on that shared-room message.');
      }
      const file = await transport.receive(event, context.key, signal, () => allowed(request.room));
      // receive authorizes immediately before exposing plaintext. Once saved,
      // return its receipt: a later revocation cannot undo that completed read.
      return JSON.stringify({ status: 'received', room: request.room, event_id: request.event_id, file });
    }
    if (request.action === 'send_files') {
      if (!transport.sendFiles || transport.maxBytes === undefined) throw new PublicError('Room attachment delivery is not configured.');
      const delivery = attachmentDelivery(request.outbox, transport.maxBytes, (files, signal) =>
        transport.sendFiles!(request.room, files, signal, () => allowed(request.room)));
      const result = await delivery.action({ files: request.files }, signal);
      return JSON.stringify({ room: request.room, ...JSON.parse(result) });
    }
    if (request.mention && request.room === home) throw new PublicError('Room message withheld: mention is only for the other agent of a shared room.');
    // The mention is paid now; its grant lets the peer start exactly once.
    const peer = request.mention ? links.room(bot, request.room)!.bots.find(id => id !== bot) : undefined;
    const grant = request.mention ? links.reserve(bot, request.room) : undefined;
    if (request.mention && !grant) throw new PublicError('Room message withheld: no peer credit is left for a mention. It is restored when the human next writes to you; send without mention instead.');
    // Use the running client's encryption state. Do not inherit private thread
    // relations, approvals or a human origin from the source room.
    const eventId = await transport.send(request.room, {
      msgtype: 'm.text', body: peer ? request.text + '\n\n' + peer : request.text, 'm.mentions': { user_ids: peer ? [peer] : [] },
      ...(grant && { [GRANT]: grant }),
    });
    return JSON.stringify({ status: 'sent', room: request.room, event_id: eventId });
  };
}

// One instance per backend turn. Cache failures too: an uncertain send must never
// be repeated automatically. This is deliberately not a persistent outbox.
export function roomMessageDelivery(send: MessageAction): RoomMessageTool {
  const attempts = new Map<string, { content: string; result: Promise<string> }>();
  return async (input, signal, outbox) => {
    signal.throwIfAborted();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublicError('Expected a room message request.');
    const r = input as Record<string, unknown>;
    if (r.action === 'list' && Object.keys(r).length === 1) return send({ action: 'list' }, signal);
    const roomValid = typeof r.room === 'string' && /^![^\s:]+:[^\s]+$/.test(r.room);
    if (r.action === 'receive_attachment') {
      if (!roomValid || Object.keys(r).some(k => !['action', 'room', 'event_id'].includes(k)) ||
          typeof r.event_id !== 'string' || !/^\$[^\s]{1,1023}$/.test(r.event_id)) {
        throw new PublicError('Use receive_attachment with a linked shared room and an exact Matrix event_id.');
      }
      return send({ action: 'receive_attachment', room: r.room as string, event_id: r.event_id }, signal);
    }
    if (r.action === 'send_files') {
      if (!roomValid || !outbox || Object.keys(r).some(k => !['action', 'room', 'id', 'files'].includes(k)) ||
          typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(r.id) || !Array.isArray(r.files) || !r.files.length ||
          r.files.some(f => !f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some(k => !['path', 'name'].includes(k)))) {
        throw new PublicError('Use send_files with room, a unique id and files from the current outbox.');
      }
      outgoingAttachments({ files: r.files }, outbox);
      const files = r.files.map(file => ({ path: file.path as string, ...(file.name !== undefined && { name: file.name as string }) }));
      return attempt(r.id, { action: 'send_files', room: r.room as string, id: r.id, files, outbox }, signal);
    }
    if (r.action !== 'send' || Object.keys(r).some(k => !['action', 'room', 'text', 'id', 'mention'].includes(k)) ||
        typeof r.room !== 'string' || !/^![^\s:]+:[^\s]+$/.test(r.room) ||
        typeof r.text !== 'string' || !r.text.trim() || Buffer.byteLength(r.text, 'utf8') > (r.mention ? 6000 : 8000) ||
        typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(r.id) || (r.mention !== undefined && typeof r.mention !== 'boolean')) {
      // A mentioning message must fit whole into the notice that quotes it.
      throw new PublicError('Use action=list, or action=send with room, text (up to 8000 UTF-8 bytes, or 6000 with mention), a unique id (letters, digits, underscore or hyphen; up to 80 characters) and optional mention (true to start the other agent).');
    }
    const request: MessageRequest = { action: 'send', room: r.room, text: r.text, id: r.id, ...(r.mention && { mention: true }) };
    return attempt(r.id, request, signal);
  };
  function attempt(id: string, request: MessageRequest, signal: AbortSignal) {
    const content = JSON.stringify(request);
    const previous = attempts.get(id);
    if (previous) {
      if (previous.content !== content) throw new PublicError('This message id was already used with different content.');
      return previous.result;
    }
    if (attempts.size >= 32) throw new PublicError('Room message limit reached for this turn.');
    const result = Promise.resolve().then(() => { signal.throwIfAborted(); return send(request, signal); });
    attempts.set(id, { content, result });
    return result;
  }
}
