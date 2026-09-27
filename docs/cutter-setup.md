# Cutting directly from the browser

Shadow Garage can send a sheet straight to a **Silhouette Cameo 3** over USB — no Silhouette
Studio needed. It uses WebUSB, so it needs **Chrome or Edge on desktop** (Firefox and Safari don't
implement WebUSB). The page must be served over HTTPS or from `localhost`.

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
2. Download the PDF and print it at **100% / Actual size**. Any printer scaling moves the stickers
   relative to the marks and the cut will miss.
3. Put the printed sheet in the **top-left corner** of the 12×12 in mat and load the mat.
4. Click **Connect**, then **Send to Cutter**. The cutter scans for the marks first; if it can't
   find them, nothing is cut.

**Test cut** cuts a 10 mm square near the top-left corner without looking for marks — use a scrap
sheet to check the blade settings before cutting a printed sheet.

**Abort** stops sending and resets the cutter.

## Current limitations

- Not yet verified on real hardware. The command stream matches what inkscape-silhouette sends a
  Cameo 3 byte for byte (see `src/lib/cutter/session.test.ts`), but the sticker-paper pressure,
  speed and blade depth (`src/lib/cutter/materials.ts`) are upstream's defaults and still need
  tuning for a clean kiss cut.
- Letter and A4 sheets only — A3 doesn't fit on the 12×12 mat.
