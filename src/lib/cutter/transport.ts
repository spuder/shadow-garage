// A byte pipe to a cutter. Protocols (graphtec.ts, ...) sit on top of this and never touch
// WebUSB / Web Serial / Web Bluetooth directly, so adding a transport (v2: Bluetooth RFCOMM via
// Web Serial) is one new file implementing this interface.

export interface Transport {
  /** Human-readable description of the connected device, for the status line. */
  readonly label: string;
  write(bytes: Uint8Array): Promise<void>;
  /** Resolves with the next chunk of received bytes (at least one byte), or rejects with TransportTimeoutError. */
  read(timeoutMs: number): Promise<Uint8Array>;
  /** Discards any received-but-unread bytes (stale replies, spurious diagnostics). */
  drain(): void;
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

  drain() {
    this.chunks = [];
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
