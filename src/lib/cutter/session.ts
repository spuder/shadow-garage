// One connected cutter: owns the transport + protocol and runs whole jobs
// (wait for mat → setup → optional mark search → cut → park).

import type { Contour } from "../geometry";
import { GraphtecProtocol } from "./graphtec";
import type { CutMaterial } from "./materials";
import type { CutterModel } from "./models";
import { CutterNotReadyError, type CutFrame, type CutterProtocol, type RegmarkSpec } from "./protocol";
import { boundingBox } from "../geometry";
import { LoggingTransport, type Transport } from "./transport";

export type CutPhase = "waiting" | "loadMat" | "reloadMat" | "homing" | "setup" | "manualRegmarks" | "regmarks" | "cutting" | "finishing" | "done";

export interface CutJob {
  paths: Contour[]; // sheet millimetres
  frame: CutFrame;
  regmarks: RegmarkSpec | null;
  /** How to register against the marks: the cutter's automatic scan (default), or the user jogging the tool onto the first mark. */
  registration?: "auto" | "manual";
  material: CutMaterial;
  /** Short description for the log, e.g. "sheet" or "calibration". */
  label?: string;
}

/** Lets the UI jog the tool onto the top-left mark during manual registration. Positions are media millimetres. */
export interface ManualJog {
  readonly x: number;
  readonly y: number;
  move(dxMm: number, dyMm: number): Promise<void>;
}

export interface JobEvents {
  onPhase?: (phase: CutPhase) => void;
  onProgress?: (fraction: number) => void;
  /** Called during manual registration; resolve once the tool is over the mark, reject to cancel. */
  onManualRegistration?: (jog: ManualJog) => Promise<void>;
}

class JogController implements ManualJog {
  x: number;
  y: number;
  private queue: Promise<void> = Promise.resolve();
  private readonly protocol: CutterProtocol;
  private readonly model: CutterModel;

  constructor(protocol: CutterProtocol, model: CutterModel, x: number, y: number) {
    this.protocol = protocol;
    this.model = model;
    this.x = x;
    this.y = y;
  }

  move(dxMm: number, dyMm: number): Promise<void> {
    this.x = Math.min(this.model.mat.widthMm, Math.max(0, this.x + dxMm));
    this.y = Math.min(this.model.mat.heightMm, Math.max(0, this.y + dyMm));
    const { x, y } = this;
    // Serialize moves so rapid clicks never interleave writes.
    this.queue = this.queue.then(() => this.protocol.moveTo(x, y));
    return this.queue;
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

function protocolFor(model: CutterModel, transport: Transport): CutterProtocol {
  switch (model.protocol) {
    case "graphtec-gpgl":
      return new GraphtecProtocol(transport, model);
  }
}

export class CutterSession {
  readonly model: CutterModel;
  readonly firmware: string;
  readonly transport: Transport;
  /** Everything sent to and received from the cutter since connecting. */
  readonly log: LoggingTransport;
  private readonly protocol: CutterProtocol;
  private busy = false;
  /**
   * True once the app has moved the mat since it was last loaded. The cutter only measures where
   * the paper really is when the mat is loaded; the per-job reset takes wherever the mat currently
   * sits as the top. After a job (which parks at the mark origin, or stops mid-scan if it fails),
   * a registered job therefore needs a fresh load first, or its mark search starts too far down.
   */
  private matMoved = false;

  private constructor(model: CutterModel, transport: Transport, log: LoggingTransport, protocol: CutterProtocol, firmware: string) {
    this.model = model;
    this.transport = transport;
    this.log = log;
    this.protocol = protocol;
    this.firmware = firmware;
  }

  /** Handshakes with the cutter on an already-open transport; closes the transport if that fails. */
  static async open(transport: Transport, model: CutterModel): Promise<CutterSession> {
    const log = new LoggingTransport(transport);
    log.note(`connect: ${model.manufacturer} ${model.name} via ${transport.label}; mark search args ${model.regmarkArgOrder}; home ${model.homeCommand ?? "none"}`);
    const protocol = protocolFor(model, log);
    try {
      const { firmware } = await protocol.initialize();
      log.note(`firmware: ${firmware}`);
      return new CutterSession(model, transport, log, protocol, firmware);
    } catch (e) {
      log.note(`initialization failed: ${(e as Error).message}`);
      await log.close();
      throw e;
    }
  }

  get label(): string {
    return `${this.model.manufacturer} ${this.model.name}`;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async run(job: CutJob, events: JobEvents = {}, signal?: AbortSignal): Promise<void> {
    if (this.busy) throw new Error("The cutter is already running a job");
    this.busy = true;
    this.noteJob(job);
    let touched = false;
    try {
      if (job.regmarks && this.matMoved) {
        events.onPhase?.("reloadMat");
        this.log.note("waiting for the mat to be unloaded and loaded again");
        await this.waitForFreshLoad(signal);
        this.matMoved = false;
        this.log.note("mat reloaded");
      }
      events.onPhase?.("waiting");
      await this.protocol.waitForReady({
        timeoutMs: 120_000,
        pollMs: 1000,
        signal,
        onStatus: (s) => events.onPhase?.(s === "unloaded" ? "loadMat" : "waiting"),
      });
      // Re-initialize at the start of every job, like each inkscape-silhouette run does. On a real
      // Cameo 3, the first job after connecting tapped the AutoBlade into its adjust holes correctly,
      // but later jobs in the same connection drifted right; each one inherited position state
      // from the previous job (e.g. the registration-mark origin).
      touched = true;
      await this.protocol.initialize();
      if (this.model.homeCommand) {
        events.onPhase?.("homing");
        await this.protocol.home();
      }
      events.onPhase?.("setup");
      await this.protocol.setup(job.material);
      if (job.regmarks && job.registration === "manual") {
        if (!events.onManualRegistration) throw new Error("Manual registration needs a UI to position the tool");
        events.onPhase?.("manualRegmarks");
        await this.protocol.prepareManualRegmarks(job.regmarks);
        await events.onManualRegistration(new JogController(this.protocol, this.model, job.regmarks.originXmm, job.regmarks.originYmm));
        signal?.throwIfAborted();
        events.onPhase?.("regmarks");
        await this.protocol.confirmManualRegmarks(job.regmarks);
      } else if (job.regmarks) {
        events.onPhase?.("regmarks");
        await this.protocol.searchRegmarks(job.regmarks);
      }
      events.onPhase?.("cutting");
      await this.protocol.cut(job.paths, job.frame, { onProgress: events.onProgress, signal });
      events.onPhase?.("finishing");
      await this.protocol.finish();
      events.onPhase?.("done");
      this.log.note("job done");
    } catch (e) {
      this.log.note(`job failed: ${(e as Error).message}`);
      if (signal?.aborted) {
        try {
          await this.protocol.abort();
        } catch {
          // best effort — the connection may be what failed
        }
      }
      throw e;
    } finally {
      if (touched) this.matMoved = true;
      this.busy = false;
    }
  }

  /** Polls until the cutter has reported the mat unloaded and then loaded again (up to 5 minutes). */
  private async waitForFreshLoad(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 300_000;
    let sawUnloaded = false;
    for (;;) {
      signal?.throwIfAborted();
      const status = await this.protocol.status();
      if (status === "unloaded") sawUnloaded = true;
      else if (status === "ready" && sawUnloaded) return;
      if (Date.now() >= deadline) break;
      await sleep(1000, signal);
    }
    throw new CutterNotReadyError(
      "The mat wasn't reloaded. Each print-and-cut job needs a fresh load: unload the mat, put the next sheet on it, load it again, then send."
    );
  }

  /** Homes the carriage on its own (the panel's Home button). */
  async home(): Promise<void> {
    if (this.busy) throw new Error("The cutter is busy");
    this.busy = true;
    this.log.note("home");
    try {
      await this.protocol.home();
    } finally {
      this.matMoved = true;
      this.busy = false;
    }
  }

  /** Diagnostics console: raw commands in, printable replies out (both also go to the log). */
  async sendRaw(lines: string[], listenMs?: number): Promise<string> {
    if (this.busy) throw new Error("The cutter is busy");
    this.busy = true;
    try {
      return await this.protocol.sendRaw(lines, listenMs);
    } finally {
      this.matMoved = true; // raw commands can move anything
      this.busy = false;
    }
  }

  private noteJob(job: CutJob) {
    const b = boundingBox(job.paths);
    const f = job.frame;
    const r = job.regmarks;
    this.log.note(
      [
        `job: ${job.label ?? "cut"}, ${job.paths.length} paths`,
        `sheet bbox (${b.minX.toFixed(2)}, ${b.minY.toFixed(2)})-(${b.maxX.toFixed(2)}, ${b.maxY.toFixed(2)}) mm`,
        `frame offset (${f.offsetXmm}, ${f.offsetYmm}) mm`,
        r ? `marks ${r.style} ${job.registration ?? "auto"} origin (${r.originXmm}, ${r.originYmm}) size ${r.widthMm.toFixed(2)}x${r.heightMm.toFixed(2)} mm` : "no marks",
        `material ${job.material.id} p${job.material.pressure} s${job.material.speed} d${job.material.autoBladeDepth}`,
      ].join("; ")
    );
  }

  async close(): Promise<void> {
    await this.log.close();
  }
}
