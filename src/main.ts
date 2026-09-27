import "./style.css";
import { extractAlphaMask, type RawMask } from "./lib/trace";
import { computeDesign, type DesignResult } from "./lib/design";
import { SHEET_SIZES, packMixedSheet, type SheetSize } from "./lib/sheet";
import { buildSingleStickerSVG, buildSheetSVG, type RenderOptions, type SheetItem } from "./lib/svgBuilder";
import { REGMARK_CLEARANCE_MM } from "./lib/regmarks";
import { downloadSvgString, exportSvgStringAsPdf } from "./lib/pdfExport";
import { PAPER_TYPES } from "./lib/paperTypes";
import { getInitialTheme, applyTheme, type Theme } from "./lib/theme";
import { fitCamera, zoomAt, panBy, mmToScreen, screenToMm, type Camera } from "./lib/camera";
import { buildCalibrationSVG, calibrationPaths } from "./lib/cutter/calibration";
import { buildCutPaths, CutJobError, layoutJob, testSquarePaths } from "./lib/cutter/job";
import { WHITE_STICKER_PAPER } from "./lib/cutter/materials";
import type { CutterModel } from "./lib/cutter/models";
import { RegmarkNotFoundError } from "./lib/cutter/protocol";
import { CutterSession, type CutJob, type CutPhase, type ManualJog } from "./lib/cutter/session";
import type { LoggingTransport } from "./lib/cutter/transport";
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
  jog: { jog: ManualJog; resolve: () => void; reject: (e: Error) => void } | null; // manual registration in progress
  jogStepMm: 1 | 5;
  busyOp: boolean; // Home button or raw diagnostics command in progress
}

interface StickerDesign {
  id: string;
  fileName: string;
  imageDataUrl: string;
  raw: RawMask;
  artworkAspect: number;
  widthMm: number;
  heightMm: number;
  aspectLocked: boolean;
  driveBy: "width" | "height"; // which axis is authoritative when aspect is locked (see design.ts)
  design: DesignResult | null;
}

interface AppState {
  theme: Theme;
  paperTypeId: string;
  sheetIndex: number;
  fillMode: FillMode;
  marginMm: number;
  gapMm: number;
  sheetMarginMm: number;
  regmarksEnabled: boolean;
  regmarkStyle: "standard" | "four_corner";
  designs: StickerDesign[];
  selectedDesignId: string | null;
  activeTab: Tab;
  camera: Camera;
  fitScale: number;
  editingSelected: boolean;
  editingPlacementXY: { x: number; y: number } | null; // where the selected design's edited instance sits on the sheet (sheet tab only)
  needsRefit: boolean;
  lastPlacements: { id: string; x: number; y: number }[];
  cutter: CutterUiState;
}

const state: AppState = {
  theme: getInitialTheme(),
  paperTypeId: PAPER_TYPES[0].id,
  sheetIndex: 0,
  fillMode: "single",
  marginMm: 1,
  gapMm: 4,
  sheetMarginMm: 8,
  regmarksEnabled: true,
  regmarkStyle: "standard",
  designs: [],
  selectedDesignId: null,
  activeTab: "design",
  camera: { scale: 1, tx: 0, ty: 0 },
  fitScale: 1,
  editingSelected: false,
  editingPlacementXY: null,
  needsRefit: true,
  lastPlacements: [],
  cutter: { session: null, connecting: false, job: null, statusText: null, error: null, log: null, manualRetryKind: null, jog: null, jogStepMm: 1, busyOp: false },
};

applyTheme(state.theme);

// ---- element refs ----
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
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
const marginValue = document.getElementById("marginValue") as HTMLSpanElement;
const gapInput = document.getElementById("gapInput") as HTMLInputElement;
const gapValue = document.getElementById("gapValue") as HTMLSpanElement;

const fillModeToggle = document.getElementById("fillModeToggle") as HTMLDivElement;
const regmarksToggle = document.getElementById("regmarksToggle") as HTMLInputElement;
const regmarkStyleToggle = document.getElementById("regmarkStyleToggle") as HTMLDivElement;

const tabs = Array.from(document.querySelectorAll(".tab")) as HTMLButtonElement[];
const sheetCountBadge = document.getElementById("sheetCount") as HTMLSpanElement;
const summaryEl = document.getElementById("summary") as HTMLDivElement;
const downloadSvgBtn = document.getElementById("downloadSvgBtn") as HTMLButtonElement;
const downloadPdfBtn = document.getElementById("downloadPdfBtn") as HTMLButtonElement;
const sendToCutterBtn = document.getElementById("sendToCutterBtn") as HTMLButtonElement;
const cutterStatusEl = document.getElementById("cutterStatus") as HTMLDivElement;
const cutterConnectBtn = document.getElementById("cutterConnectBtn") as HTMLButtonElement;
const cutterTestBtn = document.getElementById("cutterTestBtn") as HTMLButtonElement;
const cutterHomeBtn = document.getElementById("cutterHomeBtn") as HTMLButtonElement;
const rawBlock = document.getElementById("rawBlock") as HTMLDivElement;
const rawInput = document.getElementById("rawInput") as HTMLTextAreaElement;
const rawSendBtn = document.getElementById("rawSendBtn") as HTMLButtonElement;
const rawReplyEl = document.getElementById("rawReply") as HTMLPreElement;
const CUTTER_DEBUG = new URLSearchParams(location.search).has("debug");
const cutterErrorEl = document.getElementById("cutterError") as HTMLDivElement;
const copyLogBtn = document.getElementById("copyLogBtn") as HTMLButtonElement;
const calSheetBtn = document.getElementById("calSheetBtn") as HTMLButtonElement;
const calCutBtn = document.getElementById("calCutBtn") as HTMLButtonElement;
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
SHEET_SIZES.forEach((s, i) => {
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = `${s.name} (${(s.widthMm / MM_PER_IN).toFixed(1)} × ${(s.heightMm / MM_PER_IN).toFixed(1)} in)`;
  sheetSelect.appendChild(opt);
});

PAPER_TYPES.forEach((pt) => {
  const btn = document.createElement("button");
  btn.className = "paper-swatch" + (pt.id === state.paperTypeId ? " active" : "");
  btn.dataset.paperId = pt.id;
  btn.innerHTML = `<span class="paper-swatch-color" style="background:${pt.swatch}"></span><span class="paper-swatch-label">${pt.name}</span>`;
  btn.addEventListener("click", () => {
    state.paperTypeId = pt.id;
    paperTypeGrid.querySelectorAll(".paper-swatch").forEach((el) => el.classList.toggle("active", el === btn));
    recompute();
  });
  paperTypeGrid.appendChild(btn);
});

// ---- helpers ----
function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function readAsDataURL(file: File): Promise<string> {
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

function renderOptionsFor(design: StickerDesign): RenderOptions {
  const pt = currentPaperType();
  return {
    imageDataUrl: design.imageDataUrl,
    borderColor: pt.exportColor,
    cutStrokeWidthMm: 0.15,
    showBorder: pt.showBorder,
  };
}

/** Strips the physical "mm" unit suffix from an SVG's width/height so 1 SVG user-unit = 1 on-screen px pre-transform. */
function toScreenSVG(svgMarkup: string): string {
  return svgMarkup.replace(/width="([\d.]+)mm"/, 'width="$1"').replace(/height="([\d.]+)mm"/, 'height="$1"');
}

function effectiveSheetMarginMm(): number {
  // Registration marks sit within REGMARK_CLEARANCE_MM of each edge — never pack stickers into
  // that band, or printed artwork could overlap and obscure a mark the cutter needs to find.
  return state.regmarksEnabled ? Math.max(state.sheetMarginMm, REGMARK_CLEARANCE_MM) : state.sheetMarginMm;
}

function maxStickerDimMm(): number {
  const sheet = currentSheet();
  return Math.min(sheet.widthMm, sheet.heightMm) - 2 * effectiveSheetMarginMm();
}

/** Packs the current designs onto the current sheet and resolves each placement to a renderable SheetItem. */
function computeSheetItems(sheet: SheetSize): { placements: { id: string; x: number; y: number }[]; items: SheetItem[] } {
  const mixedItems = state.designs
    .filter((d) => d.design)
    .map((d) => ({ id: d.id, widthMm: d.design!.actualWmm, heightMm: d.design!.actualHmm }));
  const placements = packMixedSheet(sheet, mixedItems, state.gapMm, effectiveSheetMarginMm(), state.fillMode);
  const items: SheetItem[] = placements
    .map((p) => {
      const d = state.designs.find((dd) => dd.id === p.id);
      if (!d || !d.design) return null;
      return { design: d.design, x: p.x, y: p.y, opts: renderOptionsFor(d) } as SheetItem;
    })
    .filter((x): x is SheetItem => x !== null);
  return { placements, items };
}

// ---- core recompute ----
function recompute() {
  const margin = state.marginMm;
  for (const d of state.designs) {
    d.design = computeDesign(d.raw, d.widthMm, d.heightMm, margin, d.aspectLocked, d.driveBy);
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
  marginValue.textContent = state.marginMm.toFixed(1);
  gapValue.textContent = state.gapMm.toFixed(1);
  sheetSelect.value = String(state.sheetIndex);
  fillModeToggle.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", (b as HTMLButtonElement).dataset.mode === state.fillMode);
  });
  regmarksToggle.checked = state.regmarksEnabled;
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
  fileNameEl.textContent = sel ? sel.fileName : "—";

  syncSizeInputs(sel);
  renderThumbStrip();

  const sheet = currentSheet();
  const { placements, items } = computeSheetItems(sheet);
  state.lastPlacements = placements;
  sheetCountBadge.textContent = String(placements.length);

  downloadSvgBtn.disabled = !hasImages;
  downloadPdfBtn.disabled = !hasImages;
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
      const match = placements.find((p) => p.id === sel.id);
      if (match) {
        state.editingPlacementXY = { x: match.x, y: match.y };
        renderOverlay(sel);
      } else {
        state.editingSelected = false;
        overlayLayer.innerHTML = "";
      }
    } else {
      overlayLayer.innerHTML = "";
    }
    summaryEl.textContent = `${placements.length} pcs on ${sheet.name}`;
  }
}

function renderThumbStrip() {
  thumbStrip.innerHTML = "";
  state.designs.forEach((d) => {
    const thumb = document.createElement("div");
    thumb.className = "thumb" + (d.id === state.selectedDesignId ? " active" : "");
    thumb.style.backgroundImage = `url(${d.imageDataUrl})`;
    thumb.addEventListener("click", () => {
      state.selectedDesignId = d.id;
      state.editingSelected = false;
      state.needsRefit = true;
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
  // Don't stomp on whichever field the user is actively typing into.
  if (document.activeElement !== widthInput) widthInput.value = mmToIn(design.design.actualWmm).toFixed(2);
  if (document.activeElement !== heightInput) heightInput.value = mmToIn(design.design.actualHmm).toFixed(2);
  lockAspectBtn.setAttribute("aria-pressed", String(design.aspectLocked));
  lockIconClosed.toggleAttribute("hidden", !design.aspectLocked);
  lockIconOpen.toggleAttribute("hidden", design.aspectLocked);
}

widthInput.addEventListener("input", () => {
  const design = selectedDesign();
  if (!design) return;
  const v = parseFloat(widthInput.value);
  if (!Number.isFinite(v) || v <= 0) return;
  design.widthMm = clamp(inToMm(v), MIN_SIZE_MM, maxStickerDimMm());
  design.driveBy = "width"; // hit width exactly; height (if locked) follows the true geometry
  recompute();
});

heightInput.addEventListener("input", () => {
  const design = selectedDesign();
  if (!design) return;
  const v = parseFloat(heightInput.value);
  if (!Number.isFinite(v) || v <= 0) return;
  design.heightMm = clamp(inToMm(v), MIN_SIZE_MM, maxStickerDimMm());
  design.driveBy = "height"; // hit height exactly; width (if locked) follows the true geometry
  recompute();
});

lockAspectBtn.addEventListener("click", () => {
  const design = selectedDesign();
  if (!design) return;
  design.aspectLocked = !design.aspectLocked;
  if (design.aspectLocked) {
    // Re-locking: hold width fixed and let height snap back to the true proportional geometry.
    design.driveBy = "width";
    recompute();
  } else {
    render();
  }
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
    removeDesign(state.selectedDesignId);
  }
});

window.addEventListener("resize", () => {
  state.needsRefit = true;
  render();
});

// ---- pan + select + drag-resize (pointer handling on the preview host) ----
let panPointerId: number | null = null;
let panLast = { x: 0, y: 0 };

function hitTestPlacement(mmX: number, mmY: number): { id: string; x: number; y: number } | null {
  for (const p of state.lastPlacements) {
    const d = state.designs.find((dd) => dd.id === p.id);
    if (!d || !d.design) continue;
    if (mmX >= p.x && mmX <= p.x + d.design.actualWmm && mmY >= p.y && mmY <= p.y + d.design.actualHmm) {
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
      state.selectedDesignId = hit.id;
      state.editingSelected = true;
      state.editingPlacementXY = { x: hit.x, y: hit.y };
      renderOverlay(selectedDesign());
      renderThumbStrip();
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
  if (!design || !design.design) return;
  if (!state.editingSelected) return;
  if (state.activeTab === "sheet" && !state.editingPlacementXY) return;

  const offset = state.activeTab === "sheet" ? state.editingPlacementXY! : { x: 0, y: 0 };
  const w = design.design.actualWmm;
  const h = design.design.actualHmm;
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

  const offset = state.activeTab === "sheet" ? state.editingPlacementXY! : { x: 0, y: 0 };
  const w0 = design.design.actualWmm;
  const h0 = design.design.actualHmm;
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
    design.design = computeDesign(design.raw, design.widthMm, design.heightMm, state.marginMm);

    // Live feedback: redraw in place without re-packing the sheet (positions would otherwise
    // jump around mid-drag as siblings reflow) — the real repack happens once on release.
    if (state.activeTab === "design") {
      viewportInner.innerHTML = toScreenSVG(buildSingleStickerSVG(design.design, renderOptionsFor(design)));
    } else {
      const items: SheetItem[] = state.lastPlacements
        .map((p) => {
          const d = state.designs.find((dd) => dd.id === p.id);
          if (!d || !d.design) return null;
          return { design: d.design, x: p.x, y: p.y, opts: renderOptionsFor(d) } as SheetItem;
        })
        .filter((x): x is SheetItem => x !== null);
      viewportInner.innerHTML = toScreenSVG(buildSheetSVG(items, sheetAtStart, currentRegmarkStyle()));
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

// ---- image upload ----
async function handleFiles(files: FileList | File[]) {
  const list = Array.from(files);
  for (const file of list) {
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
          design: null,
        };
        state.designs.push(design);
        state.selectedDesignId = design.id;
        resolve();
      };
      img.src = dataUrl;
    });
  }
  state.needsRefit = true;
  state.editingSelected = false;
  recompute();
}

function removeDesign(id: string) {
  state.designs = state.designs.filter((d) => d.id !== id);
  if (state.selectedDesignId === id) {
    state.selectedDesignId = state.designs[0]?.id ?? null;
    state.needsRefit = true;
    state.editingSelected = false;
    state.editingPlacementXY = null;
  }
  recompute();
}

dropzone.addEventListener("click", () => fileInput.click());
addImageBtn.addEventListener("click", () => fileInput.click());
removeImageBtn.addEventListener("click", () => {
  const sel = selectedDesign();
  if (sel) removeDesign(sel.id);
});
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

marginSlider.addEventListener("input", () => {
  state.marginMm = parseFloat(marginSlider.value);
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
tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.activeTab = tab.dataset.tab as Tab;
    state.needsRefit = true;
    state.editingSelected = false;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    render();
  });
});

// ---- export ----
function baseName(): string {
  const sel = selectedDesign();
  return (sel?.fileName || "sticker").replace(/\.[^.]+$/, "");
}

downloadSvgBtn.addEventListener("click", () => {
  const sheet = currentSheet();
  if (state.activeTab === "design") {
    const sel = selectedDesign();
    if (!sel?.design) return;
    downloadSvgString(buildSingleStickerSVG(sel.design, renderOptionsFor(sel)), `${baseName()}-cut.svg`);
  } else {
    const { items } = computeSheetItems(sheet);
    downloadSvgString(buildSheetSVG(items, sheet, currentRegmarkStyle()), `stickers-sheet.svg`);
  }
});

downloadPdfBtn.addEventListener("click", async () => {
  downloadPdfBtn.disabled = true;
  try {
    const sheet = currentSheet();
    if (state.activeTab === "design") {
      const sel = selectedDesign();
      if (!sel?.design) return;
      const svg = buildSingleStickerSVG(sel.design, renderOptionsFor(sel));
      await exportSvgStringAsPdf(svg, sel.design.actualWmm, sel.design.actualHmm, `${baseName()}-cut.pdf`);
    } else {
      const { items } = computeSheetItems(sheet);
      const svg = buildSheetSVG(items, sheet, currentRegmarkStyle());
      await exportSvgStringAsPdf(svg, sheet.widthMm, sheet.heightMm, `stickers-sheet.pdf`);
    }
  } finally {
    downloadPdfBtn.disabled = false;
  }
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
  finishing: "Finishing…",
  done: "Done — unload the mat",
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function renderCutter() {
  const c = state.cutter;
  const supported = webUsbSupported();
  const running = c.job !== null || c.busyOp;

  if (!supported) cutterStatusEl.textContent = "Requires Chrome or Edge on desktop";
  else if (c.connecting) cutterStatusEl.textContent = "Connecting…";
  else if (c.statusText) cutterStatusEl.textContent = c.statusText;
  else if (c.session) cutterStatusEl.textContent = `${c.session.label} · ${c.session.firmware}`;
  else cutterStatusEl.textContent = "Not connected";

  cutterConnectBtn.textContent = c.session ? "Disconnect" : "Connect";
  cutterConnectBtn.disabled = !supported || c.connecting || running;
  cutterTestBtn.disabled = !c.session || running;
  cutterHomeBtn.hidden = !c.session?.model.homeCommand;
  cutterHomeBtn.disabled = !c.session || running;
  rawBlock.hidden = !CUTTER_DEBUG;
  rawSendBtn.disabled = !c.session || running;
  calCutBtn.disabled = !c.session || running;
  copyLogBtn.disabled = !c.log;
  manualRegBtn.hidden = !c.manualRetryKind || !c.session || running;

  jogPad.hidden = !c.jog;
  if (c.jog) {
    jogStepBtn.textContent = `${c.jogStepMm} mm`;
    jogPosEl.textContent = `Blade at ${c.jog.jog.x.toFixed(1)}, ${c.jog.jog.y.toFixed(1)} mm from the mat corner`;
  }

  cutterErrorEl.hidden = !c.error;
  cutterErrorEl.textContent = c.error ?? "";

  sendToCutterBtn.textContent = c.job ? "Abort" : "Send to Cutter";
  sendToCutterBtn.disabled = c.busyOp || (!c.job && (!c.session || state.designs.length === 0));
}

async function connectCutter() {
  const c = state.cutter;
  c.connecting = true;
  c.error = null;
  c.statusText = null;
  renderCutter();
  try {
    // Reuse a cutter this site was already granted, so there's no picker after the first time.
    const conn = (await reconnectUsbCutter()) ?? (await requestUsbCutter());
    if (conn) {
      c.session = await CutterSession.open(conn.transport, withDiagnosticOverrides(conn.model));
      c.log = c.session.log;
      c.manualRetryKind = null;
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
function withDiagnosticOverrides(model: CutterModel): CutterModel {
  const params = new URLSearchParams(location.search);
  const out = { ...model };
  const order = params.get("regmarkArgs");
  if (order === "width_height" || order === "height_width") out.regmarkArgOrder = order;
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
  const sheet = currentSheet();
  if (kind === "test") {
    return { label: "test square", paths: testSquarePaths(), ...layoutJob(sheet, session.model, false), material: WHITE_STICKER_PAPER };
  }
  if (kind === "calibration") {
    return { label: "calibration", paths: calibrationPaths(sheet), ...layoutJob(sheet, session.model, state.regmarkStyle), material: WHITE_STICKER_PAPER };
  }
  const layout = layoutJob(sheet, session.model, currentRegmarkStyle());
  const { items } = computeSheetItems(sheet);
  if (items.length === 0) throw new CutJobError("Nothing fits on the sheet to cut.");
  return { label: "sheet", paths: buildCutPaths(items), ...layout, material: WHITE_STICKER_PAPER };
}

/** Shows the jog pad and waits until the user registers (resolve) or cancels (reject). */
function waitForManualRegistration(jog: ManualJog): Promise<void> {
  return new Promise((resolve, reject) => {
    state.cutter.jog = { jog, resolve, reject };
    renderCutter();
  });
}

async function runCutterJob(kind: CutKind, registration: "auto" | "manual" = "auto") {
  const c = state.cutter;
  const session = c.session;
  if (!session || c.job || c.busyOp) return;
  c.error = null;
  c.manualRetryKind = null;

  let job: CutJob;
  try {
    job = { ...buildCutJob(session, kind), registration };
  } catch (e) {
    c.error = errorText(e);
    renderCutter();
    return;
  }

  const controller = new AbortController();
  c.job = controller;
  let phase: CutPhase = "waiting";
  c.statusText = CUT_PHASE_TEXT[phase];
  renderCutter();
  try {
    await session.run(
      job,
      {
        onPhase: (p) => {
          phase = p;
          c.statusText = CUT_PHASE_TEXT[p];
          renderCutter();
        },
        onProgress: (f) => {
          if (phase !== "cutting") return;
          c.statusText = `Cutting… ${Math.round(f * 100)}%`;
          renderCutter();
        },
        onManualRegistration: waitForManualRegistration,
      },
      controller.signal
    );
  } catch (e) {
    c.statusText = controller.signal.aborted ? "Aborted" : null;
    if (!controller.signal.aborted) c.error = errorText(e);
    if (e instanceof RegmarkNotFoundError && registration === "auto") c.manualRetryKind = kind;
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
  else void connectCutter();
});

cutterTestBtn.addEventListener("click", () => void runCutterJob("test"));

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

calSheetBtn.addEventListener("click", async () => {
  calSheetBtn.disabled = true;
  try {
    const sheet = currentSheet();
    await exportSvgStringAsPdf(buildCalibrationSVG(sheet, state.regmarkStyle), sheet.widthMm, sheet.heightMm, `cutter-calibration-${sheet.name.toLowerCase()}.pdf`);
  } finally {
    calSheetBtn.disabled = false;
  }
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
  if (kind) void runCutterJob(kind, "manual");
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

// ---- initial render ----
render();
