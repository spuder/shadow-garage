import type { Contour } from "../geometry";
import type { CutMaterial } from "./materials";

// The command-language layer: one implementation per protocol family (graphtec.ts for Silhouette;
// future: HPGL for Roland / generic vinyl cutters). Everything above this (session.ts, the UI) is
// protocol-agnostic.

export type CutterStatus = "ready" | "moving" | "unloaded" | "unknown";

/** Registration marks as printed on the sheet (see src/lib/regmarks.ts), in sheet millimetres. */
export interface RegmarkSpec {
  style: "standard" | "four_corner";
  originXmm: number; // top-left mark's corner
  originYmm: number;
  widthMm: number; // distance from the left marks to the right marks
  heightMm: number; // distance from the top marks to the bottom marks
}

/** Maps sheet millimetres to device millimetres, plus the area every cut point must stay inside. */
export interface CutFrame {
  offsetXmm: number; // added to every sheet-space point
  offsetYmm: number;
  clip: { minX: number; minY: number; maxX: number; maxY: number }; // device mm, after the offset
}

export interface CutProgress {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs: number;
  onStatus?: (status: CutterStatus) => void;
  signal?: AbortSignal;
}

export interface CutterProtocol {
  /** Resets the device and reads its firmware version — the minimal "is this really talking to a cutter" check. */
  handshake(): Promise<{ firmware: string }>;
  status(): Promise<CutterStatus>;
  waitForReady(opts: WaitOptions): Promise<void>;
  setup(material: CutMaterial): Promise<void>;
  /** Has the cutter optically find the printed marks; afterwards device (0,0) is the top-left mark. */
  searchRegmarks(spec: RegmarkSpec): Promise<void>;
  cut(paths: Contour[], frame: CutFrame, progress?: CutProgress): Promise<void>;
  /** Parks the tool after a job. */
  finish(): Promise<void>;
  /** Best-effort emergency stop. */
  abort(): Promise<void>;
}

export class CutterNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutterNotReadyError";
  }
}

export class RegmarkNotFoundError extends Error {
  constructor(detail: string) {
    super(`The cutter couldn't find the registration marks (${detail}). Check the sheet is loaded straight, top-left on the mat, and the marks printed dark and crisp.`);
    this.name = "RegmarkNotFoundError";
  }
}

export class CutOutOfBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutOutOfBoundsError";
  }
}
