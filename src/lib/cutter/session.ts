// One connected cutter: owns the transport + protocol and runs whole jobs
// (wait for mat → setup → optional mark search → cut → park).

import type { Contour } from "../geometry";
import { GraphtecProtocol } from "./graphtec";
import type { CutMaterial } from "./materials";
import type { CutterModel } from "./models";
import type { CutFrame, CutterProtocol, RegmarkSpec } from "./protocol";
import type { Transport } from "./transport";

export type CutPhase = "waiting" | "loadMat" | "setup" | "regmarks" | "cutting" | "finishing" | "done";

export interface CutJob {
  paths: Contour[]; // sheet millimetres
  frame: CutFrame;
  regmarks: RegmarkSpec | null;
  material: CutMaterial;
}

export interface JobEvents {
  onPhase?: (phase: CutPhase) => void;
  onProgress?: (fraction: number) => void;
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
  private readonly protocol: CutterProtocol;
  private busy = false;

  private constructor(model: CutterModel, transport: Transport, protocol: CutterProtocol, firmware: string) {
    this.model = model;
    this.transport = transport;
    this.protocol = protocol;
    this.firmware = firmware;
  }

  /** Handshakes with the cutter on an already-open transport; closes the transport if that fails. */
  static async open(transport: Transport, model: CutterModel): Promise<CutterSession> {
    const protocol = protocolFor(model, transport);
    try {
      const { firmware } = await protocol.handshake();
      return new CutterSession(model, transport, protocol, firmware);
    } catch (e) {
      await transport.close();
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
    try {
      events.onPhase?.("waiting");
      await this.protocol.waitForReady({
        timeoutMs: 120_000,
        pollMs: 1000,
        signal,
        onStatus: (s) => events.onPhase?.(s === "unloaded" ? "loadMat" : "waiting"),
      });
      events.onPhase?.("setup");
      await this.protocol.setup(job.material);
      if (job.regmarks) {
        events.onPhase?.("regmarks");
        await this.protocol.searchRegmarks(job.regmarks);
      }
      events.onPhase?.("cutting");
      await this.protocol.cut(job.paths, job.frame, { onProgress: events.onProgress, signal });
      events.onPhase?.("finishing");
      await this.protocol.finish();
      events.onPhase?.("done");
    } catch (e) {
      if (signal?.aborted) {
        try {
          await this.protocol.abort();
        } catch {
          // best effort — the connection may be what failed
        }
      }
      throw e;
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
