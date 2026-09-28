import { describe, expect, it } from "vitest";
import { cameo3Responder, FakeTransport } from "./fakeTransport";
import { bluetoothServiceClassIds, modelById, modelForBluetoothFirmware, SERIAL_PORT_PROFILE_UUID } from "./models";
import { CutterSession } from "./session";
import { LoggingTransport, TransportClosedError, TransportTimeoutError } from "./transport";
import { describePort, identifyBluetoothModel, WebSerialTransport, type SerialPortLike } from "./webSerialTransport";

/** An in-memory serial port: `send` pushes bytes the "cutter" sends, `written` collects what the app wrote. */
function fakePort(info: SerialPortInfo = { bluetoothServiceClassId: SERIAL_PORT_PROFILE_UUID }) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const written: Uint8Array[] = [];
  const state = { opened: false, closed: false };
  const port = {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    getInfo: () => info,
    async open() {
      state.opened = true;
      port.readable = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      port.writable = new WritableStream<Uint8Array>({ write: (chunk) => void written.push(chunk) });
    },
    async close() {
      if (port.readable?.locked || port.writable?.locked) throw new Error("streams still locked");
      state.closed = true;
    },
  };
  return {
    port: port as unknown as SerialPortLike,
    written,
    state,
    send: (bytes: number[]) => controller.enqueue(new Uint8Array(bytes)),
    fail: (e: Error) => controller.error(e),
    end: () => controller.close(),
  };
}

describe("WebSerialTransport", () => {
  it("writes in chunks and reads what the device sends", async () => {
    const f = fakePort();
    const t = await WebSerialTransport.open(f.port);
    await t.write(new Uint8Array(10_000));
    expect(f.written.map((c) => c.length)).toEqual([4096, 4096, 1808]);
    f.send([0x30, 0x03]);
    expect([...(await t.read(100))]).toEqual([0x30, 0x03]);
    await expect(t.read(20)).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it("drains unread replies", async () => {
    const f = fakePort();
    const t = await WebSerialTransport.open(f.port);
    f.send([0x31]);
    f.send([0x32]);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.drain().map((b) => [...b])).toEqual([[0x31], [0x32]]);
  });

  it("fails reads when the link drops or the device closes it", async () => {
    const f = fakePort();
    const t = await WebSerialTransport.open(f.port);
    const pending = t.read(1000);
    f.fail(new Error("device lost"));
    await expect(pending).rejects.toThrow(/Lost the Bluetooth connection.*device lost/);

    const g = fakePort();
    const u = await WebSerialTransport.open(g.port);
    g.end();
    await expect(u.read(1000)).rejects.toBeInstanceOf(TransportClosedError);
  });

  it("unlocks both streams before closing the port, and closes once", async () => {
    const f = fakePort();
    const t = await WebSerialTransport.open(f.port);
    await t.close();
    await t.close();
    expect(f.state.closed).toBe(true);
    await expect(t.write(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportClosedError);
  });

  it("labels the port by kind, for the log", () => {
    expect(describePort({ bluetoothServiceClassId: SERIAL_PORT_PROFILE_UUID })).toMatch(/Bluetooth RFCOMM port/);
    expect(describePort({})).toMatch(/no ids/);
  });
});

describe("Bluetooth model identification", () => {
  it("offers the Cameo 3's service class in the picker", () => {
    expect(bluetoothServiceClassIds()).toEqual([SERIAL_PORT_PROFILE_UUID]);
  });

  it("matches the firmware prefix, and otherwise assumes the only Bluetooth model", () => {
    expect(modelForBluetoothFirmware("CAMEO3 V1.40")).toMatchObject({ model: { id: "silhouette-cameo3" }, guessed: false });
    expect(modelForBluetoothFirmware("cameo 3 v1.40")?.guessed).toBe(false);
    expect(modelForBluetoothFirmware("CAMEO V1.10")).toMatchObject({ model: { id: "silhouette-cameo3" }, guessed: true });
    // The advertised BLE name names the model when the firmware reply doesn't.
    expect(modelForBluetoothFirmware("CAMEO V1.10", "CAMEO3-30411C")?.guessed).toBe(false);
  });

  it("notes a guessed model in the log", () => {
    const log = new LoggingTransport(new FakeTransport(() => null));
    expect(identifyBluetoothModel("CAMEO V1.10", log).id).toBe("silhouette-cameo3");
    expect(log.format()).toMatch(/assuming Silhouette Cameo 3/);
  });

  it("identifies the model from the handshake's firmware reply", async () => {
    const t = new FakeTransport(cameo3Responder());
    const provisional = { ...modelById("silhouette-cameo3")!, name: "provisional" };
    const session = await CutterSession.openAndIdentify(t, provisional, identifyBluetoothModel);
    expect(session.model.name).toBe("Cameo 3");
    expect(session.firmware).toBe("CAMEO V1.10");
    expect(t.log).toEqual(["<ESC EOT>", "FG", "TB71", "FA", "TC"]);
    expect(session.log.format()).toMatch(/identified: Silhouette Cameo 3/);
  });

  it("closes the link when the cutter isn't supported", async () => {
    const t = new FakeTransport(cameo3Responder());
    const open = CutterSession.openAndIdentify(t, modelById("silhouette-cameo3")!, () => {
      throw new Error("not supported");
    });
    await expect(open).rejects.toThrow("not supported");
    expect(t.closed).toBe(true);
  });
});
