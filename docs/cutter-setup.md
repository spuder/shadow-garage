# Cutting directly from the browser

Shadow Garage can send a sheet straight to a **Silhouette Cameo 3 or 4** over USB or Bluetooth — no
Silhouette Studio needed. It uses WebUSB and Web Serial, so it needs **Chrome or Edge on desktop**
(Chrome 117 or newer for Bluetooth; Firefox and Safari implement neither). The page must be served over HTTPS or from `localhost`. Locally, `npm run dev -- --port 5183` serves it at
`http://localhost:5183/shadow-garage/` (the path matches the GitHub Pages deployment).

The AutoBlade is the only supported blade for now. The **Paper Type** you pick also picks the cut
settings (shown in the Cutter panel):

| Paper type | Cut | Pressure | Speed | Blade |
|---|---|---|---|---|
| Adhesive sticker sheets (white, clear) | kiss cut, backing left intact | 20 | 5 | 1 |
| 20 lb printer paper (no adhesive) | cut all the way through | 6 | 3 | 2 |

All of these are starting values, not yet tuned on hardware. Run **Test cut** on a scrap of the
same stock first. The **Speed** and **Pressure** sliders in the Cutter panel override the paper
type's values (they reset when you pick another paper type). Slower is safer: at speed 10 the
Cameo 3 bound up and shifted jobs. Use the lowest pressure that still cuts through: too much drags
the blade through the mat and makes the mat skip.

Pausing on the cutter's own screen is safe: the app shows the pause, waits for as long as it
lasts, and carries on when you press **Resume** (or press **Abort** in the app to stop).

## macOS

Nothing to install. Quit Silhouette Studio (it holds the USB connection), plug in the cutter, and
click **Connect USB**. For Bluetooth, see [Bluetooth](#bluetooth-macos-and-linux).

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
roll the driver back in Device Manager. Bluetooth isn't tested on Windows either.

## Bluetooth (macOS and Linux)

The Cameo 3 and 4 can also be driven over Bluetooth. This is new and not yet confirmed on hardware; USB
is the proven path.

1. Unplug the USB cable, quit Silhouette Studio, and turn on the cutter's Bluetooth.
2. **Pair the cutter with the computer first**: **System Settings → Bluetooth** on macOS, or
   `bluetoothctl` (`scan on`, `pair <address>`, `trust <address>`) on Linux. It shows up as e.g.
   `CAMEO3-30411C`. Wake the cutter first if it's asleep, or it won't appear or answer.
3. Load the mat, click **Connect Bluetooth**, and pick the cutter in Chrome's list. Next time the
   app reconnects without asking, as long as the cutter is on and in range.

This uses Bluetooth Low Energy (the cutter's Silhouette GATT service). Pairing the cutter with macOS
instead makes a `/dev/cu.CAMEO3-…` serial port, but a Cameo 3 didn't answer on it.

Everything else (print and cut, dry run, pause, abort) works as over USB, only slower to send. If
the cutter turns off or goes out of range, the job stops with a "lost the Bluetooth connection"
error; reconnect and run it again from the start.

**Bluetooth Classic (serial port) instead**, for diagnosing: `?btSerial=1` switches Connect
Bluetooth to Web Serial, which only sees cutters paired with the OS. `?btAnyPort=1` also lists every
serial port (pick the `cu.` port named after the cutter), and `?btService=<uuid>` asks for another
RFCOMM service class.

Either way, **Copy log** records which link was used and the cutter's firmware reply, even when the
connection fails. Please include it in a bug report.

## Print and cut

1. Lay out the sheet with **Registration Marks** on and the **Standard (3-mark)** style — the
   Cameo 3 can't read four-corner marks.
2. Click **Print** and print at **100% / Actual size**. Any printer scaling moves the stickers
   relative to the marks and the cut will miss. The red cut lines are left out of the print
   unless you tick **Print cut lines** (the downloaded SVG always has them).
3. Load it carefully. The mark scan only looks near where each mark should be, so small errors
   make it miss:
   - put the sheet in the **top-left corner of the mat grid**, square to the grid lines;
   - push the mat against the **left guide** as it loads;
   - the marks must print **solid matte black**.
4. **Load the mat first, then** click **Connect USB** (or **Connect Bluetooth**) and **Send to Cutter**. The Cameo 3 reports
   "ready" even with no mat loaded, so the app can't check for you. Never send with the mat out:
   the cutter will set up and scan anyway, and the scan can run the carriage into the side.
5. Every job resets the cutter (with the mat loaded), sets the blade, scans for the marks, then
   cuts. The scan is one-shot on the cutter. On a Cameo 3 it starts 3 mm lower than
   inkscape-silhouette's default; on a Cameo 4 it starts just below the square, the only place it
   was found to work (both tuned on hardware). If it misses, the app retries 2, 4 and
   6 mm further down before giving up. A miss leaves an error on the cutter's own screen even if a
   retry then succeeds; that's cosmetic.
6. Between sheets: unload, put the next printed sheet on the mat, load, send.

**Test cut** cuts a 10 mm square near the top-left corner without looking for marks — use a scrap
sheet to check the blade settings before cutting a printed sheet.

**Dry run** does everything a real sheet job does, including the mark scan, but traces each
outline with the blade **raised**. Use it before cutting: if the carriage doesn't follow the printed
outlines, don't cut. Stop the cutter and send the log. It sends one move at a time (the Cameo 3
drops long runs of queued moves) and simplifies each outline to within 1 mm, so it's slower than
a cut but stays a few minutes even for a full sheet.

**Abort** stops sending and sends the cutter a reset, but a small job is often already entirely in
the cutter's buffer, and it hasn't been confirmed that the reset stops the blade mid-cut. **If the
cutter is doing something wrong, switch it off.**

### If the marks still aren't found: manual registration (experimental)

After a failed scan, **Try manual registration** appears. Use the arrow pad (1 mm or 5 mm steps) to
move the blade over the corner of the top-left black square, then **Register here**. This hasn't
been confirmed on a Cameo 3 yet; if it doesn't work, please send the log.

## If part of a job shifts

A shift partway through a job means the cutter lost its position — everything after that point
is offset. The app sends absolute coordinates, so a software glitch would draw a stray line
rather than move everything after it.

1. **Which way did it move?** Sideways: the carriage lost position. Down the sheet: the mat
   slipped in the rollers.
2. **Slow down.** Every paper type defaults to speed 1, the minimum; if you raised the **Speed** slider, lower it and run again. Binding up at speed is the
   most common cause.
3. **Run Dry run** on the same sheet. The blade stays up, so nothing drags. If the trace is clean
   but the real cut skips, the blade is dragging: lower **Pressure** (every paper type already
   defaults to the minimum of 1, which cuts cleanly; if you raised it, step back down) and check
   with **Test cut** that it still cuts through. Also check the paper type matches the stock (**20 lb printer paper** for plain paper).
   If the dry run shifts too, look at the machine and mat.
4. **Check the mat:** still tacky, pushed against the left guide as it loads, gripped by both
   pinch rollers (the right roller set to the 12 in mat position), with clear space behind the
   cutter for it to travel.
5. **Send Copy log.** It marks where each packet of the job starts (`## packet 3/7 starts at …`),
   which shows whether a shift lines up with the start of a packet.

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
`?scanOffset=5` replaces the model's scan offset (how far down the sheet the scan starts), and
`?scanSteps=0,2,4,6` changes the retry positions. `?scanMargin=N` starts the scan N mm up and left
of the top-left mark: 10 is inkscape-silhouette's and the Cameo 3's, 0 the Cameo 4's.
Switches can be combined: `?regmarkArgs=width_height&scanOffset=5`. The log's first line shows which
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
- **Bluetooth** is for the Cameo 3 and 4; so far only a Cameo 4 has been driven over it (Bluetooth
  LE). Other models would need adding to `src/lib/cutter/models.ts` first.
- **Cameo 4** commands follow inkscape-silhouette's. Print-and-cut has been dry-run on one; real
  cuts aren't yet confirmed.
