import "./style.css";
import { extractAlphaMask, type RawMask } from "./lib/trace";
import { prepareImportedArtwork, type ArtworkMask } from "./lib/artworkMask";
import { computeDesign, scaleDesign, type DesignResult } from "./lib/design";
import { translateContours } from "./lib/geometry";
import { SHEET_SIZES, nudgeIntoArea, packMixedSheet, stickerKeepout, type KeepoutRect, type MixedPlacement, type SheetSize } from "./lib/sheet";
import { buildSingleStickerSVG, buildSheetSVG, type RenderOptions, type SheetItem } from "./lib/svgBuilder";
import { bakeColorAdjust, COLOR_ADJUST_KEYS, isNoColorAdjust, NO_COLOR_ADJUST, type ColorAdjust } from "./lib/colorAdjust";
import { getRegmarkKeepoutRects, REGMARK_ORIGIN_MM } from "./lib/regmarks";
import { downloadBlob, downloadSvgString } from "./lib/download";
import { parseStudio3, writeStudio3, type Studio3Document, type Studio3Placement } from "./lib/studio3";
import { renderArtworkPng, studio3StickerFor, type Studio3Image } from "./lib/studio3Artwork";
import studio3TemplateUrl from "./lib/studio3Template.studio3?url";
import { printSvg } from "./lib/print";
import { flattenForPrint } from "./lib/printArtwork";
import { LAMINATE_EXTRA_DEPTH, PAPER_TYPES } from "./lib/paperTypes";
import { getInitialTheme, applyTheme, type Theme } from "./lib/theme";
import { isSupportedBrowser, showUnsupportedBrowserAlert } from "./lib/browserCheck";
import { showAlert } from "./lib/alertDialog";
import { isSvgFile } from "./lib/svgArtwork";
import { fitCamera, zoomAt, panBy, mmToScreen, screenToMm, type Camera } from "./lib/camera";
import { buildCalibrationSVG, calibrationPaths } from "./lib/cutter/calibration";
import { buildCutPaths, CutJobError, layoutJob, testSquarePaths } from "./lib/cutter/job";
import { provisionalBluetoothModel, type CutterModel } from "./lib/cutter/models";
import { CutterCancelledError, RegmarkNotFoundError } from "./lib/cutter/protocol";
import { CutterSession, type CutJob, type CutPhase, type ManualJog } from "./lib/cutter/session";
import type { LoggingTransport } from "./lib/cutter/transport";
import { reconnectBleCutter, requestBleCutter, webBluetoothSupported, WebBluetoothTransport } from "./lib/cutter/webBluetoothTransport";
import { identifyBluetoothModel, reconnectBluetoothCutter, requestBluetoothCutter, webSerialSupported, WebSerialTransport } from "./lib/cutter/webSerialTransport";
import { reconnectUsbCutter, requestUsbCutter, webUsbSupported, WebUsbTransport } from "./lib/cutter/webUsbTransport";

const MM_PER_IN = 25.4;
const MIN_SIZE_MM = 0.25 * MM_PER_IN;

type Tab = "design" | "sheet";
type FillMode = "single" | "fill";

type CutKind = "sheet" | "test" | "calibration";

interface CutterUiState {
  session: CutterSession | null;
  connecting: boolean;
  job: AbortController | null; // set while a cut is running
  statusText: string | null; // job progress / result; null shows the connection summary
  error: string | null;
  log: LoggingTransport | null; // kept after disconnecting so it can still be copied
  manualRetryKind: CutKind | null; // set when the mark search failed, to offer manual registration
  manualRetryDryRun: boolean; // whether that failed job was a dry run
  jog: { jog: ManualJog; resolve: () => void; reject: (e: Error) => void } | null; // manual registration in progress
  jogStepMm: 1 | 5;
  busyOp: boolean; // Home button or raw diagnostics command in progress
}

interface StickerDesign {
  id: string;
  fileName: string;
  imageDataUrl: string;
  raw: RawMask | null; // the artwork's alpha mask, for tracing; null for an imported sticker whose artwork has nothing to trace
  artworkAspect: number;
  widthMm: number;
  heightMm: number;
  aspectLocked: boolean;
  driveBy: "width" | "height"; // which axis is authoritative when aspect is locked (see design.ts)
  marginMm: number; // space around the artwork, per sticker
  preserveSharpCorners: boolean;
  design: DesignResult | null;
  // Set for a sticker read from a .studio3 file: its outline and artwork at the size they have
  // there, and which of the file's stickers it is (for writing the file back).
  // `artWidthMm` is how wide the artwork's opaque part is at the file's size, when the artwork
  // has a transparent background (then `raw` holds its mask); null when it can't be traced.
  // `traced` turns true once the margin is changed: the outline is then traced like an upload's.
  imported: { base: DesignResult; studio3Index: number; artWidthMm: number | null; traced: boolean } | null;
  pinned: { x: number; y: number } | null; // its own spot on the sheet (top-left); the packer works around it
}

interface AppState {
  theme: Theme;
  paperTypeId: string;
  sheetIndex: number;
  fillMode: FillMode;
  allowRotation: boolean; // let the packer turn stickers a quarter turn to fit more on the sheet
  marginMm: number; // margin and sharp corners for the next sticker added: the last values chosen
  preserveSharpCorners: boolean;
  gapMm: number;
  sheetMarginMm: number;
  cutSpeed: number | null; // cutter speed chosen with the slider; null = the paper type's default
  cutPressure: number | null; // blade pressure chosen with the slider; null = the paper type's default
  cutDepth: number | null; // AutoBlade depth chosen with the slider; null = the paper type's default
  laminated: boolean | null; // the Laminated box; null = the paper type's default (on for white and holographic stickers)
  colorAdjust: ColorAdjust | null; // artwork brightness/contrast/saturation from the sliders; null = the paper type's default
  printCutLines: boolean; // include the red cut outlines when printing (the SVG download always has them)
  regmarksEnabled: boolean;
  regmarkStyle: "standard" | "four_corner";
  designs: StickerDesign[];
  selectedDesignId: string | null; // the selected sticker: the one the panel and the resize handles follow
  alsoSelectedIds: string[]; // more stickers selected with it (⌘/Ctrl/⇧-click): size, margin and corners apply to them all
  activeTab: Tab;
  camera: Camera;
  fitScale: number;
  editingSelected: boolean;
  editingPlacementXY: { x: number; y: number; rotated: boolean } | null; // where the selected design's edited instance sits on the sheet (sheet tab only)
  needsRefit: boolean;
  lastPlacements: MixedPlacement[];
  studio3: { doc: Studio3Document; fileName: string } | null; // the imported file that Export writes back
  studio3Status: { text: string; error: boolean } | null;
  cutter: CutterUiState;
}

const state: AppState = {
  theme: getInitialTheme(),
  paperTypeId: PAPER_TYPES[0].id,
  sheetIndex: 0,
  fillMode: "single",
  allowRotation: true,
  marginMm: 1,
  preserveSharpCorners: false,
  gapMm: 4,
  sheetMarginMm: 8,
  cutSpeed: null,
  cutPressure: null,
  cutDepth: null,
  laminated: null,
  colorAdjust: null,
  printCutLines: false,
  regmarksEnabled: true,
  regmarkStyle: "standard",
  designs: [],
  selectedDesignId: null,
  alsoSelectedIds: [],
  activeTab: "design",
  camera: { scale: 1, tx: 0, ty: 0 },
  fitScale: 1,
  editingSelected: false,
  editingPlacementXY: null,
  needsRefit: true,
  lastPlacements: [],
  studio3: null,
  studio3Status: null,
  cutter: { session: null, connecting: false, job: null, statusText: null, error: null, log: null, manualRetryKind: null, manualRetryDryRun: false, jog: null, jogStepMm: 1, busyOp: false },
};

applyTheme(state.theme);

// ---- element refs ----
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const studio3Input = document.getElementById("studio3Input") as HTMLInputElement;
const importStudio3Btn = document.getElementById("importStudio3Btn") as HTMLButtonElement;
const exportStudio3Btn = document.getElementById("exportStudio3Btn") as HTMLButtonElement;
const studio3StatusEl = document.getElementById("studio3Status") as HTMLDivElement;
const dropzone = document.getElementById("dropzone") as HTMLDivElement;
const previewHost = document.getElementById("previewHost") as HTMLDivElement;
const viewportInner = document.getElementById("viewportInner") as HTMLDivElement;
const overlayLayer = document.getElementById("overlayLayer") as HTMLDivElement;
const zoomControls = document.getElementById("zoomControls") as HTMLDivElement;
const thumbStrip = document.getElementById("thumbStrip") as HTMLDivElement;

const imageBlock = document.getElementById("imageBlock") as HTMLDivElement;
const fileNameEl = document.getElementById("fileName") as HTMLSpanElement;
const addImageBtn = document.getElementById("addImageBtn") as HTMLButtonElement;
const removeImageBtn = document.getElementById("removeImageBtn") as HTMLButtonElement;
const selectAllBtn = document.getElementById("selectAllBtn") as HTMLButtonElement;

const sizeBlock = document.getElementById("sizeBlock") as HTMLDivElement;
const widthInput = document.getElementById("widthInput") as HTMLInputElement;
const heightInput = document.getElementById("heightInput") as HTMLInputElement;
const lockAspectBtn = document.getElementById("lockAspectBtn") as HTMLButtonElement;
const lockIconClosed = document.getElementById("lockIconClosed") as unknown as SVGElement;
const lockIconOpen = document.getElementById("lockIconOpen") as unknown as SVGElement;

const themeToggle = document.getElementById("themeToggle") as HTMLButtonElement;
const themeIconMoon = document.getElementById("themeIconMoon") as unknown as SVGElement;
const themeIconSun = document.getElementById("themeIconSun") as unknown as SVGElement;

const paperTypeGrid = document.getElementById("paperTypeGrid") as HTMLDivElement;
const sheetSelect = document.getElementById("sheetSelect") as HTMLSelectElement;

const marginSlider = document.getElementById("marginSlider") as HTMLInputElement;
const marginInput = document.getElementById("marginInput") as HTMLInputElement;
const marginForEl = document.getElementById("marginFor") as HTMLSpanElement;
const sharpCornersToggle = document.getElementById("sharpCornersToggle") as HTMLInputElement;
const gapInput = document.getElementById("gapInput") as HTMLInputElement;
const gapValue = document.getElementById("gapValue") as HTMLSpanElement;

const fillModeToggle = document.getElementById("fillModeToggle") as HTMLDivElement;
const rotateToggle = document.getElementById("rotateToggle") as HTMLInputElement;
const regmarksToggle = document.getElementById("regmarksToggle") as HTMLInputElement;
const regmarkStyleToggle = document.getElementById("regmarkStyleToggle") as HTMLDivElement;

const tabs = Array.from(document.querySelectorAll(".tab")) as HTMLButtonElement[];
const sheetCountBadge = document.getElementById("sheetCount") as HTMLSpanElement;
const summaryEl = document.getElementById("summary") as HTMLDivElement;
const downloadSvgBtn = document.getElementById("downloadSvgBtn") as HTMLButtonElement;
const printBtn = document.getElementById("printBtn") as HTMLButtonElement;
const printCutLinesToggle = document.getElementById("printCutLinesToggle") as HTMLInputElement;
const marksTipEl = document.getElementById("marksTip") as HTMLDivElement;
const sendToCutterBtn = document.getElementById("sendToCutterBtn") as HTMLButtonElement;
const cutterStatusEl = document.getElementById("cutterStatus") as HTMLDivElement;
const cutterConnectBtn = document.getElementById("cutterConnectBtn") as HTMLButtonElement;
const cutterStatusRow = document.getElementById("cutterStatusRow") as HTMLDivElement;
const cutterPill = document.getElementById("cutterPill") as HTMLButtonElement;
const cutterPillText = document.getElementById("cutterPillText") as HTMLSpanElement;
const cutterDialog = document.getElementById("cutterDialog") as HTMLDialogElement;
const cutterDialogClose = document.getElementById("cutterDialogClose") as HTMLButtonElement;
const cutterLinkToggle = document.getElementById("cutterLinkToggle") as HTMLDivElement;
const cutterDialogConnect = document.getElementById("cutterDialogConnect") as HTMLDivElement;
const cutterDialogConnectBtn = document.getElementById("cutterDialogConnectBtn") as HTMLButtonElement;
const cutterDialogConnected = document.getElementById("cutterDialogConnected") as HTMLDivElement;
const cutterDeviceName = document.getElementById("cutterDeviceName") as HTMLDivElement;
const cutterDeviceDetail = document.getElementById("cutterDeviceDetail") as HTMLDivElement;
const cutterDialogDisconnectBtn = document.getElementById("cutterDialogDisconnectBtn") as HTMLButtonElement;
const cutterDialogError = document.getElementById("cutterDialogError") as HTMLDivElement;
const cutterDialogHint = document.getElementById("cutterDialogHint") as HTMLDivElement;
const cutterTestBtn = document.getElementById("cutterTestBtn") as HTMLButtonElement;
const cutterHomeBtn = document.getElementById("cutterHomeBtn") as HTMLButtonElement;
const rawBlock = document.getElementById("rawBlock") as HTMLDivElement;
const rawInput = document.getElementById("rawInput") as HTMLTextAreaElement;
const rawSendBtn = document.getElementById("rawSendBtn") as HTMLButtonElement;
const rawReplyEl = document.getElementById("rawReply") as HTMLPreElement;
const CUTTER_DEBUG = new URLSearchParams(location.search).has("debug");
// Bluetooth goes over BLE (Web Bluetooth) unless ?btSerial=1 (or a Web Serial switch) picks Bluetooth
// Classic RFCOMM via Web Serial. A Cameo 3 paired as Classic on macOS never answered on its serial port.
const BT_SERIAL = ["btSerial", "btAnyPort", "btService"].some((k) => new URLSearchParams(location.search).has(k));
const cutterErrorEl = document.getElementById("cutterError") as HTMLDivElement;
const cutterMaterialEl = document.getElementById("cutterMaterial") as HTMLDivElement;
const colorSliders = Object.fromEntries(
  COLOR_ADJUST_KEYS.map((k) => [k, document.getElementById(`${k}Slider`) as HTMLInputElement])
) as Record<(typeof COLOR_ADJUST_KEYS)[number], HTMLInputElement>;
const colorValues = Object.fromEntries(
  COLOR_ADJUST_KEYS.map((k) => [k, document.getElementById(`${k}Value`) as HTMLSpanElement])
) as Record<(typeof COLOR_ADJUST_KEYS)[number], HTMLSpanElement>;
const colorAdjustNote = document.getElementById("colorAdjustNote") as HTMLSpanElement;
const colorAdjustResetBtn = document.getElementById("colorAdjustResetBtn") as HTMLButtonElement;
const cutSpeedSlider = document.getElementById("cutSpeedSlider") as HTMLInputElement;
const cutSpeedValue = document.getElementById("cutSpeedValue") as HTMLSpanElement;
const cutSpeedDefault = document.getElementById("cutSpeedDefault") as HTMLSpanElement;
const cutPressureSlider = document.getElementById("cutPressureSlider") as HTMLInputElement;
const cutPressureValue = document.getElementById("cutPressureValue") as HTMLSpanElement;
const cutPressureDefault = document.getElementById("cutPressureDefault") as HTMLSpanElement;
const cutDepthSlider = document.getElementById("cutDepthSlider") as HTMLInputElement;
const cutDepthValue = document.getElementById("cutDepthValue") as HTMLSpanElement;
const cutDepthDefault = document.getElementById("cutDepthDefault") as HTMLSpanElement;
const laminatedToggle = document.getElementById("laminatedToggle") as HTMLInputElement;
const copyLogBtn = document.getElementById("copyLogBtn") as HTMLButtonElement;
const calSheetBtn = document.getElementById("calSheetBtn") as HTMLButtonElement;
const calCutBtn = document.getElementById("calCutBtn") as HTMLButtonElement;
const dryRunBtn = document.getElementById("dryRunBtn") as HTMLButtonElement;
const manualRegBtn = document.getElementById("manualRegBtn") as HTMLButtonElement;
const jogPad = document.getElementById("jogPad") as HTMLDivElement;
const jogStepBtn = document.getElementById("jogStepBtn") as HTMLButtonElement;
const jogPosEl = document.getElementById("jogPos") as HTMLDivElement;
const jogRegisterBtn = document.getElementById("jogRegisterBtn") as HTMLButtonElement;
const jogCancelBtn = document.getElementById("jogCancelBtn") as HTMLButtonElement;

const zoomOutBtn = document.getElementById("zoomOutBtn") as HTMLButtonElement;
const zoomInBtn = document.getElementById("zoomInBtn") as HTMLButtonElement;
const zoomFitBtn = document.getElementById("zoomFitBtn") as HTMLButtonElement;

// ---- static option lists ----
function sheetLabel(s: SheetSize): string {
  return `${s.name} (${(s.widthMm / MM_PER_IN).toFixed(1)} × ${(s.heightMm / MM_PER_IN).toFixed(1)} in)`;
}
function addSheetOption(s: SheetSize, i: number) {
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = sheetLabel(s);
  sheetSelect.appendChild(opt);
}
SHEET_SIZES.forEach(addSheetOption);

// Grouped so it's obvious which stocks are adhesive sticker sheets and which are plain paper.
const PAPER_GROUPS = [
  { title: "Adhesive sticker sheets", adhesive: true },
  { title: "Plain paper (no adhesive)", adhesive: false },
];
for (const group of PAPER_GROUPS) {
  const types = PAPER_TYPES.filter((pt) => pt.adhesive === group.adhesive);
  if (types.length === 0) continue;
  const title = document.createElement("div");
  title.className = "paper-group-title";
  title.textContent = group.title;
  paperTypeGrid.appendChild(title);
  types.forEach(addPaperSwatch);
}

function addPaperSwatch(pt: (typeof PAPER_TYPES)[number]) {
  const btn = document.createElement("button");
  btn.className = "paper-swatch" + (pt.id === state.paperTypeId ? " active" : "");
  btn.dataset.paperId = pt.id;
  btn.innerHTML = `<span class="paper-swatch-color" style="background:${pt.swatch}"></span><span class="paper-swatch-label">${pt.name}</span>`;
  btn.addEventListener("click", () => {
    state.paperTypeId = pt.id;
    state.cutSpeed = null; // back to the new paper type's own speed, pressure and blade depth
    state.cutPressure = null;
    state.cutDepth = null;
    state.laminated = null; // and whether it's usually laminated
    state.colorAdjust = null; // and its own colour starting point (darker for holographic)
    paperTypeGrid.querySelectorAll(".paper-swatch").forEach((el) => el.classList.toggle("active", el === btn));
    recompute();
  });
  paperTypeGrid.appendChild(btn);
}

// ---- helpers ----
function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function mmToIn(mm: number): number {
  return mm / MM_PER_IN;
}
function inToMm(inch: number): number {
  return inch * MM_PER_IN;
}
function fmtIn(mm: number): string {
  return mmToIn(mm).toFixed(2);
}

/** Whether the sheet is laminated: the box if it's been changed, else the paper type's default. */
function isLaminated(): boolean {
  return state.laminated ?? !!currentPaperType().laminatedByDefault;
}

/** The paper type's cut settings, one blade depth step deeper when the sheet is laminated: what the sliders start from. */
function defaultCutMaterial() {
  const m = currentPaperType().cutMaterial;
  return isLaminated() ? { ...m, autoBladeDepth: Math.min(10, m.autoBladeDepth + LAMINATE_EXTRA_DEPTH) } : m;
}

/** Cut settings for the next job: the defaults above, with the speed, pressure and blade depth sliders' choices if they've been moved. */
function currentCutMaterial() {
  const m = defaultCutMaterial();
  return { ...m, speed: state.cutSpeed ?? m.speed, pressure: state.cutPressure ?? m.pressure, autoBladeDepth: state.cutDepth ?? m.autoBladeDepth };
}

/** Colour adjustment for the artwork: the sliders' values if moved, else the paper type's default. */
function currentColorAdjust(): ColorAdjust {
  return state.colorAdjust ?? currentPaperType().colorAdjust ?? NO_COLOR_ADJUST;
}

function currentPaperType() {
  return PAPER_TYPES.find((p) => p.id === state.paperTypeId) ?? PAPER_TYPES[0];
}

function currentSheet(): SheetSize {
  return SHEET_SIZES[state.sheetIndex];
}

function currentRegmarkStyle(): false | "standard" | "four_corner" {
  return state.regmarksEnabled ? state.regmarkStyle : false;
}

function selectedDesign(): StickerDesign | null {
  return state.designs.find((d) => d.id === state.selectedDesignId) ?? null;
}

/** Every selected sticker, the main one first. */
function selectedDesigns(): StickerDesign[] {
  const main = selectedDesign();
  if (!main) return [];
  return [main, ...state.alsoSelectedIds.map((id) => state.designs.find((d) => d.id === id)).filter((d): d is StickerDesign => !!d && d !== main)];
}

/** Selects just this sticker (or nothing). */
function selectOnly(id: string | null) {
  state.selectedDesignId = id;
  state.alsoSelectedIds = [];
}

/**
 * Adds a sticker to the selection, or takes it out if it's in it. The one added becomes the main
 * selection; taking the main one out hands that to the next selected sticker.
 */
function toggleSelected(id: string) {
  const main = state.selectedDesignId;
  if (id === main) {
    if (state.alsoSelectedIds.length > 0) state.selectedDesignId = state.alsoSelectedIds.shift()!;
  } else if (state.alsoSelectedIds.includes(id)) {
    state.alsoSelectedIds = state.alsoSelectedIds.filter((x) => x !== id);
  } else {
    if (main) state.alsoSelectedIds.push(main);
    state.selectedDesignId = id;
  }
}

/** Whether a click should add to the selection rather than replace it. */
function isAddToSelection(e: MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey;
}

/** Where the main selected sticker's first copy sits on the sheet, for its handles. */
function firstPlacementOf(id: string | null): { x: number; y: number; rotated: boolean } | null {
  const p = state.lastPlacements.find((pp) => pp.id === id);
  return p ? { x: p.x, y: p.y, rotated: p.rotated } : null;
}

function renderOptionsFor(design: StickerDesign): RenderOptions {
  const pt = currentPaperType();
  return {
    imageDataUrl: design.imageDataUrl,
    borderColor: pt.exportColor,
    cutStrokeWidthMm: 0.15,
    showBorder: pt.showBorder,
    clipArtwork: !!design.imported, // Studio files often hold artwork with a solid background
    colorAdjust: currentColorAdjust(),
  };
}

/** Strips the physical "mm" unit suffix from an SVG's width/height so 1 SVG user-unit = 1 on-screen px pre-transform. */
function toScreenSVG(svgMarkup: string): string {
  return svgMarkup.replace(/width="([\d.]+)mm"/, 'width="$1"').replace(/height="([\d.]+)mm"/, 'height="$1"');
}

function maxStickerDimMm(): number {
  const sheet = currentSheet();
  return Math.min(sheet.widthMm, sheet.heightMm) - 2 * packingMarginMm();
}

/**
 * Sheet-edge margin for packing. With registration marks on, the cutter can only cut inside the
 * area bounded by the marks (they sit REGMARK_ORIGIN_MM in from every edge), so stickers keep a
 * little further in than that; the corner keepouts separately keep art clear of the marks.
 */
function packingMarginMm(): number {
  return state.regmarksEnabled ? Math.max(state.sheetMarginMm, REGMARK_ORIGIN_MM + 2) : state.sheetMarginMm;
}

/** Resolves placements to renderable SheetItems, in the same order. */
function sheetItemsFor(placements: MixedPlacement[]): SheetItem[] {
  return placements
    .map((p) => {
      const d = state.designs.find((dd) => dd.id === p.id);
      if (!d || !d.design) return null;
      return { design: d.design, x: p.x, y: p.y, rotated: p.rotated, opts: renderOptionsFor(d) } as SheetItem;
    })
    .filter((x): x is SheetItem => x !== null);
}

/** A pinned sticker's bounding box on the sheet. */
function pinnedRect(d: StickerDesign): KeepoutRect {
  return { x: d.pinned!.x, y: d.pinned!.y, w: d.design!.actualWmm, h: d.design!.actualHmm };
}

function rectsOverlap(a: KeepoutRect, b: KeepoutRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Moves pinned stickers the least distance that puts them inside the area the cutter can reach
 * and clear of the registration marks. Studio files often have art a few mm from the page edge,
 * outside what the marks calibrate, and there's nothing for the user to decide: it just goes
 * where it can be cut. Returns how many moved.
 */
function fitPinnedToSheet(sheet: SheetSize): number {
  const marks = state.regmarksEnabled ? getRegmarkKeepoutRects(sheet.widthMm, sheet.heightMm, state.regmarkStyle === "four_corner") : [];
  let moved = 0;
  for (const d of state.designs) {
    if (!d.pinned) continue;
    const w = d.design?.actualWmm ?? d.widthMm;
    const h = d.design?.actualHmm ?? d.heightMm;
    const at = nudgeIntoArea({ x: d.pinned.x, y: d.pinned.y, w, h }, sheet, packingMarginMm(), marks);
    if (at.x !== d.pinned.x || at.y !== d.pinned.y) {
      d.pinned = at;
      moved++;
    }
  }
  return moved;
}

/**
 * Lays the current designs out on the current sheet and resolves each placement to a renderable
 * SheetItem. Pinned stickers stay where they are; the rest are packed into the space around them.
 */
function computeSheetItems(sheet: SheetSize): { placements: MixedPlacement[]; items: SheetItem[] } {
  fitPinnedToSheet(sheet);
  const ready = state.designs.filter((d) => d.design);
  const pinned = ready.filter((d) => d.pinned);
  const mixedItems = ready.filter((d) => !d.pinned).map((d) => ({ id: d.id, widthMm: d.design!.actualWmm, heightMm: d.design!.actualHmm }));
  // Registration marks only occupy small squares at their corners, not a full-width/height band —
  // route packing around just those squares rather than shrinking the whole usable area from
  // every edge (see getRegmarkKeepoutRects).
  const keepouts = state.regmarksEnabled ? getRegmarkKeepoutRects(sheet.widthMm, sheet.heightMm, state.regmarkStyle === "four_corner") : [];
  for (const d of pinned) keepouts.push(stickerKeepout(pinnedRect(d), state.gapMm));
  const placements: MixedPlacement[] = [
    ...pinned.map((d) => ({ id: d.id, x: d.pinned!.x, y: d.pinned!.y, rotated: false })),
    ...packMixedSheet(sheet, mixedItems, state.gapMm, packingMarginMm(), state.fillMode, keepouts, state.allowRotation),
  ];
  return { placements, items: sheetItemsFor(placements) };
}

/** Problems with where pinned stickers sit, for the sheet summary; "" when there are none. */
function pinnedWarning(sheet: SheetSize): string {
  const pinned = state.designs.filter((d) => d.design && d.pinned).map(pinnedRect);
  const offSheet = pinned.filter((r) => r.x < 0 || r.y < 0 || r.x + r.w > sheet.widthMm || r.y + r.h > sheet.heightMm).length;
  const marks = state.regmarksEnabled ? getRegmarkKeepoutRects(sheet.widthMm, sheet.heightMm, state.regmarkStyle === "four_corner") : [];
  const onMarks = pinned.filter((r) => marks.some((m) => rectsOverlap(r, m))).length;
  const parts: string[] = [];
  if (offSheet > 0) parts.push(`${offSheet} off the sheet`);
  if (onMarks > 0) parts.push(`${onMarks} too close to a registration mark — drag ${onMarks === 1 ? "it" : "them"} clear`);
  return parts.join(", ");
}

/** Traces the sticker's artwork at its current size, or resizes the outline it was imported with. */
function buildDesign(d: StickerDesign, aspectLocked = d.aspectLocked, driveBy = d.driveBy): DesignResult {
  if (d.imported && !d.imported.traced) return scaleDesign(d.imported.base, d.widthMm, d.heightMm, aspectLocked, driveBy);
  return computeDesign(d.raw!, d.widthMm, d.heightMm, d.marginMm, aspectLocked, driveBy, d.preserveSharpCorners);
}

// ---- core recompute ----
function recompute() {
  for (const d of state.designs) {
    d.design = buildDesign(d);
    // Keep the stored target in sync with what was actually achieved, so the next edit (a drag,
    // another text-box change) starts from reality instead of a stale/approximate guess.
    d.widthMm = d.design.actualWmm;
    d.heightMm = d.design.actualHmm;
  }
  render();
}

// ---- rendering ----
function render() {
  // paper/sheet/margin/gap/fillMode control mirrors
  syncSelectionControls();
  gapValue.textContent = state.gapMm.toFixed(1);
  const ca = currentColorAdjust();
  for (const k of COLOR_ADJUST_KEYS) {
    colorSliders[k].value = String(ca[k]);
    colorValues[k].textContent = ca[k] > 0 && k !== "paleTints" ? `+${ca[k]}` : String(ca[k]);
  }
  colorAdjustNote.textContent = state.colorAdjust ? "(custom)" : "(Paper Type default)";
  colorAdjustResetBtn.disabled = state.colorAdjust === null;
  sheetSelect.value = String(state.sheetIndex);
  fillModeToggle.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", (b as HTMLButtonElement).dataset.mode === state.fillMode);
  });
  rotateToggle.checked = state.allowRotation;
  regmarksToggle.checked = state.regmarksEnabled;
  laminatedToggle.checked = isLaminated();
  renderMarksTip();
  regmarkStyleToggle.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", (b as HTMLButtonElement).dataset.style === state.regmarkStyle);
  });

  const hasImages = state.designs.length > 0;
  dropzone.style.display = hasImages ? "none" : "flex";
  imageBlock.hidden = !hasImages;
  sizeBlock.hidden = !hasImages;
  zoomControls.hidden = !hasImages;
  thumbStrip.hidden = state.designs.length < 1;
  removeImageBtn.disabled = !hasImages;

  const sel = selectedDesign();
  renderThumbStrip();

  const sheet = currentSheet();
  const { placements, items } = computeSheetItems(sheet);
  state.lastPlacements = placements;
  sheetCountBadge.textContent = String(placements.length);

  downloadSvgBtn.disabled = !hasImages;
  printBtn.disabled = !hasImages;
  renderStudio3();
  renderCutter();

  if (!hasImages) {
    summaryEl.textContent = "Upload an image to begin";
    viewportInner.innerHTML = "";
    overlayLayer.innerHTML = "";
    return;
  }

  if (state.activeTab === "design" && sel && sel.design) {
    if (state.needsRefit) refitCamera(sel.design.actualWmm, sel.design.actualHmm);
    const opts = renderOptionsFor(sel);
    viewportInner.innerHTML = toScreenSVG(buildSingleStickerSVG(sel.design, opts));
    applyCameraTransform();
    renderOverlay(sel);
    summaryEl.textContent = `${fmtIn(sel.design.actualWmm)} × ${fmtIn(sel.design.actualHmm)} in`;
  } else if (state.activeTab === "sheet") {
    if (state.needsRefit) refitCamera(sheet.widthMm, sheet.heightMm);
    viewportInner.innerHTML = toScreenSVG(buildSheetSVG(items, sheet, currentRegmarkStyle()));
    applyCameraTransform();
    if (state.editingSelected && sel) {
      // A repack can reorder the copies, so stay on the one nearest where the selection was.
      const prev = state.editingPlacementXY;
      const distSq = (p: MixedPlacement) => (prev ? (p.x - prev.x) ** 2 + (p.y - prev.y) ** 2 : 0);
      const match = placements.filter((p) => p.id === sel.id).sort((a, b) => distSq(a) - distSq(b))[0];
      if (match) {
        state.editingPlacementXY = { x: match.x, y: match.y, rotated: match.rotated };
        renderOverlay(sel);
      } else {
        state.editingSelected = false;
        overlayLayer.innerHTML = "";
        renderAlsoSelectedOutlines();
      }
    } else {
      overlayLayer.innerHTML = "";
      renderAlsoSelectedOutlines();
    }
    const warning = pinnedWarning(sheet);
    summaryEl.textContent = `${placements.length} pcs on ${sheet.name}${warning ? ` · ${warning}` : ""}`;
  }
}

/** The value every item shares, or null when they differ (or there are none). */
function shared<T>(items: StickerDesign[], value: (d: StickerDesign) => T, same: (a: T, b: T) => boolean = (a, b) => a === b): T | null {
  if (items.length === 0) return null;
  const first = value(items[0]);
  return items.every((d) => same(value(d), first)) ? first : null;
}

/** Whether an imported sticker's artwork has nothing to trace, so it keeps its file's outline. */
function isUntraceable(d: StickerDesign): boolean {
  return !!d.imported && !d.raw;
}

/** The side-panel fields that follow the selection: its name, size and margin (shared, or blank when they differ). */
function syncSelectionControls() {
  const sel = selectedDesign();
  const all = selectedDesigns();
  const many = all.length > 1;
  fileNameEl.textContent = many ? `${all.length} stickers selected` : sel ? sel.fileName : "—";
  removeImageBtn.textContent = many ? `Remove ${all.length}` : "Remove";
  syncSizeInputs(sel);

  // An imported sticker keeps the outline it came with until its margin is changed; artwork with
  // neither a transparent nor a plain background has nothing to trace, so it always keeps it.
  const traceable = all.filter((d) => !isUntraceable(d));
  const margin = all.length ? shared(traceable.length ? traceable : all, (d) => d.marginMm) : state.marginMm;
  if (document.activeElement !== marginInput) marginInput.value = margin === null ? "" : margin.toFixed(1);
  marginInput.placeholder = margin === null ? "mixed" : "";
  marginSlider.value = String(margin ?? sel?.marginMm ?? state.marginMm);
  const sharp = all.length ? shared(all, (d) => d.preserveSharpCorners) : state.preserveSharpCorners;
  sharpCornersToggle.checked = sharp ?? false;
  sharpCornersToggle.indeterminate = sharp === null;
  const untraceable = all.length > 0 && traceable.length === 0;
  marginInput.disabled = marginSlider.disabled = sharpCornersToggle.disabled = untraceable;
  const locked = all.length - traceable.length;
  marginForEl.textContent = many
    ? `for ${all.length} stickers${locked > 0 ? ` (${locked === 1 ? "1 keeps the outline from its" : `${locked} keep the outlines from their`} .studio3 file: nothing to trace)` : ""}`
    : untraceable
      ? "— this sticker keeps the outline from its .studio3 file: its artwork has no transparent or plain background to trace around"
      : sel?.imported && !sel.imported.traced
        ? "— changing it re-traces this sticker's outline from its artwork"
        : sel && state.designs.length > 1
          ? `for ${sel.fileName}`
          : "";
}

/**
 * Foil and film stocks: one short line under Print saying how to make the marks readable before
 * the sheet is printed, which opens to the reason. Kept to a line because the bottom bar is pinned
 * under the side panel: a tall one leaves no room to reach the panel's controls.
 */
function renderMarksTip() {
  const tip = state.regmarksEnabled ? currentPaperType().marksTip : undefined;
  marksTipEl.hidden = !tip;
  if (!tip || marksTipEl.dataset.summary === tip.summary) return; // rebuilt only when it changes, so an opened one stays open
  marksTipEl.dataset.summary = tip.summary;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = tip.summary;
  const detail = document.createElement("div");
  detail.textContent = tip.detail;
  details.append(summary, detail);
  marksTipEl.replaceChildren(details);
}

function renderStudio3() {
  exportStudio3Btn.disabled = state.lastPlacements.length === 0;
  exportStudio3Btn.title = state.studio3
    ? `Save ${state.studio3.fileName} with the stickers on the sheet as they are now`
    : "Save the sheet as a Silhouette Studio file";
  studio3StatusEl.hidden = !state.studio3Status;
  studio3StatusEl.textContent = state.studio3Status?.text ?? "";
  studio3StatusEl.classList.toggle("cutter-error", !!state.studio3Status?.error);
}

function renderThumbStrip() {
  thumbStrip.innerHTML = "";
  state.designs.forEach((d) => {
    const thumb = document.createElement("div");
    const selected = d.id === state.selectedDesignId || state.alsoSelectedIds.includes(d.id);
    thumb.className = "thumb" + (selected ? " active" : "");
    thumb.title = "Click to select; ⌘, Ctrl or ⇧-click to select several";
    thumb.style.backgroundImage = `url(${d.imageDataUrl})`;
    thumb.addEventListener("click", (e) => {
      if (isAddToSelection(e)) {
        toggleSelected(d.id);
        if (state.activeTab === "sheet") {
          state.editingSelected = true;
          state.editingPlacementXY = firstPlacementOf(state.selectedDesignId);
        }
      } else {
        selectOnly(d.id);
        state.editingSelected = false;
        state.needsRefit = true;
      }
      render();
    });
    const removeBtn = document.createElement("button");
    removeBtn.className = "thumb-remove";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeDesign(d.id);
    });
    thumb.appendChild(removeBtn);
    thumbStrip.appendChild(thumb);
  });

  const addTile = document.createElement("button");
  addTile.className = "thumb thumb-add";
  addTile.title = "Add more stickers";
  addTile.textContent = "+";
  addTile.addEventListener("click", () => fileInput.click());
  thumbStrip.appendChild(addTile);
}

// ---- size fields (width/height text boxes + aspect lock) ----
function syncSizeInputs(design: StickerDesign | null) {
  if (!design || !design.design) return;
  // With several selected, a field shows the size they share (to the hundredth of an inch shown), or is blank.
  const all = selectedDesigns().filter((d) => d.design);
  const inches = (mm: number) => mmToIn(mm).toFixed(2);
  const w = shared(all, (d) => inches(d.design!.actualWmm));
  const h = shared(all, (d) => inches(d.design!.actualHmm));
  // Don't stomp on whichever field the user is actively typing into.
  if (document.activeElement !== widthInput) widthInput.value = w ?? "";
  if (document.activeElement !== heightInput) heightInput.value = h ?? "";
  widthInput.placeholder = w === null ? "mixed" : "";
  heightInput.placeholder = h === null ? "mixed" : "";
  lockAspectBtn.setAttribute("aria-pressed", String(design.aspectLocked));
  lockIconClosed.toggleAttribute("hidden", !design.aspectLocked);
  lockIconOpen.toggleAttribute("hidden", design.aspectLocked);
}

// Size applies to every selected sticker: each gets the width (or height) typed, and keeps its own shape if locked.
widthInput.addEventListener("input", () => {
  const all = selectedDesigns();
  if (all.length === 0) return;
  const v = parseFloat(widthInput.value);
  if (!Number.isFinite(v) || v <= 0) return;
  for (const design of all) {
    design.widthMm = clamp(inToMm(v), MIN_SIZE_MM, maxStickerDimMm());
    design.driveBy = "width"; // hit width exactly; height (if locked) follows the true geometry
  }
  recompute();
});

heightInput.addEventListener("input", () => {
  const all = selectedDesigns();
  if (all.length === 0) return;
  const v = parseFloat(heightInput.value);
  if (!Number.isFinite(v) || v <= 0) return;
  for (const design of all) {
    design.heightMm = clamp(inToMm(v), MIN_SIZE_MM, maxStickerDimMm());
    design.driveBy = "height"; // hit height exactly; width (if locked) follows the true geometry
  }
  recompute();
});

lockAspectBtn.addEventListener("click", () => {
  const main = selectedDesign();
  if (!main) return;
  const locked = !main.aspectLocked;
  for (const design of selectedDesigns()) {
    design.aspectLocked = locked;
    // Re-locking: hold width fixed and let height snap back to the true proportional geometry.
    if (locked) design.driveBy = "width";
  }
  if (locked) recompute();
  else render();
});

// ---- camera / pan / zoom ----
function refitCamera(contentWmm: number, contentHmm: number) {
  const rect = previewHost.getBoundingClientRect();
  state.camera = fitCamera(rect.width, rect.height, contentWmm, contentHmm);
  state.fitScale = state.camera.scale;
  state.needsRefit = false;
}

function applyCameraTransform() {
  const cam = state.camera;
  viewportInner.style.transform = `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.scale})`;
}

function zoomStep(factor: number, atX?: number, atY?: number) {
  const rect = previewHost.getBoundingClientRect();
  const cx = atX ?? rect.width / 2;
  const cy = atY ?? rect.height / 2;
  state.camera = zoomAt(state.camera, cx, cy, factor, state.fitScale * 0.25, state.fitScale * 4);
  applyCameraTransform();
  repositionOverlay();
}

previewHost.addEventListener("wheel", (e) => {
  if (state.designs.length === 0) return;
  e.preventDefault();
  const rect = previewHost.getBoundingClientRect();
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomStep(factor, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

zoomInBtn.addEventListener("click", () => zoomStep(1.25));
zoomOutBtn.addEventListener("click", () => zoomStep(0.8));
zoomFitBtn.addEventListener("click", () => {
  state.needsRefit = true;
  render();
});

window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === "+" || e.key === "=") zoomStep(1.25);
  else if (e.key === "-" || e.key === "_") zoomStep(0.8);
  else if (e.key === "0") {
    state.needsRefit = true;
    render();
  } else if ((e.key === "Delete" || e.key === "Backspace") && state.editingSelected && state.selectedDesignId) {
    e.preventDefault();
    const ids = selectedDesigns().map((d) => d.id);
    if (ids.length > 1 && !confirm(`Remove the ${ids.length} selected stickers?`)) return;
    removeDesigns(ids);
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && state.designs.length > 0) {
    e.preventDefault();
    selectAll();
    render();
  } else if (e.key === "Escape" && state.alsoSelectedIds.length > 0) {
    state.alsoSelectedIds = [];
    render();
  }
});

window.addEventListener("resize", () => {
  state.needsRefit = true;
  render();
});

// ---- pan + select + drag-resize (pointer handling on the preview host) ----
let panPointerId: number | null = null;
let panLast = { x: 0, y: 0 };

function hitTestPlacement(mmX: number, mmY: number): MixedPlacement | null {
  for (const p of state.lastPlacements) {
    const d = state.designs.find((dd) => dd.id === p.id);
    if (!d || !d.design) continue;
    const w = p.rotated ? d.design.actualHmm : d.design.actualWmm;
    const h = p.rotated ? d.design.actualWmm : d.design.actualHmm;
    if (mmX >= p.x && mmX <= p.x + w && mmY >= p.y && mmY <= p.y + h) {
      return p;
    }
  }
  return null;
}

previewHost.addEventListener("pointerdown", (e) => {
  if (state.designs.length === 0) return;
  const target = e.target as HTMLElement;
  if (target.closest(".resize-handle") || target.closest(".dim-readout") || target.closest(".delete-btn")) return; // handled elsewhere

  const rect = previewHost.getBoundingClientRect();

  if (state.activeTab === "design") {
    const svgEl = viewportInner.querySelector("svg");
    if (svgEl && svgEl.contains(target)) {
      state.editingSelected = true;
      renderOverlay(selectedDesign());
      return;
    }
  } else {
    const [mmX, mmY] = screenToMm(state.camera, e.clientX - rect.left, e.clientY - rect.top);
    const hit = hitTestPlacement(mmX, mmY);
    if (hit) {
      const adding = isAddToSelection(e);
      if (adding) toggleSelected(hit.id);
      else if (hit.id !== state.selectedDesignId || state.alsoSelectedIds.length > 0) selectOnly(hit.id);
      state.editingSelected = true;
      state.editingPlacementXY = state.selectedDesignId === hit.id ? { x: hit.x, y: hit.y, rotated: hit.rotated } : firstPlacementOf(state.selectedDesignId);
      const sel = selectedDesign();
      syncSelectionControls();
      renderOverlay(sel);
      renderThumbStrip();
      if (!adding && sel?.pinned) startMove(e, sel);
      return;
    }
  }

  // background click/drag: deselect + pan
  if (state.editingSelected) {
    state.editingSelected = false;
    overlayLayer.innerHTML = "";
  }
  panPointerId = e.pointerId;
  panLast = { x: e.clientX, y: e.clientY };
  previewHost.classList.add("panning");
  previewHost.setPointerCapture(e.pointerId);
});

previewHost.addEventListener("pointermove", (e) => {
  if (panPointerId !== e.pointerId) return;
  const dx = e.clientX - panLast.x;
  const dy = e.clientY - panLast.y;
  panLast = { x: e.clientX, y: e.clientY };
  state.camera = panBy(state.camera, dx, dy);
  applyCameraTransform();
  repositionOverlay();
});

function endPan(e: PointerEvent) {
  if (panPointerId !== e.pointerId) return;
  panPointerId = null;
  previewHost.classList.remove("panning");
}
previewHost.addEventListener("pointerup", endPan);
previewHost.addEventListener("pointercancel", endPan);

// ---- selection overlay: outline + corner handles + dimension readout ----
const HANDLE_DEFS = [
  { cls: "nw", corner: [0, 0] as [number, number], anchor: [1, 1] as [number, number] },
  { cls: "ne", corner: [1, 0] as [number, number], anchor: [0, 1] as [number, number] },
  { cls: "se", corner: [1, 1] as [number, number], anchor: [0, 0] as [number, number] },
  { cls: "sw", corner: [0, 1] as [number, number], anchor: [1, 0] as [number, number] },
];

function renderOverlay(design: StickerDesign | null) {
  overlayLayer.innerHTML = "";
  renderAlsoSelectedOutlines();
  if (!design || !design.design) return;
  if (!state.editingSelected) return;
  if (state.activeTab === "sheet" && !state.editingPlacementXY) return;

  const offset = state.activeTab === "sheet" ? state.editingPlacementXY! : { x: 0, y: 0, rotated: false };
  const w = offset.rotated ? design.design.actualHmm : design.design.actualWmm;
  const h = offset.rotated ? design.design.actualWmm : design.design.actualHmm;
  const [x0, y0] = mmToScreen(state.camera, offset.x, offset.y);
  const [x1, y1] = mmToScreen(state.camera, offset.x + w, offset.y + h);

  const outline = document.createElement("div");
  outline.className = "selection-outline";
  outline.style.left = `${x0}px`;
  outline.style.top = `${y0}px`;
  outline.style.width = `${x1 - x0}px`;
  outline.style.height = `${y1 - y0}px`;
  overlayLayer.appendChild(outline);

  HANDLE_DEFS.forEach((hd) => {
    const hx = hd.corner[0] === 0 ? x0 : x1;
    const hy = hd.corner[1] === 0 ? y0 : y1;
    const handle = document.createElement("div");
    handle.className = `resize-handle ${hd.cls}`;
    handle.style.left = `${hx}px`;
    handle.style.top = `${hy}px`;
    handle.addEventListener("pointerdown", (e) => startResize(e, design, hd));
    overlayLayer.appendChild(handle);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete-btn";
  deleteBtn.title = "Delete this sticker (or press Delete)";
  deleteBtn.textContent = "×";
  deleteBtn.style.left = `${x1}px`;
  deleteBtn.style.top = `${y0}px`;
  deleteBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  deleteBtn.addEventListener("click", () => removeDesign(design.id));
  overlayLayer.appendChild(deleteBtn);

  renderDimReadout(design, (x0 + x1) / 2, y1);
}

/** A dashed outline on the sheet around every copy of each sticker selected along with the main one. */
function renderAlsoSelectedOutlines() {
  if (state.activeTab !== "sheet" || state.alsoSelectedIds.length === 0) return;
  for (const p of state.lastPlacements) {
    if (!state.alsoSelectedIds.includes(p.id)) continue;
    const d = state.designs.find((dd) => dd.id === p.id);
    if (!d?.design) continue;
    const w = p.rotated ? d.design.actualHmm : d.design.actualWmm;
    const h = p.rotated ? d.design.actualWmm : d.design.actualHmm;
    const [x0, y0] = mmToScreen(state.camera, p.x, p.y);
    const [x1, y1] = mmToScreen(state.camera, p.x + w, p.y + h);
    const outline = document.createElement("div");
    outline.className = "selection-outline also-selected";
    outline.style.left = `${x0}px`;
    outline.style.top = `${y0}px`;
    outline.style.width = `${x1 - x0}px`;
    outline.style.height = `${y1 - y0}px`;
    overlayLayer.appendChild(outline);
  }
}

function renderDimReadout(design: StickerDesign, screenX: number, screenY: number) {
  const existing = overlayLayer.querySelector(".dim-readout");
  if (existing) existing.remove();

  const rect = previewHost.getBoundingClientRect();
  const clampedX = clamp(screenX, 60, rect.width - 60);

  const pill = document.createElement("div");
  pill.className = "dim-readout";
  pill.style.left = `${clampedX}px`;
  pill.style.top = `${screenY}px`;

  // Show the size actually achieved (post exact-fit correction), matching the bottom summary,
  // not the raw target — they can differ slightly once the aspect-preserving fit is applied.
  const wIn = mmToIn(design.design?.actualWmm ?? design.widthMm);
  const hIn = mmToIn(design.design?.actualHmm ?? design.heightMm);
  pill.textContent = `${wIn.toFixed(2)} × ${hIn.toFixed(2)} in`;

  pill.addEventListener("pointerdown", (e) => e.stopPropagation());
  pill.addEventListener("click", () => {
    pill.innerHTML = "";
    const wInput = document.createElement("input");
    wInput.type = "number";
    wInput.min = "0.25";
    wInput.step = "0.05";
    wInput.value = wIn.toFixed(2);
    pill.appendChild(wInput);
    pill.append(" × ");
    const hSpan = document.createElement("span");
    hSpan.textContent = hIn.toFixed(2);
    pill.appendChild(hSpan);
    pill.append(" in");
    wInput.focus();
    wInput.select();

    function commit() {
      const v = parseFloat(wInput.value);
      if (Number.isFinite(v) && v > 0) {
        design.widthMm = clamp(inToMm(v), MIN_SIZE_MM, maxStickerDimMm());
        design.driveBy = "width";
        recompute();
        state.editingSelected = true;
        renderOverlay(design);
      }
    }
    wInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") {
        state.editingSelected = true;
        renderOverlay(design);
      }
    });
    wInput.addEventListener("blur", commit);
  });

  overlayLayer.appendChild(pill);
}

function repositionOverlay() {
  if (!state.editingSelected) return;
  renderOverlay(selectedDesign());
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---- corner-drag resize ----
function startResize(e: PointerEvent, design: StickerDesign, hd: (typeof HANDLE_DEFS)[number]) {
  e.stopPropagation();
  e.preventDefault();
  if (!design.design) return;

  const offset = state.activeTab === "sheet" ? state.editingPlacementXY! : { x: 0, y: 0, rotated: false };
  const w0 = offset.rotated ? design.design.actualHmm : design.design.actualWmm;
  const h0 = offset.rotated ? design.design.actualWmm : design.design.actualHmm;
  const anchorMm: [number, number] = [offset.x + hd.anchor[0] * w0, offset.y + hd.anchor[1] * h0];
  const originalCornerMm: [number, number] = [offset.x + hd.corner[0] * w0, offset.y + hd.corner[1] * h0];
  const originalDist = Math.hypot(originalCornerMm[0] - anchorMm[0], originalCornerMm[1] - anchorMm[1]);
  const widthAtStart = design.widthMm;
  const heightAtStart = design.heightMm;
  const rect = previewHost.getBoundingClientRect();
  const sheetAtStart = currentSheet();

  function onMove(ev: PointerEvent) {
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const [mmX, mmY] = screenToMm(state.camera, sx, sy);
    const dist = Math.hypot(mmX - anchorMm[0], mmY - anchorMm[1]);
    const factor = originalDist > 0 ? dist / originalDist : 1;

    const maxMm = maxStickerDimMm();
    let newW = widthAtStart * factor;
    let newH = heightAtStart * factor;
    const dominant = Math.max(newW, newH);
    if (dominant > maxMm) {
      const clampFactor = maxMm / dominant;
      newW *= clampFactor;
      newH *= clampFactor;
    }
    if (Math.min(newW, newH) < MIN_SIZE_MM) {
      const upFactor = MIN_SIZE_MM / Math.min(newW, newH);
      newW *= upFactor;
      newH *= upFactor;
    }

    design.widthMm = newW;
    design.heightMm = newH;
    design.design = buildDesign(design, true, "width");
    if (design.pinned && state.activeTab === "sheet") {
      // Nothing repacks a pinned sticker, so the corner opposite the handle is held where it is.
      movePinned(design, anchorMm[0] - hd.anchor[0] * design.design.actualWmm, anchorMm[1] - hd.anchor[1] * design.design.actualHmm);
    }

    // Live feedback: redraw in place without re-packing the sheet (positions would otherwise
    // jump around mid-drag as siblings reflow) — the real repack happens once on release.
    if (state.activeTab === "design") {
      viewportInner.innerHTML = toScreenSVG(buildSingleStickerSVG(design.design, renderOptionsFor(design)));
    } else {
      viewportInner.innerHTML = toScreenSVG(buildSheetSVG(sheetItemsFor(state.lastPlacements), sheetAtStart, currentRegmarkStyle()));
    }
    applyCameraTransform();
    renderOverlay(design);
  }

  function onUp(ev: PointerEvent) {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    (ev.target as Element)?.releasePointerCapture?.(ev.pointerId);
    recompute(); // re-packs the sheet (if applicable) and re-renders + re-anchors the overlay
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// ---- drag a pinned sticker around the sheet ----
/** Moves a pinned sticker, keeping the sheet's current layout and the selection overlay in step. */
function movePinned(design: StickerDesign, x: number, y: number) {
  design.pinned = { x, y };
  const placement = state.lastPlacements.find((p) => p.id === design.id);
  if (placement) {
    placement.x = x;
    placement.y = y;
  }
  if (state.selectedDesignId === design.id && state.editingPlacementXY) state.editingPlacementXY = { x, y, rotated: false };
}

function startMove(e: PointerEvent, design: StickerDesign) {
  if (!design.pinned || !design.design) return;
  e.preventDefault();
  const index = state.lastPlacements.findIndex((p) => p.id === design.id);
  const rect = previewHost.getBoundingClientRect();
  const sheet = currentSheet();
  const [startX, startY] = screenToMm(state.camera, e.clientX - rect.left, e.clientY - rect.top);
  const from = design.pinned;
  // Inside the area the cutter can reach: the same limit fitPinnedToSheet puts it back within.
  const margin = packingMarginMm();
  const maxX = Math.max(margin, sheet.widthMm - margin - design.design.actualWmm);
  const maxY = Math.max(margin, sheet.heightMm - margin - design.design.actualHmm);
  let moved = false;

  function onMove(ev: PointerEvent) {
    const [mmX, mmY] = screenToMm(state.camera, ev.clientX - rect.left, ev.clientY - rect.top);
    const x = clamp(from.x + mmX - startX, margin, maxX);
    const y = clamp(from.y + mmY - startY, margin, maxY);
    movePinned(design, x, y);
    moved = true;
    // Live feedback: slide the drawn sticker along instead of rebuilding the sheet on every
    // move; the real redraw (and repack of anything around it) happens once on release.
    const shift = `translate(${x - from.x} ${y - from.y})`;
    viewportInner.querySelector(`#art-${index}`)?.setAttribute("transform", shift);
    viewportInner.querySelector(`#cut-${index}`)?.setAttribute("transform", shift);
    renderOverlay(design);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (moved) render();
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

// ---- Silhouette Studio files ----
/** The artwork of an imported shape: a 1 px transparent image, so only its cut outline shows. */
const NO_ARTWORK =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

function isStudio3File(file: File): boolean {
  return /\.studio3$/i.test(file.name);
}

let customSheetIndex = -1; // the one "Custom" entry, which each imported odd-sized page reuses

/** The paper size matching a page, or the "Custom" entry set to its size if it isn't one of the standard ones. */
function sheetIndexFor(widthMm: number, heightMm: number): number {
  const found = SHEET_SIZES.findIndex((s, i) => i !== customSheetIndex && Math.abs(s.widthMm - widthMm) < 0.5 && Math.abs(s.heightMm - heightMm) < 0.5);
  if (found >= 0) return found;
  const custom: SheetSize = { name: "Custom", widthMm, heightMm };
  if (customSheetIndex < 0) {
    customSheetIndex = SHEET_SIZES.push(custom) - 1;
    addSheetOption(custom, customSheetIndex);
  } else {
    SHEET_SIZES[customSheetIndex] = custom;
    const opt = sheetSelect.querySelector(`option[value="${customSheetIndex}"]`);
    if (opt) opt.textContent = sheetLabel(custom);
  }
  return customSheetIndex;
}

/**
 * Replaces the sheet with the stickers of a Silhouette Studio file, each one pinned where the
 * file has it and keeping the file's outline. Returns whether anything was imported.
 */
async function importStudio3(file: File): Promise<boolean> {
  let doc: Studio3Document;
  try {
    doc = parseStudio3(new Uint8Array(await file.arrayBuffer()));
    if (doc.stickers.length === 0) throw new Error("no stickers (artwork with a cut outline) were found in it.");
  } catch (e) {
    state.studio3Status = { text: `Couldn't import ${file.name}: ${errorText(e)}`, error: true };
    renderStudio3();
    return false;
  }
  if (state.designs.length > 0 && !confirm(`Importing ${file.name} replaces the stickers on the current sheet. Continue?`)) return false;

  const imageUrls = new Map<string, string>();
  const masks = new Map<string, ArtworkMask | null>();
  try {
    for (const { imageId, artwork } of doc.stickers) {
      if (!artwork || imageUrls.has(imageId)) continue;
      const image = doc.images.get(imageId)!;
      // A plain page around the artwork is made transparent, so the paper shows around it.
      const prepared = await prepareImportedArtwork(await readAsDataURL(new Blob([image.bytes.slice()], { type: image.mime })));
      imageUrls.set(imageId, prepared.imageDataUrl);
      masks.set(imageId, prepared.mask);
    }
  } catch (e) {
    state.studio3Status = { text: `Couldn't import ${file.name}: ${errorText(e)}`, error: true };
    renderStudio3();
    return false;
  }

  const label = file.name.replace(/\.studio3$/i, "");
  state.designs = doc.stickers.map((s, i) => {
    const { minX, minY, maxX, maxY } = s.bbox;
    const base: DesignResult = {
      cutContoursMM: translateContours(s.contours, -minX, -minY),
      imagePlacementMM: { x: s.imageRect.x - minX, y: s.imageRect.y - minY, width: s.imageRect.width, height: s.imageRect.height },
      actualWmm: maxX - minX,
      actualHmm: maxY - minY,
    };
    const mask = s.artwork ? masks.get(s.imageId) ?? null : null;
    return {
      id: uid(),
      fileName: s.artwork ? `${label} #${i + 1}` : `${label} shape #${i + 1}`,
      imageDataUrl: s.artwork ? imageUrls.get(s.imageId)! : NO_ARTWORK,
      raw: mask?.raw ?? null,
      artworkAspect: s.imageRect.width / s.imageRect.height,
      widthMm: base.actualWmm,
      heightMm: base.actualHmm,
      aspectLocked: true,
      driveBy: "width",
      marginMm: state.marginMm,
      preserveSharpCorners: state.preserveSharpCorners,
      design: null,
      imported: { base, studio3Index: i, artWidthMm: mask ? mask.artWidthFraction * s.imageRect.width : null, traced: false },
      pinned: { x: minX, y: minY },
    };
  });
  state.studio3 = { doc, fileName: file.name };
  selectOnly(state.designs[0].id);
  state.editingPlacementXY = null;
  if (doc.pageWidthMm && doc.pageHeightMm) state.sheetIndex = sheetIndexFor(doc.pageWidthMm, doc.pageHeightMm);

  const shapes = doc.stickers.filter((s) => !s.artwork).length;
  const count = doc.stickers.length - shapes;
  let text = `Imported ${count} sticker${count === 1 ? "" : "s"}${shapes > 0 ? ` and ${shapes} shape${shapes === 1 ? "" : "s"}` : ""} from ${file.name}.`;
  const nudged = fitPinnedToSheet(currentSheet());
  if (nudged > 0) {
    text += ` ${nudged} ${nudged === 1 ? "was" : "were"} moved in from the edge or a registration mark so the cutter can reach ${nudged === 1 ? "it" : "them"}.`;
  }
  if (doc.skippedShapes > 0) {
    const n = doc.skippedShapes;
    text += ` ${n} other object${n === 1 ? " was" : "s were"} left out (rotated or mirrored, or artwork it can't show); Export keeps ${n === 1 ? "it" : "them"} in the file.`;
  }
  state.studio3Status = { text, error: false };
  showTab("sheet");
  recompute();
  return true;
}

importStudio3Btn.addEventListener("click", () => studio3Input.click());
studio3Input.addEventListener("change", () => {
  const file = studio3Input.files?.[0];
  studio3Input.value = "";
  if (file) void importStudio3(file);
});

/** The empty Studio document a sheet that didn't come from a file is written into (see studio3.test.ts). */
async function loadStudio3Template(): Promise<Studio3Document> {
  const response = await fetch(studio3TemplateUrl);
  if (!response.ok) throw new Error(`couldn't load the starting file (${response.status})`);
  return parseStudio3(new Uint8Array(await response.arrayBuffer()));
}

/**
 * Saves the sheet as a .studio3 file: the imported file with its stickers moved, resized or
 * deleted as they are now, or the bundled empty document, plus every other sticker on the sheet
 * as a new one with its artwork and traced outline.
 */
async function exportStudio3() {
  const source = state.studio3;
  const sheet = currentSheet();
  const placements: Studio3Placement[] = [];
  const toAdd: { d: StickerDesign; p: MixedPlacement }[] = [];
  const written = new Set<string>();
  for (const p of state.lastPlacements) {
    const d = state.designs.find((dd) => dd.id === p.id);
    if (!d?.design) continue;
    // A sticker from the file is written back into its own record; any other is added, as is
    // one whose outline has been re-traced (its record can only be moved and resized).
    if (source && d.imported && !d.imported.traced && d.pinned && !written.has(d.id)) {
      written.add(d.id);
      placements.push({
        index: d.imported.studio3Index,
        x: d.pinned.x,
        y: d.pinned.y,
        scaleX: d.design.actualWmm / d.imported.base.actualWmm,
        scaleY: d.design.actualHmm / d.imported.base.actualHmm,
      });
    } else toAdd.push({ d, p });
  }

  try {
    // One PNG per sticker and way round, shared by all its copies.
    const adjust = currentColorAdjust();
    const images = new Map<string, Promise<Studio3Image>>();
    const imageFor = (d: StickerDesign, rotated: boolean) => {
      const key = `${d.id}|${rotated}`;
      let image = images.get(key);
      if (!image) {
        const { width, height } = d.design!.imagePlacementMM;
        // Artwork that came from the file goes back as it was: baking the colour adjustment in
        // again would apply it twice to art this app exported, adjusted, in the first place.
        image = renderArtworkPng(d.imageDataUrl, d.imported ? NO_COLOR_ADJUST : adjust, width, height, rotated);
        images.set(key, image);
      }
      return image;
    };
    const add = await Promise.all(
      toAdd.map(async ({ d, p }) => studio3StickerFor(d.design!, p.x, p.y, p.rotated, d.fileName.replace(/\.[^.]+$/, ""), await imageFor(d, p.rotated)))
    );
    const template = toAdd.length > 0 || !source ? await loadStudio3Template() : undefined;
    const doc = source?.doc ?? template!;
    const bytes = writeStudio3(doc, placements, { add, template });
    const name = source ? `${source.fileName.replace(/\.studio3$/i, "")}-edited.studio3` : "stickers-sheet.studio3";
    downloadBlob(new Blob([bytes.slice()], { type: "application/octet-stream" }), name);
    const total = placements.length + add.length;
    let text = `Saved ${name} with ${total} sticker${total === 1 ? "" : "s"}`;
    if (source && add.length > 0) text += `: ${placements.length} from ${source.fileName} and ${add.length} added here`;
    text += ".";
    // The file keeps its own page size (Letter for a new one): Studio's media setting can't be written yet.
    const samePage = doc.pageWidthMm !== null && doc.pageHeightMm !== null && Math.abs(doc.pageWidthMm - sheet.widthMm) < 0.5 && Math.abs(doc.pageHeightMm - sheet.heightMm) < 0.5;
    if (!samePage) text += ` In Silhouette Studio, set Media Size to ${sheet.name} in Page Setup.`;
    if (!source) text += " Tick Enable Registration Marks in Studio's Print & Cut panel before printing.";
    state.studio3Status = { text, error: false };
  } catch (e) {
    console.error(e);
    state.studio3Status = { text: `Couldn't export: ${errorText(e)}`, error: true };
  }
}

exportStudio3Btn.addEventListener("click", () =>
  withBusyButton(exportStudio3Btn, async () => {
    await exportStudio3();
    renderStudio3();
  })
);

// ---- image upload ----
// Each SVG warning is shown once per page load, so it informs without nagging.
let svgImportWarned = false;
let svgDownloadAcknowledged = false;

async function handleFiles(files: FileList | File[]) {
  const list = Array.from(files);
  // A .studio3 that can't be imported (or that the user declines to replace the sheet with) doesn't hold up the images dropped with it.
  const studio3Files = list.filter(isStudio3File);
  if (studio3Files.length > 0) {
    await importStudio3(studio3Files[0]);
    const extra = studio3Files.length - 1;
    if (extra > 0 && state.studio3Status) {
      state.studio3Status.text += ` Only ${studio3Files[0].name} was opened: ${extra} other .studio3 file${extra === 1 ? " was" : "s were"} skipped.`;
      renderStudio3();
    }
  }
  for (const file of list.filter((f) => !isStudio3File(f))) {
    const dataUrl = await readAsDataURL(file);
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const raw = extractAlphaMask(img);
        const bw = raw.rawBBox.maxX - raw.rawBBox.minX;
        const bh = raw.rawBBox.maxY - raw.rawBBox.minY;
        const artworkAspect = bw / bh;
        const widthMm = 50;
        const heightMm = widthMm / artworkAspect;

        const design: StickerDesign = {
          id: uid(),
          fileName: file.name,
          imageDataUrl: dataUrl,
          raw,
          artworkAspect,
          widthMm,
          heightMm,
          aspectLocked: true,
          driveBy: "width",
          marginMm: state.marginMm,
          preserveSharpCorners: state.preserveSharpCorners,
          design: null,
          imported: null,
          pinned: null,
        };
        state.designs.push(design);
        selectOnly(design.id);
        resolve();
      };
      img.src = dataUrl;
    });
  }
  state.needsRefit = true;
  state.editingSelected = false;
  recompute();
  if (!svgImportWarned && list.some((f) => !isStudio3File(f) && isSvgFile(f))) {
    svgImportWarned = true;
    await showAlert({
      title: "SVG artwork added",
      body:
        "The free Basic Edition of Silhouette Studio can't open SVG files, so a sheet downloaded as an SVG needs Silhouette Studio Designer Edition or higher. " +
        "Printing and cutting from Shadow Garage work with any edition.",
      confirmLabel: "Got it",
    });
  }
}

function removeDesign(id: string) {
  removeDesigns([id]);
}

function removeDesigns(ids: string[]) {
  const gone = new Set(ids);
  state.designs = state.designs.filter((d) => !gone.has(d.id));
  state.alsoSelectedIds = state.alsoSelectedIds.filter((x) => !gone.has(x));
  if (state.selectedDesignId && gone.has(state.selectedDesignId)) {
    selectOnly(state.alsoSelectedIds[0] ?? state.designs[0]?.id ?? null);
    state.needsRefit = true;
    state.editingSelected = false;
    state.editingPlacementXY = null;
  }
  recompute();
}

dropzone.addEventListener("click", () => fileInput.click());
addImageBtn.addEventListener("click", () => fileInput.click());
removeImageBtn.addEventListener("click", () => {
  const ids = selectedDesigns().map((d) => d.id);
  if (ids.length > 1 && !confirm(`Remove the ${ids.length} selected stickers?`)) return;
  removeDesigns(ids);
});
selectAllBtn.addEventListener("click", () => {
  selectAll();
  render();
});

/** Selects every sticker, keeping the main selection where it is. */
function selectAll() {
  if (!state.selectedDesignId) state.selectedDesignId = state.designs[0]?.id ?? null;
  state.alsoSelectedIds = state.designs.map((d) => d.id).filter((id) => id !== state.selectedDesignId);
  if (state.activeTab === "sheet") {
    state.editingSelected = true;
    state.editingPlacementXY = firstPlacementOf(state.selectedDesignId);
  }
}
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length > 0) handleFiles(fileInput.files);
  fileInput.value = "";
});

previewHost.addEventListener("dragover", (e) => e.preventDefault());
previewHost.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});

// ---- theme ----
function syncThemeIcons() {
  themeIconMoon.toggleAttribute("hidden", state.theme !== "dark");
  themeIconSun.toggleAttribute("hidden", state.theme !== "light");
}
syncThemeIcons();
themeToggle.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme(state.theme);
  syncThemeIcons();
});

// ---- paper size / margin / gap / fill mode ----
sheetSelect.addEventListener("change", () => {
  state.sheetIndex = parseInt(sheetSelect.value, 10);
  state.needsRefit = state.activeTab === "sheet";
  recompute();
});

/**
 * Switches an imported sticker from the outline in its file to one traced from its artwork, as
 * an upload's is, keeping the artwork the size it was.
 */
function startTracing(d: StickerDesign) {
  if (!d.imported || d.imported.traced || !d.raw || d.imported.artWidthMm === null) return;
  d.imported.traced = true;
  d.widthMm = d.imported.artWidthMm * (d.widthMm / d.imported.base.actualWmm) + 2 * d.marginMm;
  d.driveBy = "width";
}

// Margin and sharp corners apply to every selected sticker, and become the default for new ones.
function setMarginMm(mm: number) {
  state.marginMm = Math.round(mm * 10) / 10; // same 0.1 mm steps as the slider
  for (const d of selectedDesigns()) {
    if (isUntraceable(d)) continue;
    d.marginMm = state.marginMm;
    startTracing(d);
  }
  recompute();
}

marginSlider.addEventListener("input", () => setMarginMm(parseFloat(marginSlider.value)));

marginInput.addEventListener("input", () => {
  const v = parseFloat(marginInput.value);
  if (!Number.isFinite(v) || v <= 0) return;
  setMarginMm(clamp(v, parseFloat(marginSlider.min), parseFloat(marginSlider.max)));
});
// Once typing is done (Enter or leaving the box), show the stored value: clamped, one decimal.
function syncMarginInput() {
  const all = selectedDesigns().filter((d) => !isUntraceable(d));
  const margin = all.length ? shared(all, (d) => d.marginMm) : state.marginMm;
  marginInput.value = margin === null ? "" : margin.toFixed(1);
}
marginInput.addEventListener("change", syncMarginInput);
marginInput.addEventListener("blur", syncMarginInput);

sharpCornersToggle.addEventListener("change", () => {
  state.preserveSharpCorners = sharpCornersToggle.checked;
  for (const d of selectedDesigns()) {
    if (isUntraceable(d)) continue;
    d.preserveSharpCorners = state.preserveSharpCorners;
    startTracing(d);
  }
  recompute();
});

gapInput.addEventListener("input", () => {
  state.gapMm = parseFloat(gapInput.value);
  recompute();
});

fillModeToggle.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button[data-mode]") as HTMLButtonElement | null;
  if (!btn) return;
  state.fillMode = btn.dataset.mode as FillMode;
  recompute();
});

rotateToggle.addEventListener("change", () => {
  state.allowRotation = rotateToggle.checked;
  recompute();
});

regmarksToggle.addEventListener("change", () => {
  state.regmarksEnabled = regmarksToggle.checked;
  recompute();
});

regmarkStyleToggle.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button[data-style]") as HTMLButtonElement | null;
  if (!btn) return;
  state.regmarkStyle = btn.dataset.style as "standard" | "four_corner";
  recompute();
});

// ---- tabs ----
function showTab(tab: Tab) {
  state.activeTab = tab;
  state.needsRefit = true;
  state.editingSelected = false;
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    showTab(tab.dataset.tab as Tab);
    render();
  });
});

// ---- export ----
/**
 * Print/export version of an item: the colour adjustment baked into a high-resolution PNG instead
 * of a live SVG filter, so the printer and other SVG tools get the adjusted pixels at full DPI.
 */
async function bakedItem(item: SheetItem): Promise<SheetItem> {
  const a = item.opts.colorAdjust;
  if (!a || isNoColorAdjust(a)) return item;
  const { width, height } = item.design.imagePlacementMM;
  const imageDataUrl = await bakeColorAdjust(item.opts.imageDataUrl, a, width, height);
  return { ...item, opts: { ...item.opts, imageDataUrl, colorAdjust: undefined } };
}

/**
 * Printed version of an item: its artwork colour-adjusted, cropped to the sticker's box and
 * flattened onto white (see flattenForPrint), so the print job holds no transparency.
 */
async function printItem(item: SheetItem): Promise<SheetItem> {
  const { design, opts } = item;
  const box = { x: 0, y: 0, width: design.actualWmm, height: design.actualHmm };
  const flat = await flattenForPrint(opts.imageDataUrl, opts.colorAdjust, design.imagePlacementMM, box);
  return { ...item, design: { ...design, imagePlacementMM: flat.rect }, opts: { ...opts, imageDataUrl: flat.imageDataUrl, colorAdjust: undefined } };
}

/**
 * Builds the SVG of whatever the active tab shows, with baked colour: for the SVG download, or
 * for printing (`forPrint`), where the artwork is also flattened onto white.
 */
async function buildOutputSVG(includeCutLines: boolean, forPrint = false): Promise<string | null> {
  const sheet = currentSheet();
  const prepare = forPrint ? printItem : bakedItem;
  if (state.activeTab === "design") {
    const sel = selectedDesign();
    if (!sel?.design) return null;
    const item = await prepare({ design: sel.design, x: 0, y: 0, opts: renderOptionsFor(sel) });
    return buildSingleStickerSVG(item.design, item.opts, includeCutLines);
  }
  const { items } = computeSheetItems(sheet);
  return buildSheetSVG(await Promise.all(items.map(prepare)), sheet, currentRegmarkStyle(), includeCutLines);
}

/** Runs a print/export, disabling its button while artwork is being baked (it can take a moment). */
async function withBusyButton(btn: HTMLButtonElement, fn: () => Promise<void>) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    await fn();
  } catch (e) {
    console.error(e);
    alert(`Couldn't prepare the artwork: ${e instanceof Error ? e.message : e}`);
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

function baseName(): string {
  const sel = selectedDesign();
  return (sel?.fileName || "sticker").replace(/\.[^.]+$/, "");
}

downloadSvgBtn.addEventListener("click", () =>
  withBusyButton(downloadSvgBtn, async () => {
    const svg = await buildOutputSVG(true);
    if (!svg) return;
    if (!svgDownloadAcknowledged) {
      // The file is an SVG whatever the artwork is, so this applies to every sheet.
      const go = await showAlert({
        title: "This file won't open in free Silhouette Studio",
        body:
          "The free Basic Edition of Silhouette Studio can't open SVG files. Designer Edition or higher can. " +
          "Printing and cutting from Shadow Garage work with any edition.",
        confirmLabel: "Download anyway",
        cancelLabel: "Cancel",
      });
      if (!go) return;
      svgDownloadAcknowledged = true;
    }
    downloadSvgString(svg, state.activeTab === "design" ? `${baseName()}-cut.svg` : `stickers-sheet.svg`);
  })
);

printBtn.addEventListener("click", () =>
  withBusyButton(printBtn, async () => {
    const svg = await buildOutputSVG(state.printCutLines, true);
    if (svg) await printSvg(svg);
  })
);

printCutLinesToggle.addEventListener("change", () => {
  state.printCutLines = printCutLinesToggle.checked;
});

// ---- cutter ----
const CUT_PHASE_TEXT: Record<CutPhase, string> = {
  waiting: "Checking the cutter…",
  loadMat: "Load the mat into the cutter…",
  homing: "Homing the cutter…",
  setup: "Setting up the blade…",
  manualRegmarks: "Manual registration — position the blade",
  regmarks: "Finding registration marks…",
  cutting: "Cutting…",
  paused: "Paused on the cutter — press Resume or Cancel on its screen",
  finishing: "Finishing…",
  done: "Done — unload the mat",
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function renderCutter() {
  const c = state.cutter;
  const usb = webUsbSupported();
  const bluetooth = BT_SERIAL ? webSerialSupported() : webBluetoothSupported();
  const supported = usb || bluetooth;
  const running = c.job !== null || c.busyOp;
  const link = c.session ? sessionLink(c.session) : preferredLink(usb, bluetooth);

  // Status dot: grey idle, amber connecting, green connected (pulsing while it works), red on error.
  const dotState = c.connecting ? "connecting" : c.session ? (running ? "busy" : "connected") : c.error ? "error" : "off";
  cutterPill.dataset.state = dotState;
  cutterPill.dataset.link = link;
  cutterStatusRow.dataset.state = dotState;
  cutterPillText.textContent = c.connecting ? "Connecting…" : c.session ? c.session.label : "Connect cutter";
  cutterPill.title = c.session ? `${c.session.label} · ${link === "usb" ? "USB" : "Bluetooth"} — click to manage` : "Connect a cutter";

  cutterDialogConnect.hidden = !!c.session;
  cutterDialogConnected.hidden = !c.session;
  cutterDialogConnected.dataset.state = dotState;
  for (const btn of cutterLinkToggle.querySelectorAll<HTMLButtonElement>("button")) {
    const l = btn.dataset.link as CutterLink;
    btn.classList.toggle("active", l === link);
    btn.disabled = c.connecting || !(l === "usb" ? usb : bluetooth);
  }
  cutterDialogConnectBtn.disabled = !supported || c.connecting;
  cutterDialogConnectBtn.textContent = c.connecting ? "Connecting…" : "Connect";
  if (c.session) {
    cutterDeviceName.textContent = c.session.label;
    cutterDeviceDetail.textContent = `${link === "usb" ? "USB" : "Bluetooth"} · firmware ${c.session.firmware}`;
  }
  cutterDialogDisconnectBtn.disabled = running;
  cutterDialogError.hidden = !c.error;
  cutterDialogError.textContent = c.error ?? "";
  cutterDialogHint.textContent = !supported
    ? "Requires Chrome or Edge on desktop."
    : c.session
      ? running
        ? "The cutter is busy — wait for the job to finish before disconnecting."
        : "Load the mat before sending a job."
      : link === "usb"
        ? "Plug the Cameo in and turn it on. Silhouette Cameo 3 or 4 · Requires Chrome or Edge."
        : "Pair the cutter in your computer's Bluetooth settings first, and wake it if it's asleep. Silhouette Cameo 3 or 4 · Requires Chrome or Edge.";

  if (!supported) cutterStatusEl.textContent = "Requires Chrome or Edge on desktop";
  else if (c.connecting) cutterStatusEl.textContent = "Connecting…";
  else if (c.statusText) cutterStatusEl.textContent = c.statusText;
  else if (c.session) cutterStatusEl.textContent = `${c.session.label} · ${link === "usb" ? "USB" : "Bluetooth"} · ${c.session.firmware}`;
  else cutterStatusEl.textContent = "Not connected";

  const m = currentCutMaterial();
  const { speed: defaultSpeed, pressure: defaultPressure, autoBladeDepth: defaultDepth } = defaultCutMaterial();
  cutterMaterialEl.textContent = `Cut settings: ${m.name} (set by Paper Type)`;
  if (c.session) cutSpeedSlider.max = String(c.session.model.speedRange[1]); // keeps the last cutter's range while disconnected
  cutSpeedSlider.value = String(m.speed);
  cutSpeedValue.textContent = String(m.speed);
  cutSpeedDefault.textContent = m.speed === defaultSpeed ? "(Paper Type default)" : `(Paper Type default ${defaultSpeed})`;
  cutSpeedSlider.disabled = running;
  cutPressureSlider.value = String(m.pressure);
  cutPressureValue.textContent = String(m.pressure);
  cutPressureDefault.textContent = m.pressure === defaultPressure ? "(Paper Type default)" : `(Paper Type default ${defaultPressure})`;
  cutPressureSlider.disabled = running;
  cutDepthSlider.value = String(m.autoBladeDepth);
  cutDepthValue.textContent = String(m.autoBladeDepth);
  const depthSource = isLaminated() ? "Paper Type default, laminated" : "Paper Type default";
  cutDepthDefault.textContent = m.autoBladeDepth === defaultDepth ? `(${depthSource})` : `(${depthSource} ${defaultDepth})`;
  cutDepthSlider.disabled = running;

  // Opens the connection dialog, or disconnects whichever link is in use.
  cutterConnectBtn.textContent = c.session ? "Disconnect" : "Connect…";
  cutterConnectBtn.disabled = !supported || c.connecting || running;
  cutterTestBtn.disabled = !c.session || running;
  cutterHomeBtn.hidden = !c.session?.model.homeCommand;
  cutterHomeBtn.disabled = !c.session || running;
  rawBlock.hidden = !CUTTER_DEBUG;
  rawSendBtn.disabled = !c.session || running;
  calCutBtn.disabled = !c.session || running;
  dryRunBtn.disabled = !c.session || running || state.designs.length === 0;
  copyLogBtn.disabled = !c.log;
  manualRegBtn.hidden = !c.manualRetryKind || !c.session || running;

  jogPad.hidden = !c.jog;
  if (c.jog) {
    jogStepBtn.textContent = `${c.jogStepMm} mm`;
    jogPosEl.textContent = `Blade at ${c.jog.jog.x.toFixed(1)}, ${c.jog.jog.y.toFixed(1)} mm from the mat corner`;
  }

  cutterErrorEl.hidden = !c.error;
  cutterErrorEl.textContent = c.error ?? "";

  // While a job runs this is the stop button: bright red with a white ✕, so it can't be missed.
  // (A 🛑 emoji is itself red and all but vanishes on the red button.)
  sendToCutterBtn.textContent = c.job ? "✕  Abort" : "Send to Cutter";
  sendToCutterBtn.classList.toggle("btn-abort", !!c.job);
  sendToCutterBtn.title = c.job ? "Stops sending: the cutter finishes the outline it's cutting. Switch the cutter off to stop it at once." : "";
  sendToCutterBtn.disabled = c.busyOp || (!c.job && (!c.session || state.designs.length === 0));
}

type CutterLink = "usb" | "bluetooth";
const CUTTER_LINK_KEY = "shadow-garage-cutter-link";

function sessionLink(session: CutterSession): CutterLink {
  return session.transport instanceof WebUsbTransport ? "usb" : "bluetooth";
}

// The link picked last time, if this browser still supports it; otherwise whichever one it does.
function preferredLink(usb: boolean, bluetooth: boolean): CutterLink {
  const stored = localStorage.getItem(CUTTER_LINK_KEY);
  if (stored === "usb" && usb) return "usb";
  if (stored === "bluetooth" && bluetooth) return "bluetooth";
  return usb || !bluetooth ? "usb" : "bluetooth";
}

function openCutterDialog() {
  renderCutter();
  cutterDialog.showModal();
}

async function connectCutter(link: CutterLink) {
  const c = state.cutter;
  c.connecting = true;
  c.error = null;
  c.statusText = null;
  renderCutter();
  try {
    // Reuse a cutter this site was already granted, so there's no picker after the first time.
    let session: CutterSession | null = null;
    if (link === "usb") {
      const conn = (await reconnectUsbCutter()) ?? (await requestUsbCutter());
      if (conn) session = await CutterSession.open(conn.transport, withDiagnosticOverrides(conn.model), { onLog: (log) => (c.log = log) });
    } else if (!BT_SERIAL) {
      const transport = (await reconnectBleCutter()) ?? (await requestBleCutter());
      const provisional = provisionalBluetoothModel();
      if (transport && !provisional) await transport.close();
      if (transport && provisional) {
        transport.onLost = () => onBluetoothLost(transport);
        session = await CutterSession.openAndIdentify(
          transport,
          withDiagnosticOverrides(provisional),
          (fw, log) => withDiagnosticOverrides(identifyBluetoothModel(fw, log, transport.deviceName)),
          { onLog: (log) => (c.log = log) }
        );
      }
    } else {
      const params = new URLSearchParams(location.search);
      const serviceOverride = params.get("btService")?.toLowerCase() || null;
      const anyPort = params.has("btAnyPort");
      const conn =
        (anyPort ? null : await reconnectBluetoothCutter({ serviceOverride })) ?? (await requestBluetoothCutter({ serviceOverride, anyPort }));
      if (conn) {
        session = await CutterSession.openAndIdentify(
          conn.transport,
          withDiagnosticOverrides(conn.provisionalModel),
          (fw, log) => withDiagnosticOverrides(identifyBluetoothModel(fw, log)),
          { onLog: (log) => (c.log = log) }
        );
      }
    }
    if (session) {
      c.session = session;
      c.manualRetryKind = null;
      if ((state.cutSpeed ?? 0) > session.model.speedRange[1]) state.cutSpeed = null;
      cutterDialog.close();
    }
  } catch (e) {
    c.error = errorText(e);
  } finally {
    c.connecting = false;
    renderCutter();
  }
}

async function disconnectCutter() {
  const session = state.cutter.session;
  state.cutter.session = null;
  state.cutter.statusText = null;
  renderCutter();
  await session?.close();
}

/**
 * Diagnostic overrides while print-and-cut is being confirmed on hardware, recorded in the log:
 * ?regmarkArgs=width_height|height_width swaps the order of the mark distances in the mark search;
 * ?homeCmd=TT|H|none picks the command that homes the carriage before a job.
 */
// ?scanOffset=<mm> starts the mark search further down the sheet (regmarkScanOffsetMm);
// ?scanMargin=<mm> starts it this far up and left of the top-left mark (regmarkSearchMarginMm);
// ?scanSteps=0,3,5,7 sets the retry positions (regmarkSearchStepsMm).
function withDiagnosticOverrides(model: CutterModel): CutterModel {
  const params = new URLSearchParams(location.search);
  const out = { ...model };
  const order = params.get("regmarkArgs");
  if (order === "width_height" || order === "height_width") out.regmarkArgOrder = order;
  const scanOffset = Number(params.get("scanOffset"));
  if (params.has("scanOffset") && Number.isFinite(scanOffset)) out.regmarkScanOffsetMm = scanOffset;
  const scanMargin = Number(params.get("scanMargin"));
  if (params.has("scanMargin") && Number.isFinite(scanMargin)) out.regmarkSearchMarginMm = scanMargin;
  const steps = params.get("scanSteps")?.split(",").map(Number);
  if (steps && steps.length > 0 && steps.every(Number.isFinite)) out.regmarkSearchStepsMm = steps;
  const home = params.get("homeCmd");
  if (home === "TT" || home === "H") out.homeCommand = home;
  else if (home === "none") out.homeCommand = null;
  return out;
}

/**
 * The whole sheet as laid out in Sheet Preview (what the PDF prints), a test square on a scrap sheet
 * (no marks), or the calibration target (always with marks — it's for checking print-and-cut).
 */
function buildCutJob(session: CutterSession, kind: CutKind): CutJob {
  const material = currentCutMaterial();
  const sheet = currentSheet();
  if (kind === "test") {
    return { label: "test square", paths: testSquarePaths(), ...layoutJob(sheet, session.model, false), material };
  }
  if (kind === "calibration") {
    return { label: "calibration", paths: calibrationPaths(sheet), ...layoutJob(sheet, session.model, state.regmarkStyle), material };
  }
  const layout = layoutJob(sheet, session.model, currentRegmarkStyle());
  const { items } = computeSheetItems(sheet);
  if (items.length === 0) throw new CutJobError("Nothing fits on the sheet to cut.");
  return { label: "sheet", paths: buildCutPaths(items), ...layout, material };
}

/** Shows the jog pad and waits until the user registers (resolve) or cancels (reject). */
function waitForManualRegistration(jog: ManualJog): Promise<void> {
  return new Promise((resolve, reject) => {
    state.cutter.jog = { jog, resolve, reject };
    renderCutter();
  });
}

async function runCutterJob(kind: CutKind, registration: "auto" | "manual" = "auto", dryRun = false) {
  const c = state.cutter;
  const session = c.session;
  if (!session || c.job || c.busyOp) return;
  c.error = null;
  c.manualRetryKind = null;

  let job: CutJob;
  try {
    job = { ...buildCutJob(session, kind), registration, dryRun };
  } catch (e) {
    c.error = errorText(e);
    renderCutter();
    return;
  }

  const controller = new AbortController();
  c.job = controller;
  let phase: CutPhase = "waiting";
  let progress: number | null = null;
  const cuttingText = (f: number) => `${dryRun ? "Tracing, blade up" : "Cutting"}… ${Math.round(f * 100)}%`;
  c.statusText = CUT_PHASE_TEXT[phase];
  renderCutter();
  try {
    await session.run(
      job,
      {
        onPhase: (p) => {
          phase = p;
          // Coming back from a pause on the cutter: keep showing how far the job had got.
          c.statusText = p === "cutting" && progress !== null ? cuttingText(progress) : CUT_PHASE_TEXT[p];
          renderCutter();
        },
        onProgress: (f) => {
          progress = f;
          if (phase !== "cutting") return;
          c.statusText = cuttingText(f);
          renderCutter();
        },
        onManualRegistration: waitForManualRegistration,
        onRegmarkAttempt: (n, of, offset) => {
          c.statusText = n === 1 ? CUT_PHASE_TEXT.regmarks : `Finding registration marks (try ${n} of ${of}, ${offset} mm further down)…`;
          renderCutter();
        },
      },
      controller.signal
    );
  } catch (e) {
    const cancelledOnCutter = e instanceof CutterCancelledError;
    // Abort only stops what hasn't been sent: the cutter finishes the outline it's on (sent one per packet).
    c.statusText = controller.signal.aborted
      ? "Aborted — the cutter finishes the outline it's cutting, then stops. To stop it at once, switch the cutter off."
      : cancelledOnCutter
        ? "Cancelled on the cutter — nothing more was sent"
        : null;
    if (!controller.signal.aborted && !cancelledOnCutter) c.error = errorText(e);
    const marksTip = currentPaperType().marksTip;
    if (e instanceof RegmarkNotFoundError && marksTip) c.error += ` ${marksTip.summary} ${marksTip.detail}`;
    if (e instanceof RegmarkNotFoundError && registration === "auto") {
      c.manualRetryKind = kind;
      c.manualRetryDryRun = dryRun;
    }
  } finally {
    c.job = null;
    c.jog = null;
    renderCutter();
  }
}

function abortCutterJob() {
  const c = state.cutter;
  c.job?.abort();
  c.jog?.reject(new DOMException("Cancelled", "AbortError"));
}

cutterConnectBtn.addEventListener("click", () => {
  if (state.cutter.session) void disconnectCutter();
  else openCutterDialog();
});

cutterPill.addEventListener("click", openCutterDialog);
cutterDialogClose.addEventListener("click", () => cutterDialog.close());
// A click on the backdrop lands on the <dialog> itself; clicks on its contents don't.
cutterDialog.addEventListener("click", (e) => {
  if (e.target === cutterDialog) cutterDialog.close();
});
cutterLinkToggle.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-link]");
  if (!btn || btn.disabled) return;
  localStorage.setItem(CUTTER_LINK_KEY, btn.dataset.link!);
  state.cutter.error = null;
  renderCutter();
});
cutterDialogConnectBtn.addEventListener("click", () => {
  const link = cutterLinkToggle.querySelector<HTMLButtonElement>("button.active")?.dataset.link as CutterLink;
  void connectCutter(link);
});
cutterDialogDisconnectBtn.addEventListener("click", () => void disconnectCutter());

cutterTestBtn.addEventListener("click", () => void runCutterJob("test"));

for (const k of COLOR_ADJUST_KEYS) {
  colorSliders[k].addEventListener("input", () => {
    const next = { ...currentColorAdjust(), [k]: parseInt(colorSliders[k].value, 10) };
    const def = currentPaperType().colorAdjust ?? NO_COLOR_ADJUST;
    const same = COLOR_ADJUST_KEYS.every((key) => next[key] === def[key]);
    state.colorAdjust = same ? null : next;
    render(); // colour only changes the SVG filter, no re-trace needed
  });
}
colorAdjustResetBtn.addEventListener("click", () => {
  state.colorAdjust = null;
  render();
});

cutSpeedSlider.addEventListener("input", () => {
  const speed = parseInt(cutSpeedSlider.value, 10);
  state.cutSpeed = speed === defaultCutMaterial().speed ? null : speed;
  renderCutter();
});

cutPressureSlider.addEventListener("input", () => {
  const pressure = parseInt(cutPressureSlider.value, 10);
  state.cutPressure = pressure === defaultCutMaterial().pressure ? null : pressure;
  renderCutter();
});

laminatedToggle.addEventListener("change", () => {
  state.laminated = laminatedToggle.checked === !!currentPaperType().laminatedByDefault ? null : laminatedToggle.checked;
  state.cutDepth = null; // let the blade depth follow: one step deeper laminated, back to the paper type's without
  render();
});

cutDepthSlider.addEventListener("input", () => {
  const depth = parseInt(cutDepthSlider.value, 10);
  state.cutDepth = depth === defaultCutMaterial().autoBladeDepth ? null : depth;
  renderCutter();
});


rawSendBtn.addEventListener("click", async () => {
  const c = state.cutter;
  if (!c.session || c.job || c.busyOp) return;
  const lines = rawInput.value.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return;
  c.error = null;
  c.busyOp = true;
  c.statusText = "Sending…";
  renderCutter();
  try {
    const reply = await c.session.sendRaw(lines);
    rawReplyEl.textContent = reply ? `Reply: ${reply}` : "No reply within 1.5 s";
    rawReplyEl.hidden = false;
    c.statusText = null;
  } catch (e) {
    c.statusText = null;
    c.error = errorText(e);
  } finally {
    c.busyOp = false;
    renderCutter();
  }
});

cutterHomeBtn.addEventListener("click", async () => {
  const c = state.cutter;
  if (!c.session || c.job || c.busyOp) return;
  c.error = null;
  c.busyOp = true;
  c.statusText = "Homing…";
  renderCutter();
  try {
    await c.session.home();
    c.statusText = "Homed";
  } catch (e) {
    c.statusText = null;
    c.error = errorText(e);
  } finally {
    c.busyOp = false;
    renderCutter();
  }
});
calCutBtn.addEventListener("click", () => void runCutterJob("calibration"));
dryRunBtn.addEventListener("click", () => void runCutterJob("sheet", "auto", true));

calSheetBtn.addEventListener("click", () => {
  const sheet = currentSheet();
  printSvg(buildCalibrationSVG(sheet, state.regmarkStyle));
});

copyLogBtn.addEventListener("click", async () => {
  const log = state.cutter.log;
  if (!log) return;
  const text = `Shadow Garage cutter log, ${new Date().toISOString()}\n${navigator.userAgent}\n${location.href}\n\n${log.format()}\n`;
  try {
    await navigator.clipboard.writeText(text);
    copyLogBtn.textContent = "Copied";
  } catch {
    // Clipboard blocked: fall back to downloading it.
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "cutter-log.txt";
    a.click();
    URL.revokeObjectURL(url);
    copyLogBtn.textContent = "Downloaded";
  }
  setTimeout(() => (copyLogBtn.textContent = "Copy log"), 1500);
});

manualRegBtn.addEventListener("click", () => {
  const kind = state.cutter.manualRetryKind;
  if (kind) void runCutterJob(kind, "manual", state.cutter.manualRetryDryRun);
});

jogPad.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest("button[data-jog]") as HTMLButtonElement | null;
  const c = state.cutter;
  if (!btn || !c.jog) return;
  const [dx, dy] = btn.dataset.jog!.split(",").map(Number);
  try {
    await c.jog.jog.move(dx * c.jogStepMm, dy * c.jogStepMm);
  } catch (err) {
    c.error = errorText(err);
  }
  renderCutter();
});

jogStepBtn.addEventListener("click", () => {
  state.cutter.jogStepMm = state.cutter.jogStepMm === 1 ? 5 : 1;
  renderCutter();
});

jogRegisterBtn.addEventListener("click", () => {
  const jog = state.cutter.jog;
  state.cutter.jog = null;
  jog?.resolve();
  renderCutter();
});

jogCancelBtn.addEventListener("click", abortCutterJob);

sendToCutterBtn.addEventListener("click", () => {
  if (state.cutter.job) abortCutterJob();
  else void runCutterJob("sheet");
});

if (webUsbSupported()) {
  navigator.usb.addEventListener("disconnect", (e) => {
    const session = state.cutter.session;
    if (!session || !(session.transport instanceof WebUsbTransport) || session.transport.device !== e.device) return;
    abortCutterJob();
    state.cutter.session = null;
    state.cutter.statusText = null;
    state.cutter.error = "The cutter was unplugged.";
    void session.close();
    renderCutter();
  });
}

function onBluetoothLost(transport: WebBluetoothTransport) {
  const session = state.cutter.session;
  if (!session || session.transport !== transport) return;
  abortCutterJob();
  state.cutter.session = null;
  state.cutter.statusText = null;
  state.cutter.error = "Lost the Bluetooth connection to the cutter (turned off or out of range).";
  void session.close();
  renderCutter();
}

if (webSerialSupported()) {
  // Fires when a granted Bluetooth port goes away (cutter off or out of range). A lost link also
  // fails the transport's reads, so a running job stops either way; this just says why.
  navigator.serial.addEventListener("disconnect", (e) => {
    const session = state.cutter.session;
    if (!session || !(session.transport instanceof WebSerialTransport) || session.transport.port !== (e.target as SerialPort | null)) return;
    abortCutterJob();
    state.cutter.session = null;
    state.cutter.statusText = null;
    state.cutter.error = "Lost the Bluetooth connection to the cutter (turned off or out of range).";
    void session.close();
    renderCutter();
  });
}

// ---- initial render ----
render();
if (!isSupportedBrowser()) showUnsupportedBrowserAlert();
