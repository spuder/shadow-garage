// Bluetooth Classic transport (Chrome/Edge 117+ desktop): the cutter's RFCOMM serial service,
// opened through the Web Serial API. The OS does the pairing; Web Serial only lists cutters that are
// already paired. On macOS the port may be Chrome's own RFCOMM port (getInfo() reports the service
// class id) or a /dev/cu.* node macOS created for the paired device (no ids); both open the same way.

import { bluetoothServiceClassIds, modelForBluetoothFirmware, provisionalBluetoothModel, type CutterModel } from "./models";
import { ByteQueue, TransportClosedError, type LoggingTransport, type Transport } from "./transport";
import { CutterAccessError } from "./webUsbTransport";

// RFCOMM ignores the baud rate, but open() requires one.
const BAUD_RATE = 115200;
// Starts at WebUSB's chunk size; lower it if long packets turn out to lose bytes over Bluetooth.
const WRITE_CHUNK_BYTES = 4096;

/** The subset of the Web Serial SerialPort used here, so tests can supply a fake. */
export type SerialPortLike = Pick<SerialPort, "open" | "close" | "getInfo" | "readable" | "writable">;

export function webSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator && !!navigator.serial;
}

export function bluetoothAccessHint(userAgent = navigator.userAgent): string {
  const pair = /Mac OS X|Macintosh/i.test(userAgent)
    ? "pair it in System Settings → Bluetooth"
    : "pair it in your Bluetooth settings (or bluetoothctl)";
  return `Couldn't open the cutter over Bluetooth. Make sure it's on, in range and paired (${pair}), quit Silhouette Studio or anything else that may hold the connection, then try again.`;
}

/** "bluetooth 00001101-…" or "serial port" — for the log, so a pasted log shows which kind of port was used. */
export function describePort(info: SerialPortInfo): string {
  if (info.bluetoothServiceClassId !== undefined) return `Bluetooth RFCOMM port, service ${info.bluetoothServiceClassId}`;
  if (info.usbVendorId !== undefined) return `USB serial port ${info.usbVendorId.toString(16)}:${info.usbProductId?.toString(16) ?? "?"}`;
  return "serial port (no ids — probably a /dev node the OS made for a paired device)";
}

export class WebSerialTransport implements Transport {
  readonly label: string;
  readonly port: SerialPortLike;
  private readonly queue = new ByteQueue();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closed = false;

  private constructor(port: SerialPortLike) {
    this.port = port;
    this.label = `Bluetooth (${describePort(port.getInfo())})`;
  }

  static async open(port: SerialPortLike): Promise<WebSerialTransport> {
    try {
      await port.open({ baudRate: BAUD_RATE });
    } catch (e) {
      throw new CutterAccessError(bluetoothAccessHint(), e);
    }
    const t = new WebSerialTransport(port);
    if (!port.readable || !port.writable) {
      await t.close();
      throw new CutterAccessError(bluetoothAccessHint());
    }
    t.reader = port.readable.getReader();
    t.writer = port.writable.getWriter();
    void t.readLoop(t.reader);
    return t;
  }

  // Same shape as the WebUSB transport: one loop feeds the queue, so read()/drain() behave the same.
  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.queue.push(value);
      }
      if (!this.closed) this.queue.fail(new TransportClosedError("The cutter closed the Bluetooth connection"));
    } catch (e) {
      if (!this.closed) this.queue.fail(new TransportClosedError(`Lost the Bluetooth connection to the cutter (${(e as Error).message})`));
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed || !this.writer) throw new TransportClosedError();
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
      try {
        await this.writer.write(bytes.slice(offset, offset + WRITE_CHUNK_BYTES));
      } catch (e) {
        throw new TransportClosedError(`Lost the Bluetooth connection to the cutter (${(e as Error).message})`);
      }
    }
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
    // The port only closes once both streams are unlocked.
    try {
      await this.reader?.cancel();
    } catch {
      // stream already errored
    }
    this.reader?.releaseLock();
    try {
      this.writer?.releaseLock();
    } catch {
      // already released
    }
    try {
      await this.port.close();
    } catch {
      // port may already be gone
    }
  }
}

export interface BluetoothCutterConnection {
  transport: WebSerialTransport;
  /** Used for the handshake; the real model is picked from the firmware reply (identifyBluetoothModel). */
  provisionalModel: CutterModel;
}

/** Service class ids to ask for: the registry's, or ?btService=<uuid> while the Cameo 3's is unconfirmed. */
function serviceClassIds(override: string | null): string[] {
  return override ? [override] : bluetoothServiceClassIds();
}

function isCutterPort(port: SerialPort, ids: string[]): boolean {
  const id = port.getInfo().bluetoothServiceClassId;
  return id !== undefined && ids.includes(String(id).toLowerCase());
}

async function openBluetoothCutter(port: SerialPort): Promise<BluetoothCutterConnection> {
  const provisionalModel = provisionalBluetoothModel();
  if (!provisionalModel) throw new CutterAccessError("No supported cutter has Bluetooth.");
  return { transport: await WebSerialTransport.open(port), provisionalModel };
}

/**
 * Shows the browser's serial port picker (must be called from a user gesture), listing Bluetooth
 * cutters by service class id. Resolves null if the user cancels.
 *
 * With `anyPort`, the picker lists every serial port instead. That's for macOS when the cutter shows
 * up as a /dev/cu.* node rather than a Chrome RFCOMM port, and for finding out which one it is.
 */
export async function requestBluetoothCutter({ serviceOverride = null, anyPort = false }: { serviceOverride?: string | null; anyPort?: boolean } = {}): Promise<BluetoothCutterConnection | null> {
  const ids = serviceClassIds(serviceOverride);
  let port: SerialPort;
  try {
    port = await navigator.serial.requestPort({
      ...(anyPort ? {} : { filters: ids.map((id) => ({ bluetoothServiceClassId: id })) }),
      allowedBluetoothServiceClassIds: ids,
    });
  } catch (e) {
    if ((e as DOMException).name === "NotFoundError") return null; // picker dismissed, or nothing paired
    throw e;
  }
  return openBluetoothCutter(port);
}

/** Reconnects without a prompt to a Bluetooth cutter this site was already granted, if it's in range. */
export async function reconnectBluetoothCutter({ serviceOverride = null }: { serviceOverride?: string | null } = {}): Promise<BluetoothCutterConnection | null> {
  const ids = serviceClassIds(serviceOverride);
  const ports = await navigator.serial.getPorts();
  // `connected` (Chrome 130+) is false for a paired cutter that's off or out of range.
  const port = ports.find((p) => isCutterPort(p, ids) && p.connected !== false);
  return port ? openBluetoothCutter(port) : null;
}

/** Picks the model from the FG reply (or device name) for CutterSession.openAndIdentify, noting a guess in the log. */
export function identifyBluetoothModel(firmware: string, log: LoggingTransport, deviceName = ""): CutterModel {
  const found = modelForBluetoothFirmware(firmware, deviceName);
  if (!found) throw new CutterAccessError(`Connected over Bluetooth, but this cutter ("${firmware}") isn't supported.`);
  if (found.guessed) log.note(`firmware "${firmware}" doesn't name a model; assuming ${found.model.manufacturer} ${found.model.name}`);
  return found.model;
}
