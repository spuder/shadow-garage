// Test double for Transport: records everything written and answers via a scripted responder.

import { ByteQueue, TransportClosedError, type Transport } from "./transport";

const latin1 = new TextDecoder("latin1");
const encoder = new TextEncoder();

/** Given the text of one write, return the device's reply (ETX included), or null for no reply. */
export type Responder = (written: string) => string | null;

export class FakeTransport implements Transport {
  readonly label = "fake cutter";
  readonly writes: string[] = [];
  closed = false;
  private readonly queue = new ByteQueue();
  private readonly respond: Responder;

  constructor(respond: Responder) {
    this.respond = respond;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new TransportClosedError();
    const text = latin1.decode(bytes);
    this.writes.push(text);
    const reply = this.respond(text);
    if (reply !== null) this.queue.push(encoder.encode(reply));
  }

  read(timeoutMs: number): Promise<Uint8Array> {
    return this.queue.take(timeoutMs);
  }

  drain(): Uint8Array[] {
    return this.queue.drain();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.fail(new TransportClosedError());
  }

  /** Every command sent, in order, with ETX shown as "|" and ESC x as "<ESC x>". */
  get log(): string[] {
    return this.writes
      .join("")
      .replace(/\x1b\x04/g, "<ESC EOT>\x03")
      .replace(/\x1b\x05/g, "<ESC ENQ>\x03")
      .split("\x03")
      .filter((c) => c.length > 0);
  }
}

export interface Cameo3Script {
  /** Status replies (without ETX), consumed in order; the last one repeats. Default: always "0" (ready). */
  statuses?: string[];
  /**
   * Reply to the registration-mark search (ETX included), or null to never answer. Default: found.
   * An array gives one reply per search, in order; the last one repeats.
   */
  regmarkReply?: string | null | (string | null)[];
}

/** A scripted Cameo 3 that answers the init queries, status polls and mark search. */
export function cameo3Responder({ statuses = ["0"], regmarkReply = "    0\x03" }: Cameo3Script = {}): Responder {
  const queue = [...statuses];
  const searches = Array.isArray(regmarkReply) ? [...regmarkReply] : [regmarkReply];
  const replies: Record<string, string> = {
    "FG\x03": "CAMEO V1.10    \x03",
    "TB71\x03": "    0,    0\x03",
    "FA\x03": "    0,    0\x03",
    "TC\x03": "0,0\x03",
  };
  return (written) => {
    if (written === "\x1b\x05") return (queue.length > 1 ? queue.shift()! : queue[0]) + "\x03";
    if (written in replies) return replies[written];
    if (/TB12[34],[^\x03]*\x03$/.test(written)) return searches.length > 1 ? searches.shift()! : searches[0];
    return null;
  };
}
