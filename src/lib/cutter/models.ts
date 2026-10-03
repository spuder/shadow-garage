// Registry of cutters this app knows how to drive. Adding a model (or a whole manufacturer) should
// mostly be a new entry here, plus a protocol implementation if it doesn't speak one we already have.
//
// Hardware figures for Silhouette models come from fablabnbg/inkscape-silhouette's Graphtec.py
// device table (GPL-2.0 — used as a reference for facts about the hardware, not vendored).

export type HomeCommand = "TT" | "H" | null;

export type RegmarkArgOrder = "height_width" | "width_height";

export type ProtocolId = "graphtec-gpgl"; // future: "hpgl" (Roland, USCutter, generic USB-serial vinyl cutters)

/** Which Silhouette generation's setup and init sequence the model takes (see graphtec.ts). */
export type GpglVariant = "cameo3" | "cameo4";

export interface CutterModel {
  id: string;
  manufacturer: string;
  name: string;
  protocol: ProtocolId;
  gpglVariant: GpglVariant;
  usb?: { vendorId: number; productId: number };
  /**
   * Bluetooth: BLE via Web Bluetooth (the default), or Classic RFCOMM via Web Serial with
   * rfcommServiceClassId. Bluetooth has no USB ids, so the model is identified by the FG reply or the
   * advertised name (e.g. "CAMEO3-30411C") starting with one of firmwarePrefixes.
   */
  bluetooth?: { rfcommServiceClassId: string; firmwarePrefixes: string[] };
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
  /** Extra distance (mm) down the sheet at which the mark search starts, on top of regmarkSearchMarginMm. */
  regmarkScanOffsetMm: number;
  /** How far up and left of the top-left mark (mm) the search starts: upstream's 10. */
  regmarkSearchMarginMm: number;
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

/** Bluetooth Serial Port Profile (SPP), service class 0x1101. */
export const SERIAL_PORT_PROFILE_UUID = "00001101-0000-1000-8000-00805f9b34fb";

export const CUTTER_MODELS: CutterModel[] = [
  {
    id: "silhouette-cameo3",
    manufacturer: "Silhouette",
    name: "Cameo 3",
    protocol: "graphtec-gpgl",
    gpglVariant: "cameo3",
    usb: { vendorId: 0x0b4d, productId: 0x112f },
    // The standard Serial Port Profile UUID. Upstream connects to raw RFCOMM channel 1 and never
    // looks the service up, so this is unconfirmed on hardware; ?btService=<uuid> overrides it.
    bluetooth: { rfcommServiceClassId: SERIAL_PORT_PROFILE_UUID, firmwarePrefixes: ["CAMEO3", "CAMEO 3"] },
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
    regmarkSearchMarginMm: 10,
    regmarkSearchStepsMm: [0, 2, 4, 6],
    pressureRange: [1, 33],
    speedRange: [1, 10],
    toolHolders: 2,
    mat: { id: "cameo_12x12", widthMm: 304.8, heightMm: 304.8 },
  },
  {
    id: "silhouette-cameo4",
    manufacturer: "Silhouette",
    name: "Cameo 4",
    protocol: "graphtec-gpgl",
    gpglVariant: "cameo4",
    usb: { vendorId: 0x0b4d, productId: 0x1137 },
    // Upstream matches "CAMEO 4", over the same service as the Cameo 3; unconfirmed on hardware here.
    bluetooth: { rfcommServiceClassId: SERIAL_PORT_PROFILE_UUID, firmwarePrefixes: ["CAMEO4", "CAMEO 4"] },
    bedWidthMm: 304.8,
    maxLengthMm: 3000,
    marginLeftMm: 0,
    marginTopMm: 0,
    regmarks: "standard",
    regmarkArgOrder: "height_width",
    homeCommand: null,
    // Replies -1 after measuring the square unless the search starts below it; 6 mm clears a
    // 5.5 mm square (tuned on hardware), not a larger one.
    regmarkScanOffsetMm: 6,
    regmarkSearchMarginMm: 0,
    regmarkSearchStepsMm: [0, 2, 4, 6],
    pressureRange: [1, 33],
    speedRange: [1, 30],
    toolHolders: 2,
    mat: { id: "cameo_12x12", widthMm: 304.8, heightMm: 304.8 },
  },
  // Not yet supported — each needs a gpglVariant (upstream drives the Cameo 5 like a Cameo 4) and hardware testing:
  //   Silhouette Cameo 5 (0x0b4d:0x1140), Portrait 3 (0x0b4d:0x113a), ...
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

/** Service class ids to offer in the Web Serial picker, so it lists Bluetooth cutters. */
export function bluetoothServiceClassIds(): string[] {
  return [...new Set(CUTTER_MODELS.flatMap((m) => (m.bluetooth ? [m.bluetooth.rfcommServiceClassId] : [])))];
}

/** The model a Bluetooth handshake starts with, before the firmware reply identifies the real one. */
export function provisionalBluetoothModel(): CutterModel | undefined {
  return CUTTER_MODELS.find((m) => m.bluetooth);
}

/**
 * Picks the model for a Bluetooth connection from its FG reply, then from the advertised device
 * name. If neither matches and the reply names no model at all, the Cameo 3 (the first Bluetooth
 * model) is assumed (`guessed`): over USB a Cameo 3 has been seen to answer just "CAMEO V1.10".
 */
export function modelForBluetoothFirmware(firmware: string, deviceName = ""): { model: CutterModel; guessed: boolean } | undefined {
  const bt = CUTTER_MODELS.filter((m) => m.bluetooth);
  for (const text of [firmware, deviceName]) {
    const t = text.trim().toUpperCase();
    const match = t && bt.find((m) => m.bluetooth!.firmwarePrefixes.some((p) => t.startsWith(p.toUpperCase())));
    if (match) return { model: match, guessed: false };
  }
  return bt.length > 0 && /^CAMEO V\d/i.test(firmware.trim()) ? { model: bt[0], guessed: true } : undefined;
}
