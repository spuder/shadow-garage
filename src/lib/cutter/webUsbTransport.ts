// WebUSB transport (Chrome/Edge desktop). Silhouette cutters enumerate as a USB printer-class
// interface with one bulk OUT and one bulk IN endpoint (0x01 / 0x82 on every known model).
//
// Platform notes: macOS works out of the box. Linux needs a udev rule granting the logged-in user
// access (see docs/cutter-setup.md); Chrome then detaches the usblp kernel driver itself. Windows
// binds usbprint.sys to printer-class devices, which blocks WebUSB entirely — not supported in v1.

import { modelForUsb, usbFilters, type CutterModel } from "./models";
import { ByteQueue, TransportClosedError, type Transport } from "./transport";

const WRITE_CHUNK_BYTES = 4096;
const READ_PACKET_BYTES = 64;

export class CutterAccessError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CutterAccessError";
  }
}

export function webUsbSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator && !!navigator.usb;
}

/** What to tell the user when the browser can see the cutter but can't claim it. */
export function usbAccessHint(userAgent = navigator.userAgent): string {
  if (/Windows/i.test(userAgent)) {
    return "Windows' printer driver blocks browser access to the cutter, and Windows isn't supported yet. (Workaround: replace the cutter's driver with WinUSB using Zadig — this may stop Silhouette Studio from seeing it until you roll the driver back.)";
  }
  if (/Mac OS X|Macintosh/i.test(userAgent)) {
    return "Couldn't open the cutter. Quit Silhouette Studio (it holds the connection), unplug and replug the cutter, then try again.";
  }
  return 'Couldn\'t open the cutter. On Linux, add a udev rule — SUBSYSTEM=="usb", ATTRS{idVendor}=="0b4d", TAG+="uaccess" — then replug the cutter (see docs/cutter-setup.md). Also quit any other cutter software.';
}

function findBulkEndpoints(device: USBDevice): { iface: number; inEp: number; outEp: number } {
  for (const iface of device.configuration?.interfaces ?? []) {
    const eps = iface.alternate.endpoints;
    const inEp = eps.find((e) => e.type === "bulk" && e.direction === "in");
    const outEp = eps.find((e) => e.type === "bulk" && e.direction === "out");
    if (inEp && outEp) return { iface: iface.interfaceNumber, inEp: inEp.endpointNumber, outEp: outEp.endpointNumber };
  }
  return { iface: 0, inEp: 2, outEp: 1 }; // Graphtec.py's fixed endpoints
}

export class WebUsbTransport implements Transport {
  readonly label: string;
  readonly device: USBDevice;
  private readonly iface: number;
  private readonly inEp: number;
  private readonly outEp: number;
  private readonly queue = new ByteQueue();
  private closed = false;

  private constructor(device: USBDevice, iface: number, inEp: number, outEp: number) {
    this.device = device;
    this.iface = iface;
    this.inEp = inEp;
    this.outEp = outEp;
    this.label = device.productName || `USB ${device.vendorId.toString(16)}:${device.productId.toString(16)}`;
  }

  static async open(device: USBDevice): Promise<WebUsbTransport> {
    let eps: { iface: number; inEp: number; outEp: number };
    try {
      await device.open();
      if (device.configuration === null) await device.selectConfiguration(1);
      eps = findBulkEndpoints(device);
      await device.claimInterface(eps.iface);
    } catch (e) {
      try {
        await device.close();
      } catch {
        // already closed / never opened
      }
      throw new CutterAccessError(usbAccessHint(), e);
    }
    const t = new WebUsbTransport(device, eps.iface, eps.inEp, eps.outEp);
    void t.readLoop();
    return t;
  }

  // One transferIn is always outstanding; replies land in the queue whether or not anyone is
  // currently waiting for them (a timed-out transferIn can't be cancelled, so reads can't own it).
  private async readLoop() {
    while (!this.closed) {
      try {
        const r = await this.device.transferIn(this.inEp, READ_PACKET_BYTES);
        if (r.status === "stall") {
          await this.device.clearHalt("in", this.inEp);
          continue;
        }
        if (r.data && r.data.byteLength > 0) {
          this.queue.push(new Uint8Array(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength)));
        }
      } catch (e) {
        if (!this.closed) this.queue.fail(new TransportClosedError(`Lost connection to the cutter (${(e as Error).message})`));
        return;
      }
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new TransportClosedError();
    let offset = 0;
    let stalls = 0;
    while (offset < bytes.length) {
      const chunk = bytes.slice(offset, offset + WRITE_CHUNK_BYTES);
      const r = await this.device.transferOut(this.outEp, chunk);
      if (r.status === "stall") {
        if (++stalls > 3) throw new Error("The cutter keeps rejecting data (endpoint stalled)");
        await this.device.clearHalt("out", this.outEp);
        continue; // retry the same chunk
      }
      stalls = 0;
      if (r.bytesWritten === 0) throw new Error("The cutter accepted no data");
      offset += r.bytesWritten;
    }
  }

  read(timeoutMs: number): Promise<Uint8Array> {
    return this.queue.take(timeoutMs);
  }

  drain() {
    this.queue.drain();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.fail(new TransportClosedError());
    try {
      await this.device.releaseInterface(this.iface);
    } catch {
      // device may already be gone
    }
    try {
      await this.device.close();
    } catch {
      // device may already be gone
    }
  }
}

export interface UsbCutterConnection {
  transport: WebUsbTransport;
  model: CutterModel;
}

async function openUsbCutter(device: USBDevice): Promise<UsbCutterConnection> {
  const model = modelForUsb(device.vendorId, device.productId);
  if (!model) throw new CutterAccessError(`${device.productName || "This device"} isn't a supported cutter.`);
  return { transport: await WebUsbTransport.open(device), model };
}

/** Shows the browser's device picker (must be called from a user gesture). Resolves null if the user cancels. */
export async function requestUsbCutter(): Promise<UsbCutterConnection | null> {
  let device: USBDevice;
  try {
    device = await navigator.usb.requestDevice({ filters: usbFilters() });
  } catch (e) {
    if ((e as DOMException).name === "NotFoundError") return null; // picker dismissed
    throw e;
  }
  return openUsbCutter(device);
}

/** Reconnects without a prompt to a cutter this site was already granted access to, if one is plugged in. */
export async function reconnectUsbCutter(): Promise<UsbCutterConnection | null> {
  const devices = await navigator.usb.getDevices();
  const device = devices.find((d) => modelForUsb(d.vendorId, d.productId));
  return device ? openUsbCutter(device) : null;
}
