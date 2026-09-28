# Sticker Cutter — Iteration Plan

## 1. What this app is

A minimal web tool, styled after StickerApp's editor, that takes one or more images and
outputs print-ready files (SVG + PDF) with an automatic die-cut outline ("cut line") around
the artwork — for sending to a plotter/cutter (Python script, Cricut, Silhouette) instead of
to a print-on-demand vendor. No cart, no checkout, no pricing. Export replaces "Add to cart."

## 2. What's already built (v0, working)

Location: `/Users/spencerowen/Downloads/sticker-cutter`

- **`src/lib/trace.ts`** — alpha-channel mask extraction, morphological dilation (adds the
  margin *and* merges nearby disconnected shapes, e.g. separate letters in a wordmark),
  connected-component labeling, Moore-neighbor boundary tracing, Chaikin smoothing. Produces
  a clean vector silhouette per connected blob, ignoring interior holes (matches how real
  die-cut vinyl stickers are actually cut — no punched-out letter counters).
- **`src/lib/design.ts`** — turns a raw mask + target W/H (mm) + margin (mm) into final
  cut-path contours and image-placement rect, both in mm, with an exact-fit normalization
  pass so the output always matches the requested physical size precisely.
- **`src/lib/sheet.ts`** — packs N copies of one sticker onto a sheet (A4/Letter/A3) given a
  gap and edge margin; returns grid dims + per-copy positions.
- **`src/lib/svgBuilder.ts`** — renders either a single sticker or a full tiled sheet as an
  SVG string, with `<g id="print">` (border fill + raster image) kept separate from
  `<g id="cutlines">` (one `<path id="cut-N">` per copy) — the split a script or cutter needs.
- **`src/lib/pdfExport.ts`** — same SVG rendered into a same-size PDF via jsPDF + svg2pdf.js.
- **`src/main.ts` / `index.html` / `src/style.css`** — single-image UI: upload, W/H with
  aspect lock, margin slider, border toggle+color, quantity, sheet size, gap, sheet margin,
  Design/Sheet-Preview tabs, Download SVG/PDF buttons.

Verified working end-to-end (upload → trace → smooth outline → tile → export SVG); PDF
generation verified to produce valid bytes (download-to-disk untested in the sandboxed
preview browser used during development — recheck in a real browser).

**This foundation (trace/design/sheet/svgBuilder/pdfExport) is reused as-is.** The rework
below is primarily `main.ts` (state becomes a list of designs instead of one) and the
UI layer (`index.html`/`style.css`), to match the target workflow and the reference look.

## 2b. v1 iteration — done

Everything in §3–§8 below has been implemented and manually tested in-browser (upload,
resize, zoom/pan, multi-design, fill-sheet, both themes):

- Dark-by-default theme with a light-mode toggle (`src/lib/theme.ts`), persisted in
  `localStorage`. CSS variables on `:root` / `:root[data-theme="light"]`.
- Sheet size defaults to Letter (`SHEET_SIZES[0]` in `src/lib/sheet.ts`).
- Cut line hardcoded red (`CUT_LINE_COLOR` in `src/lib/svgBuilder.ts`); no color picker.
- No unit toggle, no numeric width/height inputs. All display is inches-only.
- Click-to-select + drag-a-corner resize, aspect ratio always preserved, implemented via a
  small camera/viewport model (`src/lib/camera.ts`) mapping mm-space ↔ screen-space, plus
  pointer handling in `main.ts` for pan, wheel-zoom, and corner-drag. A floating dimension
  pill (click-to-edit) shows the *achieved* size, matching the bottom summary exactly.
- Multi-image upload, thumbnail filmstrip, per-thumbnail remove, `designs: StickerDesign[]`
  state model as planned in §5.
- Paper type swatches (`src/lib/paperTypes.ts`) — cosmetic preview + a solid export color per
  type, "Clear" suppresses the border fill entirely.
- Single/Fill-sheet toggle backed by a new mixed-item shelf packer (`packMixedSheet` in
  `src/lib/sheet.ts`) that round-robins across differently-sized designs.

**Two real bugs found and fixed during testing** (worth remembering, not just historical):
1. *Margin/merge coupling*: the margin slider controlled both the visible border width **and**
   the raster-dilation radius that fuses disconnected artwork pieces (e.g. separate letters in
   a wordmark) into one cuttable outline. Near 0mm, letters stopped merging — each traced its
   own tiny outline, producing overlapping cut lines, and per-piece Chaikin-smoothing shrinkage
   then threw off the size-fit math (see bug 2). Fixed with a `MIN_MARGIN_MM = 1` floor in
   `design.ts`, and the margin slider's HTML `min` raised to match — so the displayed number
   always matches what's actually rendered. A pathologically-spaced multi-part design could
   still need a manually larger margin to fully merge; that's expected, not a bug.
2. *Size distortion at the edges*: `computeDesign`'s exact-fit correction used **independent**
   X/Y scale factors to hit the requested W×H exactly, which could stretch/distort the sticker
   whenever the dilated bbox's aspect ratio didn't precisely match the target (exactly the
   scenario bug 1 caused). Fixed by using a single **uniform** fit scale (never distorts) and
   having `actualWmm`/`actualHmm` report the size truly achieved rather than blindly echoing
   the requested target — the UI now always shows what's really there.
3. *(CSS, not logic)* `[hidden]` elements that also had an author `display: flex/grid` rule
   stayed visible, because author specificity ties with the UA `[hidden]{display:none}` and
   the later-declared rule wins. Fixed with a global `[hidden] { display: none !important; }`.
4. *Cropped/flattened corners on tightly-cropped source art*: `extractAlphaMask` drew the
   uploaded image onto a canvas sized to exactly fit it, with zero breathing room. Dilating
   the mask outward (for margin/merging) then hit the canvas edge and got hard-clipped there —
   producing a flat, diagonal-looking cut wherever the artwork's alpha bbox happened to touch
   or sit close to the image's own edge (confirmed with a real asset whose bbox was exactly
   `(0,0,width,height)` — no padding at all in the source PNG). Fixed by padding the mask
   canvas by 50% of the drawn image's long edge on every side before tracing (`trace.ts`), plus
   a defensive clamp in `computeCutPath` that caps the dilation radius to the mask's own
   dimensions so it can never be requested larger than the canvas can support.

## 2c. v1.1 tweaks — done

- Margin floor lowered from 1mm to **0.2mm** (`MIN_MARGIN_MM` in `design.ts`, slider `min` in
  `index.html`), default value raised to **1mm**. The 0.2mm floor still exists for the same
  reason as bug 1 above — purely single-blob artwork can now get a near-zero kiss cut, while
  multi-part artwork that needs more bridging still just needs a larger margin than the floor.
- **Resize directly on the Sheet Preview tab**, not just the Design tab: clicking any placed
  copy selects its underlying design and shows the same corner-drag handles, anchored to that
  specific instance's position on the sheet (`state.editingPlacementXY`, resolved via
  `hitTestPlacement` in mm-space rather than DOM hit-testing, since the sheet SVG doesn't tag
  elements by design id). During the drag, the sheet is redrawn using the *existing* packed
  positions (no live re-pack) so sibling stickers don't jump around; releasing the handle
  triggers a real `recompute()` that re-packs the whole sheet and re-anchors the overlay to
  wherever that design landed.
- **Delete the selected sticker**: a small red × button appears at the top-right of the
  selection outline (works in both tabs), and `Delete`/`Backspace` deletes the selected design
  when it's focused (guarded against firing while a text input, like the dimension-pill editor,
  has focus).
- **Width/Height text boxes + aspect lock** back in the side panel (`Size (in)` block), for
  precise fine-tuning alongside the drag-to-resize interaction. A padlock button between the
  two fields, defaulting **on** (locked): editing either field recomputes the other from
  `artworkAspect`. Unlocking allows a genuine non-uniform stretch — this required restoring
  `computeDesign`'s exact-fit step to independent per-axis scaling (`fixX`/`fixY`) behind a new
  `preserveAspect` parameter (default `true`, matching the old uniform-only behavior when
  locked), now that the real corner-cropping bug is fixed at its source (mask-canvas padding).
  Locked calls (corner-drag, the floating pill, locked text-box edits) always pass matched W/H
  so `preserveAspect` is a no-op for them either way; unlocked text-box edits are the only path
  that intentionally passes mismatched W/H to get a stretch. Fields skip re-syncing their value
  while the user has that specific field focused, so typing doesn't fight with the live re-render.

## 2d. Registration marks (print-and-cut optical alignment) — done

Reverse-engineered from
[fablabnbg/inkscape-silhouette's `render_silhouette_regmarks.py`](https://github.com/fablabnbg/inkscape-silhouette/blob/main/render_silhouette_regmarks.py)
(GPL-2.0 — studied for the spec, not vendored). New `src/lib/regmarks.ts` reproduces its exact
geometry: a solid 5×5mm black square top-left, plus L-shaped brackets (two line segments, 20mm
arms, **0.3mm stroke** — the upstream code cites real-world testing that thicker marks measurably
hurt optical registration accuracy) top-right and bottom-left, all offset 10mm from the sheet
edges. **Defaults to on.**

- New "Registration Marks" panel block: an enable checkbox plus a Standard/Four-corner style
  segmented control (sheet-only; a no-op on the Design tab, which has no page/margin concept).
  Wired through `buildSheetSVG`'s new optional third argument rather than baked into
  `svgBuilder.ts` unconditionally.
- **Automatic clearance**: enabling it raises the effective sheet-edge packing margin to at least
  `REGMARK_CLEARANCE_MM` (origin + arm length = 30mm) via a new `effectiveSheetMarginMm()` helper,
  so stickers can never be packed into the marks' zone and obscure them. This is a real, enforced
  constraint — checked against the upstream project's own code (`Graphtec.py`'s `clip_point`/
  `enable_sw_clipping`) and confirmed that library does *not* do this: its "safe area" is a plain
  white-filled shape for the human designer's benefit inside Inkscape, not something the cutting
  pipeline itself checks.
- **Per-model reality check**: also confirmed against `Graphtec.py`'s per-device hardware table
  that registration marks are *not* identical across Silhouette models. Nearly every model that
  supports registration at all uses the standard 3-mark style; only three set `quadregmarks: True`
  — **Cameo Pro MK-II, Cameo 5 Alpha, Cameo 5 Alpha Plus** — and four-corner mode isn't purely
  additive for them: the library also swaps the top-left mark from a solid square to an L-bracket
  in that mode, so it's specifically for those three, not a strict superset of standard. Exposed
  as an explicit style choice for that reason, defaulting to the broadly-compatible standard.
- Refactored the three near-identical "pack + resolve to SheetItem[]" blocks (`render()`, both
  export handlers) into one `computeSheetItems()` helper while making this change, since regmarks
  needed to plug into all of them consistently.

## 2e. Multi-add discoverability — done

Multi-image upload already worked (the file input has `multiple`, drag-drop already handled a
`FileList`) but wasn't obvious before the first upload. Added a dashed `+` tile at the end of the
thumbnail filmstrip (a familiar "add more" pattern) and made the filmstrip itself appear as soon
as there's one design, not two — so the `+` tile is visible immediately after the very first
upload, not only once a second one already exists. Also reworded the dropzone's hint text to
mention selecting/dropping several files at once.

## 2f. Print replaces Download PDF — done

Swapped "Download PDF" for a **Print** button that opens the browser's native print dialog
directly (`window.print()`), positioned to the *left* of Download SVG since it's now the more
common action. New `src/lib/print.ts` swaps the export-quality SVG (real mm width/height, same
one `buildSingleStickerSVG`/`buildSheetSVG` already produce) into a dedicated `#printArea` node;
new `@media print` CSS in `style.css` hides everything else on the page (`body > *:not(#printArea)`)
so only that SVG prints, at `@page { margin: 0 }`. No new library needed — the browser's own print
pipeline handles the mm-to-physical-size conversion, the same way it already does when a page
declares `width="Xmm"` on an SVG. This let us **drop jsPDF and svg2pdf.js entirely**
(`src/lib/pdfExport.ts` → `src/lib/download.ts`, now just `downloadSvgString`), which incidentally
cut the production bundle from ~511KB to ~24KB.

## 2g. Preserve sharp corners (opt-in) — done

Added a "Preserve sharp corners" toggle (Offset Margin block), **defaulting off**. Root-caused
that corner rounding wasn't (only) coming from Chaikin smoothing — the margin/merge dilation
itself uses a circular (Euclidean chamfer) structuring element, and dilating *any* shape with a
disk mathematically rounds convex corners by ~the dilation radius; no amount of smoothing
afterward can undo that. Fixed at the actual source: `dilateMask` in `trace.ts` takes a new
`chebyshev` flag that switches the two-pass distance transform to Chebyshev/chessboard distance
(diagonal steps cost the same as orthogonal ones) — the raster equivalent of a miter join instead
of a round one, which keeps right-angle corners exactly sharp. Paired with a new
`chaikinSmoothPreserveCorners` in the same file, which classifies each vertex's turn angle once
(≥60° = sharp) on the pre-smoothing polygon and carries protected vertices through every Chaikin
iteration unchanged, so genuine corners survive the smoothing pass too.

**This is a real trade-off, not a strict improvement — confirmed by testing, not assumed.**
Square/Chebyshev dilation is exactly right for a geometric icon with real right angles (verified:
a nested-square test icon went from visibly rounded to a crisp 90°, toggle-for-toggle, at the
same 5mm margin). But dilating a *curved* boundary (any rounded letterform, i.e. ordinary text)
with a square structuring element doesn't produce a smooth bulge — it faceting/staircases the
curve, since square dilation is a poor approximation of "offset by r" for anything that isn't
already rectilinear. Verified this regression directly on the wordmark test asset before deciding
the default: with the toggle on, its smooth outline became visibly jagged. That's why default is
off (unchanged, smooth-by-default behavior) with the toggle as an explicit per-design opt-in, and
why the hint text says plainly it's for geometric logos/icons, not curvy or text-heavy artwork.
`computeCutPath`/`computeDesign` both take the new flag as their last parameter, threaded through
from a single `state.preserveSharpCorners` (global, like margin) into `recompute()` and the
corner-drag live-preview path in `main.ts`.

## 2h. Two more bugs found and fixed

1. **Dark mode was printing as black ink.** The Print feature (§2f) hides everything but
   `#printArea` during print, but never overrode `body`'s own background — which is the dark
   theme's near-black `--bg` unless the viewer happens to be in light mode. Since a single
   sticker's exported SVG has no full-canvas background rect of its own (intentional — it's what
   makes the "Clear" paper type genuinely transparent for file exports), that dark `body`
   background showed straight through as printed ink, both around the sticker and anywhere the
   SVG itself is transparent. Fixed with `@media print { html, body { background: white
   !important; } }` — screen theme stays a pure preview convenience, the printed page is always
   on white regardless of it. Deliberately a CSS-only fix, not a change to `svgBuilder.ts`'s SVG
   output, since that output's transparency is correct/intentional for saved files.
2. **Registration marks were wasting a lot of sheet space.** `effectiveSheetMarginMm()` (§2d)
   inflated the packing margin to the full 30mm clearance *on all four sides*, when the marks
   only actually occupy ~30×30mm squares at 3 (or 4) corners — on a Letter sheet (215.9mm wide)
   that wastes 60mm of width (28%) that has nothing near it to protect. Replaced with precise
   per-corner keep-out rectangles (`getRegmarkKeepoutRects` in `regmarks.ts`) and taught
   `packMixedSheet` (`sheet.ts`) to narrow only the specific shelf rows that actually vertically
   overlap a keepout, pushing the row's left/right bound in just enough to clear it, rather than
   shrinking the whole usable rectangle uniformly. Verified: the same test sheet went from a
   handful of stickers with huge dead margins to 46, using the full width on every row except the
   couple that overlap a corner mark.

**Known environment caveat, not a code issue**: in the sandboxed preview browser used during
this session, blob-based file downloads (`<a download>` + `URL.createObjectURL`) intermittently
stopped landing on disk partway through testing — reproduced even with a trivial 10-byte test
blob on a brand-new tab, so it isn't specific to this app's export code (the exact same SVG
build/download path was verified working earlier in the same session, and the exported SVG's
structure — `<g id="print">`, `<g id="cutlines">`, red stroke, embedded `<image>` — was
independently confirmed correct by inspecting the live DOM/string). **Re-verify Download
SVG/PDF in a real, non-sandboxed browser** before considering this fully done.

## 3. Target user workflow (this iteration)

1. User opens the webpage.
2. User drags & drops (or imports via file picker) one or more images — PNG, JPEG, or SVG.
3. User specifies **paper type** (e.g. white vinyl, holographic, matte, glossy) and
   **paper size** (Letter, A4, ...).
4. User scales each image directly on the canvas — no numeric size fields: click the sticker
   to select it, then drag a corner handle to make it larger/smaller.
5. User specifies the offset/margin size (space between artwork edge and cut line).
6. The app automatically draws the **red** cut-line perimeter around the artwork — hardcoded,
   not a user-configurable color (resolves what was open question #4 below).

Additional requirements called out explicitly:

- Interface should be **minimal and dynamic**, in the visual language of the attached
  StickerApp screenshot: large centered preview with a floating "Edit design"-style action,
  a narrow clean right-hand panel using pill/segmented controls rather than dense form rows,
  one prominent primary action at the bottom. On top of that reference look: a more modern,
  minimal visual treatment overall, **dark mode by default with a light-mode option** (a
  toggle takes over the top bar slot the old mm/in toggle used to occupy), preference
  persisted locally (`localStorage`) so it sticks between visits.
- **No unit toggle, no numeric width/height fields.** Display is inches-only (matches the
  Letter-default, imperial-leaning workflow); there's no mm/in switch to maintain. Sizing an
  image is purely the click-and-drag-corner interaction in point 4 above, not a text field.
- **Canvas zoom**: the user can zoom in/out on the preview canvas (scroll-wheel and/or +/−
  buttons, plus a reset-to-fit) to work precisely on small or fine-detail stickers. This is a
  *view* zoom only — it changes how large the sticker looks on screen, never its actual
  output size in inches.
- **Sheet size defaults to Letter** (not A4).
- **Multiple images**: the user can upload more than one design and manage them (not just
  replace-one-image as today).
- **Single vs. fill-sheet toggle**: a simple switch between "just export 1 copy" and "pack as
  many copies as will fit on the sheet" — replacing today's free-typed quantity number as the
  primary control (an explicit quantity can still exist as a secondary/advanced option).

## 4. Gaps between v0 and the target

| Area | v0 (today) | Target |
|---|---|---|
| Images | exactly one, replaces on re-upload | a list; add/remove/select; each has its own size+margin |
| SVG upload | raster only (PNG/JPEG/WebP/GIF) | also accept `.svg` as source artwork |
| Paper/material | a free-pick color swatch ("border color") | a small set of named paper-type presets (White, Holographic, Matte, Glossy...) each with a representative preview swatch/pattern, decoupled from sheet size |
| Sheet size | dropdown (A4/Letter/A3), defaults to A4, mm-only internally | same dropdown, **defaults to Letter** |
| Units | mm/in toggle | removed; inches-only display |
| Sizing control | numeric Width/Height inputs + lock-aspect button | no numeric fields; **click the sticker to select it, drag a corner handle to resize** (aspect ratio preserved by the drag itself, no separate lock toggle needed) |
| Canvas view | fixed 1:1-ish fit, no zoom | scroll-wheel/+−-button **zoom and fit-to-view reset**, purely a view convenience, independent of the sticker's actual output size |
| Cut line color | user-pickable (default magenta) | fixed red, not user-configurable |
| Quantity | manual number input | primary control is a **Single / Fill sheet** toggle; manual count becomes secondary |
| Theme | light only | **dark by default, light mode optional**, toggle persisted in `localStorage` |
| Visual style | dense stacked form panel | more modern/minimal than even the StickerApp reference: shape/preview-first, few controls, one CTA |
| Multi-design layout | n/a | sheet-preview must tile potentially *different* images together, not just copies of one |

## 5. Data model changes

Replace the single `raw`/`design` fields in `AppState` with a list:

```ts
interface StickerDesign {
  id: string;
  fileName: string;
  imageDataUrl: string;
  raw: RawMask;                 // from extractAlphaMask()
  artworkAspect: number;
  widthMm: number;              // still stored/computed in mm internally; only the UI is inches-only
  heightMm: number;
  marginMm: number;
  design: DesignResult | null;  // recomputed on any of the above changing
}

interface AppState {
  theme: 'dark' | 'light';      // defaults to 'dark', persisted in localStorage
  paperType: PaperTypeId;       // 'white' | 'holographic' | 'matte' | 'glossy' | ...
  sheetIndex: number;           // which SHEET_SIZES entry — defaults to the Letter entry
  fillMode: 'single' | 'fill';  // primary quantity control
  manualQuantity: number;       // used only when fillMode === 'single' is false and user overrides fill count
  gapMm: number;
  sheetMarginMm: number;
  designs: StickerDesign[];
  selectedDesignId: string | null;  // which design shows corner-drag handles / is being resized
  activeTab: 'design' | 'sheet';
  viewZoom: number;             // canvas view zoom (e.g. 1 = fit-to-view baseline), display-only
  viewPan: { x: number; y: number };
}
```

Dropped from v0's shape: `unit` (no longer a thing — UI is inches-only) and `aspectLocked`
(no longer a thing — corner-drag always preserves aspect ratio, so there's nothing to toggle).

Sheet packing needs to change from "pack N copies of one sticker" to "pack a mixed set of
stickers." Simplest correct approach for v1 of this iteration: pack each design's copies in
turn, largest-first, using a shelf/row-packing algorithm (extension of the current
`packSheet` — iterate designs, for each maintain a running shelf cursor, wrap to a new shelf
row when a row is full, stop the sheet when vertical space runs out). Copies-per-design in
fill mode = as many as fit after all designs have placed at least one (round-robin) — see
open questions below for exact policy.

## 6. New/changed UI, matching the reference screenshot's density

- **Theme**: dark by default (near-black panel backgrounds, light text, muted borders), full
  light-mode equivalent available via a toggle in the top bar (same slot the mm/in toggle
  used to occupy). Implemented as CSS custom properties on `:root` with a `data-theme`
  attribute switch, so it's a straightforward independent pass over `style.css`, not tied to
  the other structural changes. Persist the choice in `localStorage`; fall back to
  `prefers-color-scheme` only if there's no stored preference yet, but the app's own default
  (absent any signal) is dark.
- **Preview panel — now interactive, not just a static render**:
  - Pan/zoom: scroll-wheel (and trackpad pinch) zooms the canvas around the cursor; a small
    +/− control plus a "Fit"/"100%" reset sits in a corner. This is view-only — it never
    changes a sticker's stored size in inches, only how big it renders on screen. Needs the
    SVG wrapped in a pannable/zoomable container (CSS transform: translate+scale on a group,
    or an actual viewBox manipulation) with pointer/wheel handlers.
  - Select + resize: clicking a sticker selects it (only meaningful once multiple designs
    exist; with one design it's just always "selected"). A selected sticker shows a thin
    outline plus 4 corner handles. Dragging a corner scales the sticker uniformly
    (aspect-ratio preserved — no separate lock toggle, the drag *is* the lock). While
    dragging, show a small floating readout of the live size (e.g. `3.3 × 1.0 in`) near the
    cursor/handle so the user has feedback without a text field. Implementation-wise: this
    needs the corner-handle hit-targets to live in *screen* space while the actual resize
    math happens in the sticker's own mm space, so dragging must account for the current
    `viewZoom` factor when converting a pixel delta into a physical size delta.
  - A filmstrip of thumbnails along one edge once there's more than one design, click to
    select (same selection state as clicking the sticker directly on canvas).
- **Right panel, top → bottom** (no numeric size fields anymore):
  1. Paper type — icon/swatch row (white / holographic / matte / glossy), single-select.
  2. Paper size — segmented control or dropdown (Letter / A4 / A3), **defaults to Letter**.
  3. Offset/margin — slider (unchanged; no border-color or cut-line-color pickers — paper
     type supplies the border swatch, and the cut line is hardcoded red, see below).
  4. Quantity — segmented **Single / Fill sheet** control as the primary toggle; when "Fill
     sheet" is active, show the resulting count read-only (e.g. "33 pcs · 11×3"), no manual
     number needed unless we keep an "advanced" expander for it.
- **Bottom bar**: summary text + **Download SVG** / **Download PDF**, same as today.
- Cut line color: hardcoded to red in `svgBuilder.ts`'s default `RenderOptions` — not exposed
  in the UI at all, anywhere.
- Visual pass: beyond just adopting the reference's pill/rounded shapes, go more minimal —
  fewer visible chrome elements, let the preview canvas dominate, controls recede until
  something is selected. Restyle `style.css` (and rework `index.html`'s panel markup to drop
  the removed fields); not a framework rewrite.

## 7. Open questions (need a decision before/while building)

1. **Fill-sheet packing policy with multiple different designs**: fill sheet evenly across
   all uploaded designs (round-robin), or fill each design's own maximum count sequentially
   (fill design 1 fully, then design 2 in remaining space), or let the user assign a
   per-design quantity even in "fill" mode? Recommendation: round-robin so a multi-design
   sheet feels like a balanced set; revisit if that's not what's wanted.
2. **Paper type presets — cosmetic only or does it change export?** Since there's no real
   print backend, "holographic" etc. can only realistically affect the on-screen preview
   swatch/pattern (and maybe a label baked into the exported filename/metadata). Confirm
   that's sufficient — i.e. we are not simulating a holographic material's actual look on
   the raster artwork itself, just the border/background swatch.
3. **SVG-as-source-artwork**: when the uploaded file is itself an SVG (not a raster), do we
   (a) rasterize it offscreen to run the same alpha-trace pipeline (simplest, consistent
   with today's code, slight quality loss for very fine vector detail), or (b) parse and
   reuse its existing vector paths directly for the silhouette (higher fidelity, notably
   more implementation work)? Recommendation: (a) first, since the trace pipeline already
   handles it once rasterized to canvas; revisit (b) only if traced quality is a problem.
4. ~~Removing the cut-line color picker~~ — **resolved**: red, hardcoded, not user-facing.
5. **Per-design vs. global margin/paper**: is margin (offset) global for the whole sheet, or
   per-design like size is? Workflow step 5 ("user specifies the offset size") reads as one
   global setting; size (step 4) reads as per-image. Plan assumes: **size is per-design,
   margin/paper/sheet are global** — flag if that's wrong.
6. ~~Minimum/maximum drag-resize bounds~~ — **resolved**: floor of 0.25in physical size, cap
   at the sheet's usable width/height. Handle *hit targets* stay a constant ~12px in screen
   space regardless of zoom (even as the visual sticker shrinks smaller), so handles never
   become unclickable at high zoom-out.
7. ~~Precise sizing without a text field~~ — **resolved**: the live-size readout shown during
   drag is click-to-edit (becomes a text input in place, same spot) — invisible until needed,
   one click away when exact values matter.
8. ~~Zoom range and controls~~ — **resolved**: wheel/trackpad-pinch to zoom, small +/− buttons,
   and a **"Fit"** reset button (not "100%" — browsers can't reliably report real screen DPI,
   so a claimed "100% = actual size" would usually be wrong; "Fit" is always honest). Range
   25%–400%. Keyboard shortcuts `+`/`-`/`0` wired up from the start alongside the buttons.

## 8. Suggested build order

Roughly ordered from "cheap and isolated" to "more involved," so each step is independently
testable before moving on:

1. **Quick wins first** (small, independent, no data-model changes needed):
   - Hardcode cut-line color to red in `svgBuilder.ts`; delete the color-picker control.
   - Default `sheetIndex` to the Letter entry in `SHEET_SIZES` instead of A4.
   - Remove the mm/in unit toggle; make all size displays inches-only.
2. **Theme pass**: CSS custom properties + `data-theme` attribute, dark values as the
   `:root` default, light values under `[data-theme="light"]`, toggle button wired to flip
   the attribute and persist to `localStorage`. Independent of every other change — can land
   and be checked on its own before anything else here is built.
3. **Data model rework** in `main.ts`: move to `designs[]`, drop `unit`/`aspectLocked` fields
   (see §5); keep `trace.ts`/`design.ts`/`svgBuilder.ts` unchanged since they're already
   per-design pure functions.
4. **Multi-upload UI**: dropzone accepts multiple files + drag-drop of several at once; add a
   thumbnail strip; selecting a thumbnail (or clicking the sticker on canvas) sets
   `selectedDesignId`.
5. **Canvas zoom/pan**: wrap the preview SVG in a transformable container, wire up
   wheel-to-zoom + fit/reset button, independent of the resize-handle work below (get
   panning/zooming solid on a static, non-resizable render first).
6. **Click-to-select + drag-corner resize**: the most involved new piece — render handles on
   the selected design, hit-test pointer-down on a handle, track pointer-move deltas,
   convert screen-space delta to mm-space using the current `viewZoom`, live-update
   `widthMm`/`heightMm` (and therefore re-run `computeDesign`) on every move, show the
   floating live-size readout, commit on pointer-up. Build and test this against a single
   design before wiring it into the multi-design flow.
7. **Paper type presets** (swatch row) replacing the border-color picker; wire the selected
   preset's color into the existing border-fill rendering path.
8. **Single/Fill-sheet toggle** replacing the manual quantity input as the primary control;
   keep `packSheet` for the single-design case, extend it for mixed designs (per open
   question #1) for the multi-design case.
9. **Visual restyle pass** (`style.css`) toward the more minimal, preview-first look described
   in §6, on top of the theme work from step 2.
10. Re-test the full flow (multi-image upload → drag-resize each → paper/sheet → fill toggle
    → export) the same way v0 was tested (synthetic multi-shape test image, inspect exported
    SVG structure, sanity-check PDF bytes) — in both themes.

## 9. Reference repos (for later — driving a cutter directly, better outline extraction)

Not dependencies today; noted here because they may be useful if we later want to (a) talk
to a cutter/plotter directly instead of only exporting SVG/PDF for the user to feed into
someone else's software, or (b) replace/validate our own alpha-trace pipeline with a more
general SVG-stroke-to-line-segments approach.

- **[fablabnbg/inkscape-silhouette](https://github.com/fablabnbg/inkscape-silhouette)** —
  GPL-2.0, pure Python (libusb backend). An Inkscape extension that drives Silhouette
  Cameo/Portrait/Curio (and Craft Robo) cutters directly over USB or Bluetooth (Classic
  RFCOMM and BLE), no Silhouette Studio required. Useful reference for: the actual
  device protocol/command set for these cutters, per-material speed/force/blade-depth
  settings, and how they handle print-then-cut registration marks — relevant if this app
  ever wants an "export directly to my cutter" path instead of "export a file, open it in
  some other program." GPL-2.0 licensing means we'd study it for protocol knowledge rather
  than vendor its code into this project as-is.
- **[mossblaser/svgoutline](https://github.com/mossblaser/svgoutline)** — LGPL-3.0, Python.
  Extracts all *stroked* paths from an arbitrary SVG (beziers, shapes, simple text, dashed
  lines, honors layer/object visibility) and flattens them into straight line segments in
  millimeters, each tagged with its stroke RGBA and width — exactly the shape of data a
  pen-plotter or cutter driver wants. Two ways this is relevant later: (1) if we add
  "upload an SVG with a pre-drawn cut line" as an input mode (rather than only auto-tracing
  raster alpha), this is a proven way to pull just the stroked cut-line layer back out
  regardless of how the SVG was authored; (2) as a cross-check for our own Moore-tracing +
  Chaikin-smoothing output — since it's Python/LGPL rather than something we can import
  into the browser directly, any reuse would mean porting the *approach* (bezier
  flattening tolerance, stroke-color-based layer selection) to JS, not the code itself.

## 10. Explicitly out of scope (unless asked)

- Real checkout/pricing/cart — this stays a pure export tool.
- Actually simulating material optical properties (true holographic rendering, foil, etc.)
  beyond a representative preview swatch.
- Cricut/Silhouette native project-file formats — SVG/PDF only.
- Non-outer-silhouette (hole-aware) cutting — intentionally out of scope per real-world
  vinyl sticker cutting practice (see `src/lib/trace.ts` component tracing).

## 11. Send to cutter (Silhouette Cameo 3 over WebUSB) — built, not yet hardware-verified

Cuts the packed sheet directly from Chrome/Edge, replacing "export, then open another program."
Setup and usage are in `docs/cutter-setup.md`.

**Decisions:**
- **Cameo 3 only, USB only, Linux + macOS first.** USB was picked over Bluetooth for v1: it works
  on both target platforms (macOS with no setup, Linux with one udev rule), has no pairing step,
  and is the path inkscape-silhouette exercises most. Bluetooth Classic on the Cameo 3 would go
  through Web Serial (RFCOMM), not Web Bluetooth; it's the planned v2 and also the only way to reach
  Windows without a driver swap, since Windows' `usbprint.sys` blocks WebUSB on printer-class
  devices. Open question for v2: which RFCOMM service UUID the Cameo 3 advertises (upstream
  connects to raw channel 1; Web Serial selects by UUID).
- **AutoBlade + white sticker paper only** — one fixed preset in `materials.ts`, no picker.
- **Always cuts the sheet layout** (what the PDF prints), regardless of the active tab — a lone
  sticker from the Design tab has no printed counterpart to align to.
- Protocol reverse-engineered from inkscape-silhouette's `Graphtec.py` (GPL-2.0), studied rather
  than vendored, same as `regmarks.ts`.

**Structure** (`src/lib/cutter/`), layered so more models/manufacturers are mostly data:
- `transport.ts` — byte-pipe interface; `webUsbTransport.ts` implements it. WebUSB `transferIn`
  can't be cancelled, so one read loop runs continuously into a `ByteQueue` and reads wait on that
  (a timed-out `transferIn` would otherwise swallow the next reply).
- `protocol.ts` — protocol interface; `graphtec.ts` implements Silhouette's GPGL (pure command
  builders + a `GraphtecProtocol` class). Future HPGL cutters plug in here.
- `models.ts` (device registry: USB ids, bed, mat, mark style, ranges), `materials.ts`.
- `job.ts` — sheet items → ordered, closed, 1mm-overcut polylines; `layoutJob()` maps sheet mm to
  device mm (mark-relative when marks are on) and rejects sheets that don't fit the mat or mark
  styles the model can't read. `regmarks.ts` gained `regmarkLayout()` so the SVG and the cutter's
  mark search share one definition of where the marks are.
- `session.ts` — handshake on connect, then per job: wait for ready (prompts to load the mat) →
  setup → mark search → cut in ≤1KB packets, polling status between packets → park.

**Verified:** `npm test` (vitest, new) covers the command builders, job geometry and the session
state machine against a scripted fake device, including a golden test asserting our full command
stream equals inkscape-silhouette's own dry-run transcript for the same job. The UI flow was driven
end-to-end in headless Chromium against a simulated Cameo 3 injected as `navigator.usb` (connect,
cut, wrong-mark-style error, marks-not-found error, disconnect, unsupported browser).

**Not verified (needs the real cutter):** that Chrome can claim the device on macOS/Linux; the
sticker-paper pressure/speed/depth (upstream's "Sticker Sheet" defaults: 20/10/1); the mark-relative
coordinate sign convention on a real print-and-cut (target: cut within ~0.5mm of the print); and
whether ESC EOT (Abort) lifts the blade immediately.

**Noted, out of scope:** the printed PDF includes the red cut line, so any misalignment shows as a
red edge — a "hide cut lines when printing" option would be a separate small change.

### 11a. First hardware test — marks found, cut scaled down (open)

Real Cameo 3 test: Chrome claimed the device and the automatic mark scan succeeded, but the cut was
the right shape at about half size or less, narrower more than shorter. The print was at 100% on
Letter, with Letter selected in the app.

- **Ruled out, app side:** a traced 3.00 in sticker at sheet (30, 30) mm is sent as exactly
  76.2 mm wide at mark-relative (20, 20). Checked end-to-end in headless Chromium, and now also
  covered by a unit test in `job.test.ts`. The marks match upstream's renderer geometry exactly,
  and the command stream matches upstream's transcript. So the scaling happens in the cutter's
  registration transform (or its units).
- **Prime suspect:** the order of the mark distances in `TB123` / `TB23`. Graphtec.py sends
  height first; upstream's `Commands.md` Silhouette Studio trace shows width first. This is now
  a per-model field (`regmarkArgOrder` in `models.ts`), with a `?regmarkArgs=width_height` URL
  override for testing. The Cameo 3 keeps upstream's height-first order until hardware says
  otherwise.
- **Diagnostics added:**
  - `LoggingTransport` records every command and reply, keeping the start of the session so long
    jobs can't push out the handshake and mark search. Replies that arrive but are never read
    (e.g. the extra ones after a mark search) are logged as "unread". Exposed via **Copy log**.
  - Calibration sheet + calibration cut (`calibration.ts`): a 140×200 mm printed rectangle and the
    identical cut, which gives the X/Y scale and offset with a ruler.
- **Mark misses:** the scan window isn't configurable; the scan looks near where each mark should
  be. The "marks not found" error now gives a loading checklist. After a miss, an experimental
  manual registration jogs the blade onto the top-left mark (`M` moves, 1/5 mm steps) and sends
  `TB23`. Unconfirmed on hardware; drop it if the Cameo 3 doesn't accept it.
- **Next:** measure the Test cut square (10 mm means units are fine) and the calibration cut
  with each argument order, then fix `regmarkArgOrder` (or units) for the Cameo 3 and update the
  golden test to note the deliberate difference from upstream.

**Homing (added after the second hardware report).** The user saw the mark search start from
wherever the carriage was, and the AutoBlade's depth-setting taps land on the paper. We never
homed: the handshake and Abort send `ESC EOT` (initialize), which apparently re-zeroes coordinates
at the carriage's current position, and Graphtec.py doesn't home either. Silhouette Studio's
documented startup sequence (upstream `Commands.md`) sends `TT`, "home the cutter". Every job now
runs: mat check → home (`model.homeCommand`, `TT` for the Cameo 3, then wait until ready) → setup
→ registration → cut. There's also a **Home** button, and `?homeCmd=TT|H|none` in case the
Cameo 3 ignores `TT`. This is the one deliberate difference from upstream's transcript in the
golden test. Homing from the wrong origin might also explain the half-size cut; unconfirmed.

**Follow-up:** `TT` did nothing visible on the real Cameo 3, so homing is now off by default
(`homeCommand: null`; the golden test matches upstream exactly again) and the Home button only
shows when `?homeCmd=` picks a command. New clue: the AutoBlade depth taps (which should land in
the holes on the left of the deck) land about an inch to the right, on the paper, so the cutter's
position reference is off by about an inch. To bisect this on hardware without a code round trip
per guess, `?debug=1` adds a raw-command console (`CutterSession.sendRaw`, logged). The experiment
list is in `docs/cutter-setup.md`.

**Root cause of the drifting taps (likely).** Hardware result: right after connecting, the AutoBlade
tapped into its adjust holes correctly; the next job in the same connection was about 1/4 in too far
right, and the offset kept growing across jobs. inkscape-silhouette runs `setup()` → `initialize()`
(`ESC EOT`, `FG`, `TB71`, `FA`, `TC`) at the start of every job, because each run is a fresh
process. We only did it once, on connect, so every later job inherited position state from the
previous one (plausibly the registration-mark origin). `CutterSession.run` now re-initializes first.
Each job's command stream is now byte-for-byte one upstream run: the golden test compares a job's
stream alone, and a new test checks that back-to-back jobs each start with `ESC EOT`. This also
corrects the earlier guess that `ESC EOT` re-zeroes coordinates at the carriage's current position:
the reset is what makes the first job right.

**Fresh mat load before each print-and-cut job.** After the per-job reset, the taps were right
(10 in a row) but the mark scan got worse on every run. It barely pulled the paper in and failed at
the first mark, on default settings. Diagnosis: the reset re-references the paper axis to wherever
the mat currently is. Only loading measures the real paper edge. Two things leave the mat away from
its loaded position: our end-of-job park (mark-relative `M0,0` = the mark origin, about 1 cm down
the sheet) and a failed or aborted job. So each later search started further down, past the first
mark. `CutterSession` now tracks `matMoved`. It's set once a job starts sending commands, and by
Home and raw commands. A job with registration marks then first waits (up to 5 min) for the
cutter's status to go unloaded (`2`) and then ready (`0`), before its reset. Cut-only test cuts
are exempt. This matches the real workflow: new printed sheet, new load.

**Reset with the mat out, and retry the scan.** Requiring a reload didn't help: the scan still
started near the paper's top edge. Timeline of the hardware tests:
- First test: the only reset was on connect, likely before loading. The marks were found.
- Per-job reset after load: the scan went wrong.
- Reload, then reset after load: still wrong.

So on the Cameo 3 a reset with the mat **in** re-zeroes the paper axis at the mat's loaded
position, which is higher than where the scan needs to start. inkscape-silhouette resets after load
too; this may be what its issue #82 describes. The reset is still needed for the carriage (X)
reference, as the tap drift showed. Print-and-cut jobs now do: unload (if the mat is in) → reset →
load → setup → scan. `resetWithMatOut` is armed by the connect-time status check (mat out when
connecting) and disarmed by any job, Home or raw command. Test cuts keep reset-after-load, since
only X matters there. The golden test is back to comparing connect + job against one upstream run.

`TB123` is one-shot, so `searchWithRetries` re-sends it with its start moved down the sheet by
`model.regmarkSearchStepsMm` (Cameo 3: 0, 3, 5, 7 mm). The retries apply only to "not found" and
the 40 s timeout. There are two new tuning switches: `?scanOffset=` (base start offset) and
`?scanSteps=`.

**Idle mat watch.** The previous version made the user click Send before loading, which was
backwards. `CutterSession.startMatWatch()` now polls the status every 1.5 s while idle. The polls
are quiet (`LoggingTransport.quietly`) and in/out changes are logged as notes. The moment the mat
comes out, it resets the cutter (arming `resetWithMatOut`). So the normal flow works: unload the
finished sheet, load the next, send, with no prompts. Jobs, Home and raw commands wait for an
in-flight poll to finish before starting (`acquire`). The in-job unload → reset → load prompts
remain only as the fallback for connecting with the mat already in. The status line shows the
mat state.

**"Take the mat out" loop.** On hardware, the in-job unload prompt never finished. Most likely the
Cameo 3 doesn't report `2` (upstream's "unloaded") when its mat is out. Upstream only knows 0, 1
and 2 and aborts a job on anything else. The prompt now has a **The mat is out — continue** button
(`CutterSession.confirmMatOut`), so a wrong or unknown status can't trap the user. The raw status
replies during that wait are in the log. Once the user's log shows the real code, it goes into
`parseStatus` so both the prompt and the idle mat watch recognise it automatically.

**Print-and-cut working on hardware.** With reset-with-the-mat-out and scan retries, the Cameo 3
found the marks on the second attempt (3 mm further down) and cut the calibration target "almost
perfectly". The half-size cut is gone, so it came from the same wrong position reference and not
from the `TB123` argument order: the default `height_width` is confirmed. The failed first attempt
left an error on the cutter's own display, so the Cameo 3 now starts its scan 3 mm lower
(`regmarkScanOffsetMm: 3`) and retries in 2 mm steps (`[0, 2, 4, 6]`). The golden test compares
against upstream with a zero offset. Still open: the Cameo 3's real "mat out" status code (needs a
log), and tuning the sticker-paper blade settings.

**Incident: carriage crash, and the mat-state work removed.** The Cameo 3 (firmware V1.40) log
showed status `0` ("ready") on every poll, including with the mat out. The mat-state features of
the last few iterations all rested on status `2` meaning "mat out", which this cutter never
sends:
- require a fresh load;
- reset with the mat out, then load;
- the idle mat watch;
- the "mat is out — continue" button.

Through that button, the unload → reset → load flow then drove the cutter with **no mat**. After
the reset, "wait for the mat to be loaded" passed instantly on the bogus `0`, so setup and the mark
scan ran on an empty cutter. It ejected the paper and ran the carriage into the right side. The
user then pressed the button with the mat still **in**, i.e. reset with the mat loaded, and the job
worked perfectly with the scan starting 3 mm lower. So the earlier "reset with the mat out" theory
was wrong, drawn from runs that also had the scan-start problem.

Removed: all of the mat-state machinery above (`resetWithMatOut`, `startMatWatch`,
`confirmMatOut`, `waitForStatus`, `LoggingTransport.quietly`, the mat-out button and the mat
in/out status line).

What remains is the sequence that worked: status check → reset (`ESC EOT` with the mat loaded,
every job) → setup → mark scan (3 mm lower, 2 mm retries) → cut → park. The status check stays but
is documented as unable to detect a missing mat. The UI and docs tell the user to load the mat
before sending.

Lesson: don't build flows that move hardware on a status signal that hasn't been confirmed on the
device. Read the log first.

**Second crash: registration is unreliable run to run.** A real sheet job (a 50 mm square at sheet
(30,30) mm, printed on plain paper) found the marks at the first try. The cutter then cut a
~38 × 13 mm rectangle far too high, partly off the paper, and the user cut the power. The user's
PDF confirms the layout (marks at the standard positions, outline at 30–80 mm), and the log
confirms the commands (mark-relative 20–70 mm = 400–1400 SU). So the app's geometry was right and
the cutter's own registration transform was wrong. The calibration cut, through the same code
path, had been spot on. The cause is unknown: no artwork could have been mistaken for a mark. Next
step is diagnosis without risk. **Dry run** (`CutJob.dryRun` → `pathCommands(..., bladeUp)`)
runs the full job but turns every draw into a move, so the user can watch where the cutter
thinks the outlines are. The docs now also say plainly that Abort can't be relied on to stop a
buffered job: switch the cutter off.

**Merged `master`** (sharp-corners toggle, native Print replacing Download PDF, corner-only
registration keep-outs, README, GitHub Pages). Integration fixes:
- The calibration sheet now prints through `printSvg` instead of the removed PDF export.
- A print-only `.sheet-paper { fill: white !important }` rule keeps the dark-mode grey preview
  page off paper. The on-screen rule is also scoped to `#viewportInner`, and `#printArea` sits
  outside it.
- With marks on, packing keeps at least `REGMARK_ORIGIN_MM + 2` (12 mm) from the edges
  (`packingMarginMm()`). Master's 8 mm margin would put stickers outside the area the cutter can
  cut after registration (between the marks, 10 mm in), and every print-and-cut job would fail
  with "outside the cutter's allowed area".
- The dev URL moved to `/shadow-garage/` (Vite `base`).

**Paper types choose cut settings.** Each `PaperType` now carries its `cutMaterial`, and jobs use
the selected type's instead of a hard-coded preset. The types are shown in two groups, "Adhesive
sticker sheets" (names now end in "sticker") and "Plain paper (no adhesive)". There's a new
**20 lb printer paper** type: `PRINTER_PAPER_20LB` with pressure 10, speed 5, AutoBlade 2. It's
based on inkscape-silhouette's "Print Paper Light Weight" (media 132, pressure 5), with pressure
raised and the blade deeper so it cuts through rather than scoring, and speed lowered because
speed 10 / pressure 20 tore plain paper on the Cameo 3. All sticker types share `STICKER_PAPER`
(renamed from `WHITE_STICKER_PAPER`). The Cutter panel shows the active settings.

**Trimmed paper types** to White sticker, Clear sticker and 20 lb printer paper. Holographic,
Matte black and Glossy silver only differed by the border colour, and that colour was printed: a
fake lavender, black or grey border inked over the real material. They're removed.

**Slower cutting, printable cut lines, packet markers.** The user saw layer shifts and reported
the Cameo 3 "binding up". A stalled carriage loses steps, so everything after it shifts. Default
speeds are halved: sticker 10 → 5, printer paper 5 → 3. A **Speed** slider in the Cutter panel
overrides the paper type's speed (`state.cutSpeed`, reset when the paper type changes). The golden
test pins speed 10 to match upstream's media-134 run. Print now leaves out the red cut lines
unless **Print cut lines** is ticked (`buildSheetSVG`/`buildSingleStickerSVG` take
`includeCutLines`); Download SVG always keeps them. The log marks where each cut packet starts
(`CutProgress.onPacket`), to check whether a shift lines up with one. `docs/cutter-setup.md` has
an "If part of a job shifts" guide.

**Dry run fix.** On the Cameo 3 a dry run traced only the first outline. The whole job went as one
packet of back-to-back `M` moves; the cutter reported ready after ~2 s and silently dropped the
rest, although draw packets of the same size run fine. Dry runs now send one move per write and
wait for the carriage between moves. To keep that affordable, each outline is simplified to 1 mm
for the dry run only (`DRY_RUN_TOLERANCE_MM`). A 43-sticker traced sheet went from 7,761 moves to
1,099. Real cuts are unchanged.

**Pause on the cutter, pressure slider, quieter log.** Dry run then traced all 11 squares, but the
real cut on 20 lb printer paper (pressure 10, speed 3, blade 2) skipped about two stickers down
and the user paused it on the Cameo 3's screen. While paused the cutter answers status `3`, which
upstream doesn't know; it's now `"paused"`, shown as its own phase ("press Resume on its screen,
or Abort here") and logged once on pause and once on resume. `waitForReady` also only times out
after `timeoutMs` without progress: before, its 120 s deadline counted time spent moving, and that
job's single packet already took 80 s, so a slower or bigger job would have failed mid-cut. The
dry run over the same paths was clean, so the skipping points at blade drag: printer paper drops
to pressure 6 (upstream uses 5), and a **Pressure** slider overrides the paper type's pressure like
the Speed slider does. The log now collapses back-to-back identical status polls into one
"status 1 repeated N more times over T s" line; an 80 s packet had added ~1,500 poll lines.

**Tuned printer paper.** On a Cameo 3, 20 lb printer paper cut cleanly at pressure 1, speed 2
(blade 2). (A pressure-sweep test cut was tried and removed once 1 / 1 proved right for every
paper type.)

**Per-sticker margin; minimum cut defaults.** Offset margin ("space around artwork") and Preserve
sharp corners are now stored on each `StickerDesign`. The controls edit the selected sticker (the
block title names it when there's more than one), and a new sticker starts from the last values
chosen (`state.marginMm` / `state.preserveSharpCorners`). Every cut material now defaults to
pressure 1, speed 1, confirmed on a Cameo 3; the golden test pins upstream's 20 / 10 explicitly.

## 12. Send to cutter over Bluetooth Classic (Cameo 3, Web Serial) — built, not yet hardware-verified

Adds a second way to connect to the same Cameo 3: Bluetooth Classic (RFCOMM) through the Web Serial
API, next to the existing WebUSB path. Everything above the byte pipe (`graphtec.ts`, `session.ts`,
`job.ts`, the Cutter panel's job flow) stays the same. This is the "v2" that §11 and
`transport.ts`'s header comment already anticipate.

**Decisions:**
- **Bluetooth Classic only, Cameo 3 only.** The Cameo 3 speaks GPGL over RFCOMM. BLE (the vendor GATT
  service used by the Cameo 4/5 and Portrait 3+, documented in upstream's `BLETransport.py`) is a
  separate Web Bluetooth transport and is left out: there's no hardware to test it on, and those
  models aren't in `models.ts` yet.
- **macOS and Linux.** Both already work over USB; Bluetooth adds a cable-free option. Windows isn't
  a target. It will probably work, since Chrome's RFCOMM support is on all desktop platforms, but it
  isn't tested or advertised, and the USB note in `usbAccessHint` stays as it is.
- **Chrome/Edge 117+ only.** That's when Web Serial gained RFCOMM (`allowedBluetoothServiceClassIds`;
  Chrome 130 added `connected` on Bluetooth ports). Firefox and Safari have no Web Serial.
- **The OS does the pairing.** Web Serial only sees devices that are already paired. The app tells
  the user to pair first; it doesn't try to discover devices.
- **Same hardware rules as USB.** Every §11/§11a constraint still applies unchanged over Bluetooth:
  reset with the mat loaded at the start of every job, one blade-up move per write on dry runs,
  mark-search retries, low speeds, and status polling between packets.

### 12a. Step 0 — hardware spike (do this before writing the transport)

These unknowns decide the design. Answer them with a throwaway page in `?debug=1` mode, or from the
DevTools console on the dev server:
1. **Service class id.** Does the Cameo 3 advertise the standard SPP UUID
   (`00001101-0000-1000-8000-00805f9b34fb`) or a vendor UUID? Upstream skips SDP and connects to
   raw channel 1, so it never had to find out. On Linux, `sdptool browse <addr>` (or `bluetoothctl info`)
   lists the UUIDs. In Chrome, try `requestPort({ allowedBluetoothServiceClassIds: [SPP] })` and check
   whether the paired cutter appears in the picker.
2. **macOS path.** Check whether the port Chrome offers is its native RFCOMM port (`getInfo()` returns
   `bluetoothServiceClassId`) or a `/dev/cu.*` node that macOS created (no `getInfo()` ids). Both can
   be opened; the difference only matters for how we filter and reconnect.
3. **Pairing.** Note whether a PIN is needed (and which one), and whether the cutter shows anything on
   its screen.
4. **Firmware reply.** Record what `FG` returns over Bluetooth, e.g. `CAMEO3 V1.xx`. This is how the
   model is identified, because Bluetooth has no USB ids. Upstream matches on the prefix `CAMEO3`.
5. **Throughput and write size.** Send the golden-test job's command stream. Watch for dropped bytes
   with big writes, and compare a packet's wall-clock time with USB. If data goes missing, reduce the
   write chunk size until it stops.
6. **Status polls.** Check that `ESC ENQ` replies arrive complete and ETX-terminated, possibly split
   across chunks. `readReply` already joins split chunks.
7. **Disconnects.** Power-cycle the cutter mid-idle, and walk out of range, and record what the
   `ReadableStream` reader and the port's `disconnect` event do.

Record the answers in a new §12b before building.

### 12c. Build steps

1. **Types.** Add `@types/w3c-web-serial` to devDependencies (it's not in TS's DOM lib yet). Check
   that it includes `allowedBluetoothServiceClassIds` / `bluetoothServiceClassId`; if not, add a
   small ambient `.d.ts`.
2. **`models.ts`.** Replace the `bluetooth?` placeholder with
   `bluetooth?: { rfcommServiceClassId: string; firmwarePrefix: string }` and fill it in for the Cameo 3
   from the spike (e.g. SPP UUID, `"CAMEO3"`). Add `modelForFirmware(fg)` (case-insensitive prefix
   match, like upstream's `_match_bluetooth_hardware`) and `bluetoothServiceClassIds()` for the picker
   filters. Unit tests: `"CAMEO3 V1.05"` → Cameo 3, and an unknown string → undefined.
3. **`webSerialTransport.ts`** (new, mirrors `webUsbTransport.ts`):
   - `WebSerialTransport implements Transport`. It opens the port with `port.open({ baudRate: 115200 })`
     (RFCOMM ignores the rate, but it's required), then one read loop pulls chunks from
     `port.readable.getReader()` into a `ByteQueue`. Unlike WebUSB this read *could* be cancelled,
     but using the same queue keeps `read()`/`drain()` semantics identical for the protocol.
   - `write()` goes through one long-lived writer and splits writes at `WRITE_CHUNK_BYTES` (4096 to
     start, lowered if the spike finds drops).
   - `close()` releases the reader lock via `reader.cancel()` and the writer via `writer.releaseLock()`,
     then `port.close()`. Stream errors and the port's `disconnect` event call
     `queue.fail(new TransportClosedError(...))`, so a lost link surfaces the same way an unplug does.
   - `label`: "Cameo 3 (Bluetooth)" once identified. Before that, "Bluetooth serial port".
   - `webSerialSupported()`, `requestBluetoothCutter()` (picker filtered by service class id,
     `allowedBluetoothServiceClassIds` set), and `reconnectBluetoothCutter()` (`navigator.serial.getPorts()`
     filtered the same way, skipping ports whose `connected` is false).
   - Access hints: the port isn't listed → "Pair the cutter in System Settings / bluetoothctl first,
     then reload"; open fails → "Silhouette Studio or another app may hold the connection; turn the
     cutter's Bluetooth off and on".
4. **Model identification.** Web Serial gives no USB ids, so the model comes from the firmware reply.
   Add an optional `CutterSession.open(transport, model | "identify")` path. It runs the protocol's
   `initialize()` with a provisional Graphtec model, calls `modelForFirmware()` on the reply, and
   fails with "Connected, but this cutter (FG reply) isn't supported" if nothing matches. Keep the
   provisional model's use limited to reset + `FG`, and apply `withDiagnosticOverrides` after the
   model is resolved. Test this with `FakeTransport` + `cameo3Responder`.
5. **UI (`index.html` / `main.ts`).** Split Connect into **Connect USB** and **Connect Bluetooth**,
   each shown only when its API exists (`webUsbSupported()` / `webSerialSupported()`). Disconnect
   stays one button. `state.cutter` records which link is in use, and the status line shows it
   (`Cameo 3 · Bluetooth · <firmware>`). The auto-reconnect on page load (`main.ts` ~1314) tries USB,
   then Bluetooth. The "Requires Chrome or Edge on desktop" message only appears when neither API
   exists.
6. **Logging.** Note the transport and the port's `getInfo()` in the connect line, so a pasted log
   shows which link was used. `LoggingTransport` needs no other changes.
7. **Timeouts.** Watch whether Bluetooth latency hurts the 50 ms status poll or the 5 s status timeout.
   If the spike shows slow replies, add a per-transport `latencyHintMs` rather than raising the USB
   timeouts.
8. **Docs.**
   - `docs/cutter-setup.md` gets a "Bluetooth (macOS / Linux)" section: pair in the OS, click Connect
     Bluetooth, and a troubleshooting note for Silhouette Studio holding the link.
   - The Windows paragraph's "Bluetooth support (planned) won't have this problem" is reworded,
     because Windows isn't a target.
   - `CLAUDE.md`'s cutter-stack bullet gets `webSerialTransport.ts`, and `transport.ts`'s header
     comment is updated.

### 12d. Tests

- `webSerialTransport.test.ts`: a fake `SerialPort` backed by an in-memory `ReadableStream` /
  `WritableStream`. Check chunked writes, reads across chunk boundaries, `drain()`, a stream error
  becoming `TransportClosedError`, and that `close()` is idempotent.
- `models.test.ts`: `modelForFirmware` and the service-class filters.
- `session.test.ts`: the identify-by-firmware path, for both a supported and an unsupported reply.
- The golden test in `graphtec.test.ts` doesn't change: command output is transport-independent.

### 12e. Hardware acceptance (Cameo 3, macOS then Linux)

1. Pair, then Connect Bluetooth: the status line shows the firmware; reloading the page reconnects
   without a picker.
2. Calibration cut, then a dry run of a multi-sticker sheet: every outline is traced, and no moves
   are dropped.
3. A real print-and-cut on sticker paper at the tuned 1/1 settings: marks are found and cuts line up
   with the USB result.
4. Pause and resume from the cutter's screen, and Abort from the app.
5. Turn the cutter off mid-idle: a clear "lost connection" error, and Connect works again after
   power-on.
6. Copy log: compare packet timings with a USB run of the same sheet.

**Open questions:** the RFCOMM service class id and the macOS port path (§12a items 1–2, which
decide the filters and reconnect), and whether a smaller write chunk is needed (item 5).

### 12f. As built

The build went ahead before the §12a spike, so every open answer can be overridden or is recorded:
- **Service class id** defaults to SPP (`SERIAL_PORT_PROFILE_UUID` in `models.ts`). `?btService=<uuid>`
  asks for another one, and `?btAnyPort=1` opens the picker unfiltered (for a macOS `/dev/cu.*` port).
  The connect log line records which kind of port was opened (`describePort`).
- **Model identification** (`CutterSession.openAndIdentify`, `modelForBluetoothFirmware`): the
  handshake runs with the Cameo 3 as a provisional model, then the FG reply picks the real one by
  prefix (`CAMEO3` / `CAMEO 3`). The fake device answers `CAMEO V1.10`, so the Cameo 3's real reply may
  not name the model. When nothing matches and only one model has Bluetooth, that model is assumed,
  and the log says so. Tighten this once a real Bluetooth FG reply is known.
- **Write chunk** stays at 4096 bytes (`WRITE_CHUNK_BYTES` in `webSerialTransport.ts`); lower it if
  §12a item 5 finds dropped bytes.
- **UI:** Connect became **Connect USB** plus **Connect Bluetooth** (each shown only if its API
  exists); the one Disconnect button covers both. The status line shows the link. There's no
  auto-connect on page load, same as USB; Connect Bluetooth reuses a granted port without a picker.
- **Disconnects:** the port's `disconnect` event aborts the job and shows "Lost the Bluetooth
  connection"; stream errors also fail pending reads with `TransportClosedError`.
- **Tests:** `webSerialTransport.test.ts` covers chunked writes, reads, drain, link loss, close order,
  and firmware identification (a supported reply, a guessed one, and an unsupported one).
- §12e hardware acceptance is still to do. Fill in §12b from the first Bluetooth connect's
  **Copy log**.

### 12g. First hardware try: BLE, not RFCOMM

On a Cameo 3 paired with macOS, the SPP-filtered Web Serial picker found nothing. macOS did create
`/dev/cu.CAMEO3-30411C`, but the cutter stayed silent on it, even to `ESC ENQ` / `FG` sent straight
from a terminal with Chrome out of the way, USB unplugged and Silhouette Studio closed. macOS lists
the cutter's services as `GATT ACL`, with no serial port. So **Connect Bluetooth now uses Web
Bluetooth** (`webBluetoothTransport.ts`), following upstream's `BLETransport.py`:
- vendor service `e2088282-…`: write `6d92661d-…`, reply notifications `8dcf199a-…`, and movement
  notifications `61490654-…`, which are subscribed but kept out of the reply stream;
- init handshake `ESC EOT` written to all three characteristics, then 1 s to settle;
- 20-byte acknowledged writes, with up to 3 retries while the cutter reports busy.

Chrome's picker filters on the service or a `CAMEO`/`PORTRAIT`/`CURIO` name prefix. Connecting
worked once the cutter was paired with macOS and woken from sleep; an asleep cutter neither appears
nor answers. The docs and panel tell users to pair first. The advertised name (`CAMEO3-…`) also identifies
the model when the FG reply doesn't. The Web Serial path stays, behind `?btSerial=1`. A failed
connect now leaves **Copy log** usable (`OpenOptions.onLog`).

Not yet confirmed: whether the Cameo 3 exposes this service at all (upstream verified it on the
Cameo 4/5), and how long a sheet takes to send at 20 bytes per acknowledged write.
