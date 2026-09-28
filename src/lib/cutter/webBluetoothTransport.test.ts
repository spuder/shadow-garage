import { describe, expect, it } from "vitest";
import { TransportClosedError } from "./transport";
import { WebBluetoothTransport, type BleLink, type CharacteristicLike } from "./webBluetoothTransport";

/** A fake GATT characteristic: records writes, and `notify` fires characteristicvaluechanged. */
function fakeChar() {
  const writes: number[][] = [];
  const listeners: ((e: Event) => void)[] = [];
  let notifying = false;
  let failures = 0;
  const c = {
    value: undefined as DataView | undefined,
    async writeValueWithResponse(v: BufferSource) {
      if (failures > 0) {
        failures--;
        throw new Error("GATT operation failed");
      }
      writes.push([...new Uint8Array(v as ArrayBuffer)]);
    },
    async startNotifications() {
      notifying = true;
      return c;
    },
    addEventListener(_type: string, l: (e: Event) => void) {
      listeners.push(l);
    },
  };
  return {
    char: c as unknown as CharacteristicLike,
    writes,
    failNext(n: number) {
      failures = n;
    },
    get notifying() {
      return notifying;
    },
    notify(bytes: number[]) {
      c.value = new DataView(new Uint8Array(bytes).buffer);
      for (const l of listeners) l({ target: c } as unknown as Event);
    },
  };
}

function fakeLink() {
  const write = fakeChar();
  const read = fakeChar();
  const control = fakeChar();
  let lost: (() => void) | null = null;
  let disconnected = false;
  const link: BleLink = {
    name: "CAMEO3-30411C",
    write: write.char,
    read: read.char,
    control: control.char,
    disconnect: () => void (disconnected = true),
    onDisconnect: (l) => void (lost = l),
  };
  return { link, write, read, control, drop: () => lost?.(), isDisconnected: () => disconnected };
}

describe("WebBluetoothTransport", () => {
  it("subscribes and sends the init handshake to all three characteristics", async () => {
    const f = fakeLink();
    const t = await WebBluetoothTransport.open(f.link, 0);
    expect(f.read.notifying && f.control.notifying).toBe(true);
    for (const c of [f.write, f.read, f.control]) expect(c.writes).toEqual([[0x1b, 0x04]]);
    expect(t.label).toBe("Bluetooth LE CAMEO3-30411C");
  });

  it("writes in 20-byte chunks and retries a busy write", async () => {
    const f = fakeLink();
    const t = await WebBluetoothTransport.open(f.link, 0);
    f.write.writes.length = 0;
    await t.write(new Uint8Array(45).fill(7));
    expect(f.write.writes.map((w) => w.length)).toEqual([20, 20, 5]);

    // The cutter reports busy while its buffer is full: the write is retried, not lost.
    f.write.writes.length = 0;
    f.write.failNext(2);
    await t.write(new Uint8Array([1, 2]));
    expect(f.write.writes).toEqual([[1, 2]]);

    f.write.failNext(10);
    await expect(t.write(new Uint8Array([3]))).rejects.toThrow(/Bluetooth write failed/);
  });

  it("reads replies from the read characteristic only, not movement events", async () => {
    const f = fakeLink();
    const t = await WebBluetoothTransport.open(f.link, 0);
    f.control.notify([0x31, 0x03]);
    f.read.notify([0x30, 0x03]);
    expect([...(await t.read(100))]).toEqual([0x30, 0x03]);
    expect(t.drain()).toEqual([]);
  });

  it("fails pending reads and reports a dropped link once", async () => {
    const f = fakeLink();
    const t = await WebBluetoothTransport.open(f.link, 0);
    let lost = 0;
    t.onLost = () => lost++;
    const pending = t.read(1000);
    f.drop();
    await expect(pending).rejects.toBeInstanceOf(TransportClosedError);
    expect(lost).toBe(1);
  });

  it("disconnects on close without reporting a lost link", async () => {
    const f = fakeLink();
    const t = await WebBluetoothTransport.open(f.link, 0);
    let lost = 0;
    t.onLost = () => lost++;
    await t.close();
    f.drop();
    expect(f.isDisconnected()).toBe(true);
    expect(lost).toBe(0);
    await expect(t.write(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportClosedError);
  });
});
