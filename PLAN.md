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
