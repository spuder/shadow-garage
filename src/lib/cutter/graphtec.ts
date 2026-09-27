// Graphtec GPGL command language, as spoken by Silhouette cutters.
//
// Reverse-engineered from fablabnbg/inkscape-silhouette's Graphtec.py (GPL-2.0 — studied for the
// protocol, not vendored). Only the Cameo 3 command variant is implemented; other Silhouette
// generations send slightly different setup sequences (see Graphtec.py's setup()) and need their
// own branch here plus hardware testing before being added to models.ts.
//
// Wire format: ASCII commands, each terminated by ETX (0x03); a few control codes are sent as
// ESC + byte. Coordinates are "Silhouette units" (20 per mm) with the axes swapped relative to
// screen space: the device's first coordinate runs down the media, the second across it.

import type { Contour } from "../geometry";
import type { CutMaterial } from "./materials";
import type { CutterModel, RegmarkArgOrder } from "./models";
import {
  CutOutOfBoundsError,
  CutterNotReadyError,
  RegmarkNotFoundError,
  type CutFrame,
  type CutProgress,
  type CutterProtocol,
  type CutterStatus,
  type RegmarkSpec,
  type WaitOptions,
} from "./protocol";
import { TransportTimeoutError, type Transport } from "./transport";

const ETX = 0x03;
const ESC = 0x1b;
const EOT = 0x04; // ESC EOT: initialize / reset the device
const ENQ = 0x05; // ESC ENQ: status query

const SU_PER_MM = 20;
const TOOL_HOLDER = 1; // the AutoBlade only works in tool holder 1
const BLADE_DIAMETER_MM = 0.9;
const CLIP_FUZZ_MM = 0.05; // one device step; points this close outside the clip box are fine
const MAX_CHUNK_BYTES = 1024; // Silhouette Studio's default packet size; upstream's safe_write uses the same

// Graphtec.py CAMEO_MATS codes for the TG command.
const MAT_CODES: Record<string, string> = {
  no_mat: "0",
  cameo_12x12: "1",
  cameo_12x24: "2",
};

/** Round half to even, matching Python 3's round() so our output is byte-identical to upstream's. */
function roundHalfEven(v: number): number {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function mmToSU(mm: number): number {
  return roundHalfEven(mm * SU_PER_MM);
}

function clamp(v: number, [lo, hi]: [number, number]): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encodes commands as ETX-terminated ASCII. */
export function frameCommands(cmds: string[]): Uint8Array {
  return encoder.encode(cmds.map((c) => c + "\x03").join(""));
}

export function escapeCommand(code: number): Uint8Array {
  return new Uint8Array([ESC, code]);
}

/** Mat, tool, speed, pressure, blade offset and AutoBlade depth — Graphtec.py's set_cutting_mat() + setup() for a Cameo 3. */
export function setupCommands(model: CutterModel, material: CutMaterial): string[] {
  const t = TOOL_HOLDER;
  const matCode = MAT_CODES[model.mat.id] ?? "0";
  const speed = clamp(material.speed, model.speedRange);
  const pressure = clamp(material.pressure, model.pressureRange);
  const depth = clamp(material.autoBladeDepth, [0, 10]);
  // Corner-sharpening parameters, as upstream derives them from its 0.1mm defaults.
  const sharpen = Math.trunc((0.1 + 0.05) * 10);
  return [
    `TG${matCode}`,
    "FN0",
    "TB50,0", // portrait: upstream swaps x/y itself rather than using landscape mode, which mis-compensates the blade-alignment tick
    `\\0,0`,
    `Z${mmToSU(model.mat.heightMm)},${mmToSU(model.mat.widthMm)}`,
    `J${t}`,
    `!${speed},${t}`,
    `FX${pressure},${t}`,
    `FE0,${t}`, // don't lift the blade at every corner
    `FF${sharpen},0,${t}`,
    `FF${sharpen},${sharpen},${t}`,
    `FC${mmToSU(0)},${mmToSU(0.05)},${t}`,
    `FC${mmToSU(BLADE_DIAMETER_MM)},${mmToSU(0.05)},${t}`,
    `TF${depth},${t}`, // the AutoBlade sets its own depth from this
  ];
}

// Mark type, size and mode setup sent before either kind of mark search.
const REGMARK_SETUP = [
  "TB50,0",
  "TB99",
  "TB52,2", // mark type: Cameo/Portrait
  "TB51,400", // mark length
  "TB53,10", // mark line width
  "TB55,1",
];

function regmarkDistances(spec: RegmarkSpec, order: RegmarkArgOrder): string {
  const h = mmToSU(spec.heightMm);
  const w = mmToSU(spec.widthMm);
  return order === "height_width" ? `${h},${w}` : `${w},${h}`;
}

/** Automatic registration-mark search (Graphtec.py plot() with regmark=True, regsearch=True). */
export function regmarkCommands(spec: RegmarkSpec, order: RegmarkArgOrder = "height_width"): string[] {
  // Upstream starts the optical search 10mm before where the marks are expected.
  const top = Math.max(spec.originYmm - 10, 0);
  const left = Math.max(spec.originXmm - 10, 0);
  const search = spec.style === "four_corner" ? "TB124" : "TB123";
  return [...REGMARK_SETUP, `${search},${regmarkDistances(spec, order)},${mmToSU(top)},${mmToSU(left)}`];
}

/** Manual registration: register from wherever the tool was positioned (Graphtec.py's manual_regmark_mm_cmd). */
export function manualRegmarkCommand(spec: RegmarkSpec, order: RegmarkArgOrder = "height_width"): string {
  return `TB23,${regmarkDistances(spec, order)}`;
}

/** Tool-up move to (x, y) mm in screen orientation (axes swapped on the wire). */
export function moveCommand(xMm: number, yMm: number): string {
  return `M${mmToSU(yMm)},${mmToSU(xMm)}`;
}

/** Move/draw commands for each path. Throws rather than silently clipping anything outside the frame. */
export function pathCommands(paths: Contour[], frame: CutFrame): string[] {
  const { clip } = frame;
  const cmds: string[] = [];
  for (const path of paths) {
    if (path.length < 2) continue;
    path.forEach(([sx, sy], i) => {
      const x = sx + frame.offsetXmm;
      const y = sy + frame.offsetYmm;
      if (x < clip.minX - CLIP_FUZZ_MM || x > clip.maxX + CLIP_FUZZ_MM || y < clip.minY - CLIP_FUZZ_MM || y > clip.maxY + CLIP_FUZZ_MM) {
        throw new CutOutOfBoundsError(`A cut line reaches outside the cutter's allowed area (${x.toFixed(1)}, ${y.toFixed(1)} mm).`);
      }
      // Axes swapped: device takes (down, across).
      cmds.push(`${i === 0 ? "M" : "D"}${mmToSU(y)},${mmToSU(x)}`);
    });
  }
  return cmds;
}

/** Returns the tool to where the job started (Graphtec.py's endposition='start' for Cameo 3+). */
export function homeCommands(): string[] {
  return ["L0", "\\0,0", "M0,0", "J0", "FN0", "TB50,0"];
}

/** Splits framed commands into packets of at most maxBytes, never splitting a command. */
export function chunkFrames(bytes: Uint8Array, maxBytes = MAX_CHUNK_BYTES): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    if (end < bytes.length) {
      const lastEtx = bytes.subarray(start, end).lastIndexOf(ETX);
      if (lastEtx < 0) throw new Error(`A single cutter command is longer than ${maxBytes} bytes`);
      end = start + lastEtx + 1;
    }
    chunks.push(bytes.subarray(start, end));
    start = end;
  }
  return chunks;
}

export function parseStatus(reply: string): CutterStatus {
  switch (reply.trim()) {
    case "0":
      return "ready";
    case "1":
      return "moving";
    case "2":
      return "unloaded";
    default:
      return "unknown";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

export class GraphtecProtocol implements CutterProtocol {
  private pending: number[] = []; // bytes received after the last reply's ETX
  private readonly transport: Transport;
  private readonly model: CutterModel;

  constructor(transport: Transport, model: CutterModel) {
    this.transport = transport;
    this.model = model;
  }

  private drain() {
    this.transport.drain();
    this.pending = [];
  }

  /** Reads one ETX-terminated reply and returns it without the ETX. */
  private async readReply(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const etx = this.pending.indexOf(ETX);
      if (etx >= 0) {
        const reply = this.pending.slice(0, etx);
        this.pending = this.pending.slice(etx + 1);
        return decoder.decode(new Uint8Array(reply));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeoutError(timeoutMs);
      const chunk = await this.transport.read(remaining);
      this.pending.push(...chunk);
    }
  }

  private async query(cmd: string, timeoutMs: number): Promise<string> {
    this.drain();
    await this.transport.write(frameCommands([cmd]));
    return this.readReply(timeoutMs);
  }

  private async send(cmds: string[]) {
    await this.transport.write(frameCommands(cmds));
  }

  async handshake(): Promise<{ firmware: string }> {
    this.drain();
    await this.transport.write(escapeCommand(EOT));
    const firmware = (await this.query("FG", 10_000)).trim();
    // Calibration queries Silhouette Studio sends to a Cameo 3 at startup. Their replies aren't
    // used; they're sent so the device sees the same init sequence it's known to work with.
    for (const q of ["TB71", "FA", "TC"]) {
      try {
        await this.query(q, 1000);
      } catch (e) {
        if (!(e instanceof TransportTimeoutError)) throw e;
      }
    }
    return { firmware };
  }

  async status(): Promise<CutterStatus> {
    this.drain();
    await this.transport.write(escapeCommand(ENQ));
    return parseStatus(await this.readReply(5000));
  }

  async waitForReady({ timeoutMs, pollMs, onStatus, signal }: WaitOptions): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: CutterStatus = "unknown";
    for (;;) {
      signal?.throwIfAborted();
      last = await this.status();
      onStatus?.(last);
      if (last === "ready") return;
      if (Date.now() >= deadline) break;
      await sleep(pollMs, signal);
    }
    throw new CutterNotReadyError(
      last === "unloaded" ? "No mat loaded — load the mat into the cutter and try again." : `The cutter didn't become ready (status: ${last}).`
    );
  }

  async setup(material: CutMaterial): Promise<void> {
    await this.send(setupCommands(this.model, material));
  }

  private async awaitRegistration(): Promise<void> {
    let reply: string;
    try {
      reply = await this.readReply(40_000); // the optical search can take a while
    } catch (e) {
      if (e instanceof TransportTimeoutError) throw new RegmarkNotFoundError("no reply within 40 s");
      throw e;
    }
    if (reply.trim() !== "0") throw new RegmarkNotFoundError(`reply "${reply}"`);
  }

  async searchRegmarks(spec: RegmarkSpec): Promise<void> {
    this.drain();
    await this.send(regmarkCommands(spec, this.model.regmarkArgOrder));
    await this.awaitRegistration();
  }

  async prepareManualRegmarks(spec: RegmarkSpec): Promise<void> {
    await this.send(REGMARK_SETUP);
    await this.moveTo(spec.originXmm, spec.originYmm);
  }

  async moveTo(xMm: number, yMm: number): Promise<void> {
    await this.send([moveCommand(xMm + this.model.marginLeftMm, yMm + this.model.marginTopMm)]);
  }

  async confirmManualRegmarks(spec: RegmarkSpec): Promise<void> {
    this.drain();
    await this.send([manualRegmarkCommand(spec, this.model.regmarkArgOrder)]);
    await this.awaitRegistration();
  }

  async cut(paths: Contour[], frame: CutFrame, { onProgress, signal }: CutProgress = {}): Promise<void> {
    const chunks = chunkFrames(frameCommands(pathCommands(paths, frame)));
    for (let i = 0; i < chunks.length; i++) {
      signal?.throwIfAborted();
      await this.transport.write(chunks[i]);
      // Don't overrun the cutter's buffer: let it work through each packet before sending the next.
      await this.waitForReady({ timeoutMs: 120_000, pollMs: 50, signal });
      onProgress?.((i + 1) / chunks.length);
    }
  }

  async finish(): Promise<void> {
    await this.send(homeCommands());
  }

  async abort(): Promise<void> {
    // ESC EOT re-initializes the device, which stops executing buffered commands. Not yet
    // verified on hardware that it also lifts the blade immediately.
    this.drain();
    await this.transport.write(escapeCommand(EOT));
  }
}
