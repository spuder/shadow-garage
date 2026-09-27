# Cutting directly from the browser

Shadow Garage can send a sheet straight to a **Silhouette Cameo 3** over USB — no Silhouette
Studio needed. It uses WebUSB, so it needs **Chrome or Edge on desktop** (Firefox and Safari don't
implement WebUSB). The page must be served over HTTPS or from `localhost`. Locally, `npm run dev -- --port 5183` serves it at
`http://localhost:5183/shadow-garage/` (the path matches the GitHub Pages deployment).

Only white sticker paper with the AutoBlade is supported for now.

## macOS

Nothing to install. Quit Silhouette Studio (it holds the USB connection), plug in the cutter, and
click **Connect**.

## Linux

Chrome needs permission to open the cutter's USB device. Add a udev rule:

```sh
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0b4d", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/99-silhouette.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then unplug and replug the cutter. Chrome detaches the kernel's `usblp` printer driver itself when
it connects. If connecting still fails, check that no other program (Silhouette Studio under Wine,
a print service) has the device open.

## Windows

Not supported yet. Windows attaches its USB printer driver (`usbprint.sys`) to the cutter, and that
blocks browser access. The only workaround is replacing the driver with WinUSB using
[Zadig](https://zadig.akeo.ie/), which may stop Silhouette Studio from seeing the cutter until you
roll the driver back in Device Manager. Bluetooth support (planned) won't have this problem.

## Print and cut

1. Lay out the sheet with **Registration Marks** on and the **Standard (3-mark)** style — the
   Cameo 3 can't read four-corner marks.
2. Click **Print** and print at **100% / Actual size**. Any printer scaling moves the stickers
   relative to the marks and the cut will miss.
3. Load it carefully. The mark scan only looks near where each mark should be, so small errors
   make it miss:
   - put the sheet in the **top-left corner of the mat grid**, square to the grid lines;
   - push the mat against the **left guide** as it loads;
   - the marks must print **solid matte black**.
4. **Load the mat first, then** click **Connect** and **Send to Cutter**. The Cameo 3 reports
   "ready" even with no mat loaded, so the app can't check for you. Never send with the mat out:
   the cutter will set up and scan anyway, and the scan can run the carriage into the side.
5. Every job resets the cutter (with the mat loaded), sets the blade, scans for the marks, then
   cuts. The scan is one-shot on the cutter. On the Cameo 3 it starts 3 mm lower than
   inkscape-silhouette's default (tuned on hardware), and if it misses, the app retries 2, 4 and
   6 mm further down before giving up. A miss leaves an error on the cutter's own screen even if a
   retry then succeeds; that's cosmetic.
6. Between sheets: unload, put the next printed sheet on the mat, load, send.

**Test cut** cuts a 10 mm square near the top-left corner without looking for marks — use a scrap
sheet to check the blade settings before cutting a printed sheet.

**Dry run** does everything a real sheet job does, including the mark scan, but traces each
outline with the blade **raised**. Use it before cutting: if the carriage doesn't follow the printed
outlines, don't cut. Stop the cutter and send the log.

**Abort** stops sending and sends the cutter a reset, but a small job is often already entirely in
the cutter's buffer, and it hasn't been confirmed that the reset stops the blade mid-cut. **If the
cutter is doing something wrong, switch it off.**

### If the marks still aren't found: manual registration (experimental)

After a failed scan, **Try manual registration** appears. Use the arrow pad (1 mm or 5 mm steps) to
move the blade over the corner of the top-left black square, then **Register here**. This hasn't
been confirmed on a Cameo 3 yet; if it doesn't work, please send the log.

## Checking print-and-cut alignment

1. Click **Print calibration sheet** and print at 100% on the paper size selected in the app.
   It has the registration marks and a 140 × 200 mm rectangle with a centre cross.
2. Load it as above, connect, and click **Calibration cut**.
3. The cut should follow the printed rectangle. If it doesn't, measure the **cut** rectangle's width
   and height, and how far its top-left corner is from the printed one.
4. Click **Copy log** and send the measurements together with the log. The log records every
   command sent to the cutter and every reply, including the registration step.

### Diagnostic switches

Graphtec.py sends the mark distances in the search command height first; a Silhouette Studio
trace suggests width first. To try the other order, open the app with `?regmarkArgs=width_height`
(for example `http://localhost:5183/shadow-garage/?regmarkArgs=width_height`), reconnect, and run the
calibration cut again. `?regmarkArgs=height_width` (the default) switches back.

Homing is off by default: `TT` (from Silhouette Studio's startup sequence) did nothing on a real
Cameo 3. `?homeCmd=H` tries GPGL's generic Home before every job and shows a **Home** button.
`?scanOffset=5` starts every mark scan 5 mm further down the sheet, and `?scanSteps=0,2,4,6`
changes the retry positions. Switches can be combined: `?regmarkArgs=width_height&scanOffset=5`. The log's first line shows which
settings were used.

### Diagnostics console

Add `?debug=1` to the URL to get a raw-command box in the Cutter panel. It sends one command per
line (`<ESC EOT>` and `<ESC ENQ>` for the two escape codes) and shows the cutter's reply;
everything also goes into **Copy log**. Only use it with a scrap sheet loaded — `D` commands cut.

**AutoBlade taps drifting off the adjust holes (fixed, pending confirmation).** The Cameo 3 sets
AutoBlade depth by tapping the blade into holes on the left of the deck. The first job after
connecting tapped in the right place, but later jobs in the same connection drifted right (up to
about an inch). Every job now starts by re-initializing the cutter, as inkscape-silhouette does. If
taps still drift, send the log from two back-to-back test cuts.

## Current limitations

- **No mat detection:** the Cameo 3 (firmware V1.40) answers "ready" whether or not a mat is
  loaded, so loading the mat before sending is up to you.
- The sticker-paper pressure, speed and blade depth (`src/lib/cutter/materials.ts`) are
  inkscape-silhouette's defaults and still need tuning for a clean kiss cut.
- Letter and A4 sheets only — A3 doesn't fit on the 12×12 mat.
