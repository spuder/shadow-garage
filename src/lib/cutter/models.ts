// Registry of cutters this app knows how to drive. Adding a model (or a whole manufacturer) should
// mostly be a new entry here, plus a protocol implementation if it doesn't speak one we already have.
//
// Hardware figures for Silhouette models come from fablabnbg/inkscape-silhouette's Graphtec.py
// device table (GPL-2.0 — used as a reference for facts about the hardware, not vendored).

export type HomeCommand = "TT" | "H" | null;

export type RegmarkArgOrder = "height_width" | "width_height";

export type ProtocolId = "graphtec-gpgl"; // future: "hpgl" (Roland, USCutter, generic USB-serial vinyl cutters)

export interface CutterModel {
  id: string;
  manufacturer: string;
  name: string;
  protocol: ProtocolId;
  usb?: { vendorId: number; productId: number };
  /** v2 placeholder: Bluetooth Classic (RFCOMM via Web Serial) or BLE (Web Bluetooth) details. */
  bluetooth?: { rfcommServiceClassId?: string; bleServiceUuid?: string };
  bedWidthMm: number;
  maxLengthMm: number;
  marginLeftMm: number;
  marginTopMm: number;
  /** Which registration-mark layout the optical sensor can read (see src/lib/regmarks.ts). */
  regmarks: "none" | "standard" | "four_corner";
  /**
   * Order of the mark-to-mark distances in the mark-search commands (TB123 / TB23). Graphtec.py
   * sends height first; the Silhouette Studio trace in upstream's Commands.md shows width first.
   * Which one a model really expects is being confirmed on hardware with the calibration cut.
   */
  regmarkArgOrder: RegmarkArgOrder;
  /**
   * Command that physically homes the carriage before a job, so the AutoBlade depth tap and the
   * mark search start from a known position. Silhouette Studio's startup sequence (upstream
   * Commands.md) sends TT; GPGL also has H. null = don't home (Graphtec.py's behaviour).
   * On a real Cameo 3, TT had no visible effect, so it's off until a working command is found.
   */
  homeCommand: HomeCommand;
  /**
   * Extra distance (mm) down the sheet at which the mark search starts, on top of upstream's
   * "10 mm before the top-left mark". For tuning if the cutter scans too near the paper's top edge.
   */
  regmarkScanOffsetMm: number;
  /**
   * The mark search (TB123) is one-shot. If it fails, it's retried starting this much further down
   * the sheet (mm, relative to the first attempt), one attempt per entry.
   */
  regmarkSearchStepsMm: number[];
  pressureRange: [number, number];
  speedRange: [number, number];
  toolHolders: number;
  /** Cutting mat the job is laid out on. v1 assumes the standard 12×12in mat. */
  mat: { id: string; widthMm: number; heightMm: number };
}

export const CUTTER_MODELS: CutterModel[] = [
  {
    id: "silhouette-cameo3",
    manufacturer: "Silhouette",
    name: "Cameo 3",
    protocol: "graphtec-gpgl",
    usb: { vendorId: 0x0b4d, productId: 0x112f },
    bedWidthMm: 304.8,
    maxLengthMm: 3000,
    marginLeftMm: 0,
    marginTopMm: 0,
    regmarks: "standard",
    regmarkArgOrder: "height_width",
    homeCommand: null,
    // Tuned on hardware: from upstream's start (10 mm above the top-left mark) the first scan
    // missed and a retry 3 mm lower found the marks; starting 3 mm lower then worked first time.
    regmarkScanOffsetMm: 3,
    regmarkSearchStepsMm: [0, 2, 4, 6],
    pressureRange: [1, 33],
    speedRange: [1, 10],
    toolHolders: 2,
    mat: { id: "cameo_12x12", widthMm: 304.8, heightMm: 304.8 },
  },
  // Not yet supported — each needs its own setup-command variant in graphtec.ts and hardware testing:
  //   Silhouette Cameo 4 (0x0b4d:0x1137), Cameo 5 (0x0b4d:0x1140), Portrait 3 (0x0b4d:0x113a), ...
];

export function modelById(id: string): CutterModel | undefined {
  return CUTTER_MODELS.find((m) => m.id === id);
}

export function modelForUsb(vendorId: number, productId: number): CutterModel | undefined {
  return CUTTER_MODELS.find((m) => m.usb?.vendorId === vendorId && m.usb.productId === productId);
}

/** Filters for navigator.usb.requestDevice(), so the browser's picker only lists supported cutters. */
export function usbFilters(): USBDeviceFilter[] {
  return CUTTER_MODELS.filter((m) => m.usb).map((m) => ({ vendorId: m.usb!.vendorId, productId: m.usb!.productId }));
}
