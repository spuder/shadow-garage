// A byte pipe to a cutter. Protocols (graphtec.ts, ...) sit on top of this and never touch
// WebUSB / Web Serial / Web Bluetooth directly, so adding a transport (webUsbTransport.ts,
// webSerialTransport.ts for Bluetooth RFCOMM; future: BLE via Web Bluetooth) is one new file
// implementing this interface.

export interface Transport {
  /** Human-readable description of the connected device, for the status line. */
  readonly label: string;
  write(bytes: Uint8Array): Promise<void>;
  /** Resolves with the next chunk of received bytes (at least one byte), or rejects with TransportTimeoutError. */
  read(timeoutMs: number): Promise<Uint8Array>;
  /** Discards any received-but-unread bytes (stale replies, spurious diagnostics), returning them for logging. */
  drain(): Uint8Array[];
  close(): Promise<void>;
}

export class TransportTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`No reply from the cutter within ${timeoutMs} ms`);
    this.name = "TransportTimeoutError";
  }
}

export class TransportClosedError extends Error {
  constructor(reason = "Connection to the cutter was closed") {
    super(reason);
    this.name = "TransportClosedError";
  }
}

/**
 * Inbound byte buffer shared by transports whose reads can't be cancelled (WebUSB's transferIn
 * can't be aborted on a timeout — an abandoned transferIn would silently swallow the next reply).
 * The transport runs one continuous read loop that push()es into this; read() just waits on it.
 */
export class ByteQueue {
  private chunks: Uint8Array[] = [];
  private waiter: { resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  push(bytes: Uint8Array) {
    if (bytes.length === 0) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(bytes);
    } else {
      this.chunks.push(bytes);
    }
  }

  /** Fails any pending and future reads (device unplugged, closed). */
  fail(err: Error) {
    this.failure = err;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }

  drain(): Uint8Array[] {
    const dropped = this.chunks;
    this.chunks = [];
    return dropped;
  }

  take(timeoutMs: number): Promise<Uint8Array> {
    if (this.chunks.length > 0) return Promise.resolve(this.chunks.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) return Promise.reject(new Error("ByteQueue: concurrent reads are not supported"));
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new TransportTimeoutError(timeoutMs));
      }, timeoutMs);
      this.waiter = {
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }
}

export interface LogEntry {
  t: number; // ms since the log started
  kind: "out" | "in" | "dropped" | "note";
  text: string;
}

/** Makes raw protocol bytes readable: ETX shown as "|", ESC sequences and other control bytes named. */
export function printable(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x1b && i + 1 < bytes.length) {
      const code = bytes[++i];
      out += code === 0x04 ? "<ESC EOT>" : code === 0x05 ? "<ESC ENQ>" : `<ESC ${code.toString(16).padStart(2, "0")}>`;
    } else if (b === 0x03) out += "|";
    else if (b < 0x20 || b > 0x7e) out += `<${b.toString(16).padStart(2, "0")}>`;
    else out += String.fromCharCode(b);
  }
  return out;
}

const STATUS_QUERY = "<ESC ENQ>";

/**
 * Records everything sent to and received from the cutter, for diagnosing hardware behaviour.
 * Keeps the first HEAD entries for good (handshake, setup, mark search are the interesting part)
 * plus the most recent TAIL, so a long cut's status polling can't push them out.
 *
 * Back-to-back status polls with the same reply are counted rather than logged one by one: a cut
 * polls every 50 ms, so an 80 s packet would otherwise add ~1,600 identical lines. The first poll
 * and every change of status are still logged in full.
 */
export class LoggingTransport implements Transport {
  static readonly HEAD = 400;
  static readonly TAIL = 1600;

  private readonly inner: Transport;
  private readonly start = Date.now();
  private readonly head: LogEntry[] = [];
  private tail: LogEntry[] = [];
  private omitted = 0;
  /** A status query waiting for its reply, which decides whether it's logged or counted. */
  private pendingPoll: LogEntry | null = null;
  /** The reply of the last status poll logged in full, while nothing else has happened since. */
  private lastPollReply: string | null = null;
  private repeats = { count: 0, from: 0, to: 0 };

  constructor(inner: Transport) {
    this.inner = inner;
  }

  get label(): string {
    return this.inner.label;
  }

  private now(): number {
    return Date.now() - this.start;
  }

  private record(entry: LogEntry) {
    if (this.head.length < LoggingTransport.HEAD) {
      this.head.push(entry);
      return;
    }
    this.tail.push(entry);
    if (this.tail.length > LoggingTransport.TAIL) {
      this.tail = this.tail.slice(-LoggingTransport.TAIL);
      this.omitted++;
    }
  }

  private repeatSummary(): LogEntry | null {
    const { count, from, to } = this.repeats;
    if (count === 0 || this.lastPollReply === null) return null;
    const reply = this.lastPollReply.replace(/\|$/, "");
    return { t: to, kind: "note", text: `status ${reply} repeated ${count} more time${count === 1 ? "" : "s"} over ${((to - from) / 1000).toFixed(1)} s` };
  }

  private flushRepeats() {
    const summary = this.repeatSummary();
    if (summary) this.record(summary);
    this.repeats = { count: 0, from: 0, to: 0 };
  }

  /** Something other than a repeated status poll happened: log any counted run and the pending query. */
  private endPollRun() {
    this.flushRepeats();
    if (this.pendingPoll) this.record(this.pendingPoll);
    this.pendingPoll = null;
    this.lastPollReply = null;
  }

  private add(kind: LogEntry["kind"], text: string) {
    this.endPollRun();
    this.record({ t: this.now(), kind, text });
  }

  note(text: string) {
    this.add("note", text);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const text = printable(bytes);
    if (text === STATUS_QUERY) {
      if (this.pendingPoll) this.endPollRun(); // the previous query never got a reply
      this.pendingPoll = { t: this.now(), kind: "out", text };
    } else {
      this.add("out", text);
    }
    await this.inner.write(bytes);
  }

  async read(timeoutMs: number): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = await this.inner.read(timeoutMs);
    } catch (e) {
      this.endPollRun();
      throw e;
    }
    const text = printable(bytes);
    const poll = this.pendingPoll;
    if (!poll) {
      this.add("in", text);
      return bytes;
    }
    this.pendingPoll = null;
    const t = this.now();
    if (text === this.lastPollReply) {
      if (this.repeats.count === 0) this.repeats.from = poll.t;
      this.repeats.count++;
      this.repeats.to = t;
      return bytes;
    }
    this.flushRepeats();
    this.record(poll);
    this.record({ t, kind: "in", text });
    this.lastPollReply = text;
    return bytes;
  }

  drain(): Uint8Array[] {
    const dropped = this.inner.drain();
    for (const b of dropped) this.add("dropped", printable(b));
    return dropped;
  }

  close(): Promise<void> {
    this.note("connection closed");
    return this.inner.close();
  }

  /** Entries not yet recorded: a run of repeated polls still being counted, and a query awaiting its reply. */
  private inProgress(): LogEntry[] {
    const summary = this.repeatSummary();
    return [...(summary ? [summary] : []), ...(this.pendingPoll ? [this.pendingPoll] : [])];
  }

  entries(): LogEntry[] {
    return [...this.head, ...this.tail, ...this.inProgress()];
  }

  /** Plain-text log, one line per entry, for pasting into a bug report. */
  format(): string {
    const arrow = { out: "->", in: "<-", dropped: "<- (unread)", note: "##" };
    const line = (e: LogEntry) => `${(e.t / 1000).toFixed(3).padStart(9)}s ${arrow[e.kind]} ${e.text}`;
    const lines = this.head.map(line);
    if (this.omitted > 0) lines.push(`... ${this.omitted} entries omitted ...`);
    lines.push(...this.tail.map(line), ...this.inProgress().map(line));
    return lines.join("\n");
  }
}
