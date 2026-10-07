import { SERVICE } from './bridge.js';
import { OwnerDiagnosticError, PublicError } from './errors.js';

// Destination and ownership come from connector configuration, never error text.
export async function sendOwnerDiagnostic(error: unknown, sender: string, owner: string, room: string, transport: {
  allowed(room: string): Promise<boolean>; stopping(): boolean;
  send(room: string, content: { msgtype: 'm.notice'; body: string; 'm.mentions': object; [SERVICE]: boolean }): Promise<unknown>;
}) {
  if (sender !== owner || !(error instanceof OwnerDiagnosticError) || !error.ownerDetails()) return;
  const text = `${error.message}\n\nOriginal Codex diagnostic:\n${error.ownerDetails()}`;
  const points = Array.from(text);
  for (let offset = 0; offset < points.length; offset += 3000) {
    if (transport.stopping() || !(await transport.allowed(room)) || transport.stopping()) {
      throw new PublicError('Owner diagnostic withheld because private room access changed or the connector is stopping.');
    }
    await transport.send(room, { msgtype: 'm.notice', body: points.slice(offset, offset + 3000).join(''), 'm.mentions': {}, [SERVICE]: true });
  }
}
