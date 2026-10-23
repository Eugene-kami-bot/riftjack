import { createHash } from 'node:crypto';
import { PublicError } from './errors.js';
import type { ConversationLinks } from './conversation-links.js';
import { linkedRoomMessages, roomMessageDelivery, type RoomMessageTool } from './room-messages.js';
import type { MatrixEvent } from './bridge.js';

type OwnerTurn = { id: string; time: number };

// Persistent room messaging for an authenticated external worker. Unlike the
// task-local coding-agent MCP, the worker declares the durable event that
// represents an owner message accepted on another trusted channel. Riftjack
// consumes that event once to restore the same bounded peer credit Matrix gives.
export function workerRoomMessages(links: ConversationLinks, bot: string, owner: string,
  transport: Parameters<typeof linkedRoomMessages>[3]): RoomMessageTool {
  const event: MatrixEvent = { type: 'm.room.message', sender: owner, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: '' } };
  const home = links.agent(bot)?.home;
  if (!home) throw new PublicError('The external worker is not linked to a conversation.');
  const action = linkedRoomMessages(links, bot, { event, key: links.key(bot, home, event) }, transport);
  const deliver = roomMessageDelivery(action);
  return async (input, signal) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublicError('Expected a worker room-message request.');
    const raw = input as Record<string, unknown>, ownerTurn = raw.owner_turn as OwnerTurn | undefined;
    if (ownerTurn !== undefined) {
      if (raw.action !== 'send' || (raw.mention !== true && !(Array.isArray(raw.mentions) && raw.mentions.length > 0)) || !ownerTurn || typeof ownerTurn !== 'object' ||
          Array.isArray(ownerTurn) || Object.keys(ownerTurn).some(k => !['id', 'time'].includes(k)) ||
          typeof ownerTurn.id !== 'string' || typeof ownerTurn.time !== 'number' || !Number.isSafeInteger(ownerTurn.time) ||
          !links.creditExternal(bot, ownerTurn.id, ownerTurn.time)) {
        throw new PublicError('owner_turn must identify a fresh authenticated human event from the last 24 hours.');
      }
    }
    const request = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'owner_turn'));
    if (request.action !== 'send') return deliver(request, signal);
    if (typeof request.id !== 'string') return deliver(request, signal);
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = links.beginExternalSend(bot, request.id, digest);
    if (previous) return JSON.stringify(previous.status === 'sent'
      ? { status: 'sent', room: request.room, event_id: previous.eventId, replayed: true }
      : { status: 'uncertain', room: request.room, replayed: true });
    const result = await deliver(request, signal);
    const parsed = JSON.parse(result) as { status?: string; event_id?: string };
    if (parsed.status === 'sent' && typeof parsed.event_id === 'string') links.finishExternalSend(bot, request.id, digest, parsed.event_id);
    return result;
  };
}
