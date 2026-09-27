# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shadow Garage is a browser-only app (vanilla TypeScript + Vite, no framework, no backend) that
turns images into print-and-cut sticker sheets. It traces a die-cut outline, packs stickers onto
a sheet with Silhouette-style registration marks, prints or exports SVG, and can drive a
Silhouette Cameo 3 directly over WebUSB. It's deployed to GitHub Pages at
`https://spuder.github.io/shadow-garage/` on every push to `master` (`.github/workflows/deploy.yml`).

## Commands

```sh
npm run dev -- --port 5183 --strictPort   # dev server (matches .claude/launch.json)
npm test                                  # vitest run (all tests)
npx vitest run src/lib/cutter/graphtec.test.ts   # one file
npx vitest run -t "dry run"               # tests whose name matches
npx tsc --noEmit                          # typecheck only
npm run build                             # tsc + vite build → dist/
```

There's no linter; `tsc` is strict about unused locals and parameters, so it serves as the lint
step. Vite's `base` is `/shadow-garage/`, so the dev URL is
`http://localhost:5183/shadow-garage/`, not the root. WebUSB needs a secure context, and
`localhost` counts as one.

## Architecture

**Image → sheet pipeline (`src/lib/`)**, all in millimetres:
- `trace.ts` builds an alpha mask, dilates it (which adds the margin and merges nearby pieces such
  as separate letters), labels connected components, traces boundaries and smooths them. Interior
  holes are intentionally left uncut.
- `design.ts` fits the contours to the requested physical size exactly.
- `sheet.ts` packs stickers (`packMixedSheet`) around keep-out rects.
- `regmarks.ts` is the single source of truth for mark geometry. `regmarkLayout()` is used both to
  draw the marks and by the cutter's mark search, so the two must never diverge.
- `svgBuilder.ts` renders the SVG. Print artwork and red cut lines are kept in separate groups,
  and cut lines can be omitted for print (`includeCutLines`).
- `print.ts` prints by swapping the SVG into `#printArea` and relying on the `@media print`
  rules in `style.css`.

**`src/main.ts`** holds all UI: one mutable `state` object, a `recompute()` → `render()` cycle,
and the camera/pointer handling (pan, zoom, corner-drag resize, via `camera.ts`) plus the Cutter
panel. `index.html` holds the static DOM that `main.ts` looks up by id.

**Cutter stack (`src/lib/cutter/`)** is layered so that new models and manufacturers are mostly
data:
- `transport.ts` + `webUsbTransport.ts` are a byte pipe. WebUSB `transferIn` can't be cancelled,
  so one read loop feeds a `ByteQueue`. `LoggingTransport` records traffic for the in-app
  **Copy log** button.
- `protocol.ts` defines the interface. `graphtec.ts` implements Silhouette GPGL as pure command
  builders plus a `GraphtecProtocol` class. It is modelled on inkscape-silhouette's `Graphtec.py`
  (studied, not vendored). Device coordinates are 20 steps/mm with the X and Y axes swapped.
- `models.ts` is the device registry (USB ids, bed/mat size, mark-search quirks), and
  `materials.ts` holds cut presets. `paperTypes.ts` maps each UI paper type to a cut material.
- `job.ts` turns sheet items into closed, ordered, overcut polylines. `layoutJob()` maps sheet mm
  to device mm (relative to the marks when marks are on).
- `session.ts` (`CutterSession.run`) is the per-job sequence: wait for ready → reset
  (`initialize`) → setup → mark search with retries (or manual jog) → cut in packets, polling
  status between them → park.

## Cutter constraints learned on real hardware

These are recorded in `PLAN.md` §11/§11a and `docs/cutter-setup.md`; don't undo them without
hardware evidence:
- The Cameo 3 always reports status "ready", even with no mat loaded, so the app cannot detect the
  mat. Any flow that relies on seeing "unloaded" will drive the carriage with no mat and crash it.
- The reset must be sent **with the mat loaded, at the start of every job**. That's what keeps
  AutoBlade depth taps aligned.
- The firmware silently drops long runs of back-to-back blade-up moves in one packet, so dry run
  sends one move per write and waits between moves.
- The mark scan is one-shot on the device, so the app retries it from offset positions
  (`regmarkScanOffsetMm`, `regmarkSearchStepsMm`).
- High speeds bind the carriage and cause layer shifts, so material speeds are deliberately low.
- Status `3` means paused from the cutter's own screen. `waitForReady` only times out after
  `timeoutMs` with no progress (moving or paused resets it); one packet of a slow cut can take
  well over a minute.
- Excess blade pressure drags the mat and makes it skip, even when a dry run of the same sheet is
  clean. Prefer the lowest pressure that cuts through; the Pressure/Speed sliders override
  `materials.ts` per job.

## Testing the cutter without hardware

- `fakeTransport.ts` provides `FakeTransport` and `cameo3Responder`, a scripted device used by the
  session tests.
- `graphtec.test.ts` includes a golden test that compares the full command stream with
  inkscape-silhouette's dry-run transcript. If you change command output, keep that test passing
  or update it deliberately.

## Diagnostic URL switches

These are read in `main.ts` and documented in `docs/cutter-setup.md`:
- `?debug=1` adds a raw-command console.
- `?regmarkArgs=width_height|height_width` sets the mark-search argument order.
- `?homeCmd=…` sets the home command.
- `?scanOffset=N` sets the scan start offset in mm.
- `?scanSteps=0,2,4` sets the scan retry positions.

## Styling notes

- The theme is dark by default (`theme.ts`, CSS variables in `style.css`).
- On screen, the sheet's paper is grey in dark mode (`.sheet-paper` inside `#viewportInner`), but
  print rules force it back to white. Anything added to the sheet SVG must stay white/black/red
  when printed.
