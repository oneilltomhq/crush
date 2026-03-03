/**
 * agent-helpers.ts — Pure/testable functions extracted from agent-server.
 */
import type { WebSocket } from 'ws';

/** Send a JSON message over WebSocket if open. */
export function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === 1 /* WebSocket.OPEN */) ws.send(JSON.stringify(msg));
}

/** Extract spoken text from an assistant message's content blocks. */
export function extractText(msg: any): string {
  if (msg.role !== 'assistant') return '';
  return msg.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join(' ')
    .trim();
}

/**
 * Push a worker event into the FOH agent so it proactively speaks to the user.
 * - If FOH is idle: call prompt() directly
 * - If FOH is busy: use steer() to inject mid-conversation
 *
 * conn must have: { ws, id, agent, processing }
 */
export async function notifyFoh(
  conn: { ws: WebSocket; id: string; agent: any; processing: boolean },
  notification: string,
): Promise<void> {
  const tag = `[foh:${conn.id}]`;
  console.log(`${tag} Worker notification: ${notification.substring(0, 100)}`);

  const msg = `[Worker notification — tell the user immediately]: ${notification}`;

  if (conn.processing) {
    console.log(`${tag} FOH busy, steering`);
    conn.agent.steer({ role: 'user', content: msg, timestamp: Date.now() });
  } else {
    console.log(`${tag} FOH idle, prompting`);
    conn.processing = true;
    try {
      send(conn.ws, { type: 'thinking' });
      await conn.agent.prompt(msg);
      const messages = conn.agent.state.messages;
      const lastAssistant = [...messages].reverse().find((m: any) => m.role === 'assistant');
      const spoken = lastAssistant ? extractText(lastAssistant) : '';
      if (spoken) {
        send(conn.ws, { type: 'response', text: spoken });
        console.log(`${tag} Proactive: "${spoken.substring(0, 80)}"`);
      }
    } catch (err: any) {
      console.error(`${tag} Notify error:`, err.message);
    } finally {
      conn.processing = false;
    }
  }
}
