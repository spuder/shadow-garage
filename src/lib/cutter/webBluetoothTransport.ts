// Bluetooth LE transport (Chrome/Edge desktop): the Graphtec byte stream carried over the cutter's
// vendor GATT service, through Web Bluetooth. Chrome's own picker finds and connects the cutter; no
// OS pairing step. A Cameo 3 pairs with macOS as a Classic device and gets a /dev/cu.* port, but
// never answers on it, while macOS lists its services as GATT — so BLE is the default Bluetooth path.
//
// UUIDs, the three-characteristic init handshake and 20-byte acknowledged writes follow
// inkscape-silhouette's BLETransport.py (GPL-2.0, studied not vendored), which cross-checked them
// against bob-takuya/cameo-cut.

import { ByteQueue, TransportClosedError, type Transport } from "./transport";
import { CutterAccessError } from "./webUsbTransport";

export const CUTTER_BLE_SERVICE = "e2088282-4fde-42f9-bb22-6ec3c7ed8f91";
const WRITE_CHAR = "6d92661d-f429-4d67-929b-28e7a9780912";
/** Notifies command replies (FG, status, mark search). */
const READ_CHAR = "8dcf199a-30e7-4bd4-beb6-beb57dca866c";
/**
 * Notifies short movement events ("1<ETX>", "0<ETX>"). These are kept out of the reply stream:
 * mixed in, a mark search would read the first "moving" event as its result.
 */
const CONTROL_CHAR = "61490654-b5b4-458c-a867-9e15bc1471e0";

const INIT = new Uint8Array([0x1b, 0x04]);
const CHUNK_BYTES = 20; // the default ATT payload; upstream found larger writes unreliable
const SETTLE_MS = 1000;
const WRITE_RETRIES = 3;
const WRITE_RETRY_DELAY_MS = 100;
/** Advertised names start with the model, e.g. "CAMEO3-30411C". */
const NAME_PREFIXES = ["CAMEO", "PORTRAIT", "CURIO", "Silhouette"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function webBluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator && !!navigator.bluetooth;
}

/** The subset of a GATT characteristic used here, so tests can supply a fake. */
export type CharacteristicLike = Pick<
  BluetoothRemoteGATTCharacteristic,
  "writeValueWithResponse" | "startNotifications" | "addEventListener" | "value"
>;

export interface BleLink {
  name: string;
  write: CharacteristicLike;
  read: CharacteristicLike;
  control: CharacteristicLike;
  disconnect(): void;
  onDisconnect(listener: () => void): void;
}

export class WebBluetoothTransport implements Transport {
  readonly label: string;
  readonly deviceName: string;
  private readonly link: BleLink;
  private readonly queue = new ByteQueue();
  private writing: Promise<void> = Promise.resolve();
  private closed = false;
  /** Called once if the link drops while open (cutter off, out of range), so the UI can say so. */
  onLost: (() => void) | null = null;

  private constructor(link: BleLink) {
    this.link = link;
    this.deviceName = link.name;
    this.label = `Bluetooth LE ${link.name}`;
  }

  /** Subscribes to replies and runs upstream's init handshake on an already-connected link. */
  static async open(link: BleLink, settleMs = SETTLE_MS): Promise<WebBluetoothTransport> {
    const t = new WebBluetoothTransport(link);
    link.onDisconnect(() => {
      if (t.closed) return;
      t.queue.fail(new TransportClosedError("Lost the Bluetooth connection to the cutter (turned off or out of range)"));
      t.onLost?.();
    });
    link.read.addEventListener("characteristicvaluechanged", (e) => {
      const v = (e.target as BluetoothRemoteGATTCharacteristic).value;
      if (v) t.queue.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    });
    await link.control.startNotifications();
    await link.read.startNotifications();
    for (const c of [link.control, link.read, link.write]) await c.writeValueWithResponse(INIT);
    await sleep(settleMs);
    t.queue.drain();
    return t;
  }

  private async writeChunk(chunk: Uint8Array<ArrayBuffer>) {
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw new TransportClosedError();
      try {
        await this.link.write.writeValueWithResponse(chunk);
        return;
      } catch (e) {
        // The cutter answers "busy" while its buffer is full; back off and retry.
        if (attempt >= WRITE_RETRIES) throw new TransportClosedError(`Bluetooth write failed (${(e as Error).message})`);
        await sleep(WRITE_RETRY_DELAY_MS * 2 ** attempt);
      }
    }
  }

  write(bytes: Uint8Array): Promise<void> {
    // GATT allows one operation at a time, so writes are chained rather than interleaved.
    const run = async () => {
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) await this.writeChunk(bytes.slice(offset, offset + CHUNK_BYTES));
    };
    const next = this.writing.then(run, run);
    this.writing = next.catch(() => undefined);
    return next;
  }

  read(timeoutMs: number): Promise<Uint8Array> {
    return this.queue.take(timeoutMs);
  }

  drain(): Uint8Array[] {
    return this.queue.drain();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.fail(new TransportClosedError());
    try {
      this.link.disconnect();
    } catch {
      // already gone
    }
  }
}

function bleAccessHint(e: unknown): CutterAccessError {
  return new CutterAccessError(
    `Couldn't connect to the cutter over Bluetooth (${(e as Error).message}). Make sure it's on and in range, and quit Silhouette Studio or anything else connected to it.`,
    e
  );
}

/** gatt.connect() to a remembered device that's out of range can take a long time to give up. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e))
    );
  });
}

async function connectDevice(device: BluetoothDevice, connectTimeoutMs = 20_000): Promise<WebBluetoothTransport> {
  const gatt = device.gatt;
  if (!gatt) throw new CutterAccessError("This Bluetooth device has no GATT server.");
  let chars: BluetoothRemoteGATTCharacteristic[];
  try {
    await withTimeout(gatt.connect(), connectTimeoutMs, "Connecting");
    const service = await gatt.getPrimaryService(CUTTER_BLE_SERVICE);
    chars = await Promise.all([WRITE_CHAR, READ_CHAR, CONTROL_CHAR].map((u) => service.getCharacteristic(u)));
  } catch (e) {
    try {
      gatt.disconnect();
    } catch {
      // not connected
    }
    if ((e as DOMException).name === "NotFoundError") {
      throw new CutterAccessError(`${device.name ?? "This device"} connected, but doesn't offer the Silhouette Bluetooth service.`, e);
    }
    throw bleAccessHint(e);
  }
  const [write, read, control] = chars;
  const link: BleLink = {
    name: device.name ?? device.id,
    write,
    read,
    control,
    disconnect: () => gatt.disconnect(),
    onDisconnect: (listener) => device.addEventListener("gattserverdisconnected", listener),
  };
  try {
    return await WebBluetoothTransport.open(link);
  } catch (e) {
    gatt.disconnect();
    throw bleAccessHint(e);
  }
}

/** Shows Chrome's Bluetooth picker (must be called from a user gesture). Resolves null if the user cancels. */
export async function requestBleCutter(): Promise<WebBluetoothTransport | null> {
  let device: BluetoothDevice;
  try {
    device = await navigator.bluetooth.requestDevice({
      // Either filter matches: some cutters don't put the service UUID in their advertisement.
      filters: [{ services: [CUTTER_BLE_SERVICE] }, ...NAME_PREFIXES.map((namePrefix) => ({ namePrefix }))],
      optionalServices: [CUTTER_BLE_SERVICE],
    });
  } catch (e) {
    if ((e as DOMException).name === "NotFoundError") return null; // picker dismissed
    throw e;
  }
  return connectDevice(device);
}

/**
 * Reconnects without a prompt to a cutter this site was already granted, if one is in range.
 * getDevices() is missing in some Chrome builds; then this returns null and the picker is used.
 */
export async function reconnectBleCutter(): Promise<WebBluetoothTransport | null> {
  if (typeof navigator.bluetooth.getDevices !== "function") return null;
  for (const device of await navigator.bluetooth.getDevices()) {
    try {
      return await connectDevice(device, 5000);
    } catch {
      // out of range or not a cutter; fall through to the picker
    }
  }
  return null;
}
