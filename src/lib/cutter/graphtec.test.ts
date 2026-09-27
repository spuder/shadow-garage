import { describe, expect, it } from "vitest";
import { SHEET_SIZES } from "../sheet";
import { chunkFrames, frameCommands, homeCommands, manualRegmarkCommand, mmToSU, moveCommand, parseStatus, pathCommands, regmarkCommands, setupCommands } from "./graphtec";
import { layoutJob, testSquarePaths } from "./job";
import { STICKER_PAPER } from "./materials";
import { modelById } from "./models";
import { CutOutOfBoundsError, type CutFrame } from "./protocol";

const cameo3 = modelById("silhouette-cameo3")!;
const letter = SHEET_SIZES.find((s) => s.name === "Letter")!;
const noOffset: CutFrame = { offsetXmm: 0, offsetYmm: 0, clip: { minX: 0, minY: 0, maxX: 100, maxY: 100 } };

describe("mmToSU", () => {
  it("uses 20 units per mm", () => {
    expect(mmToSU(10)).toBe(200);
    expect(mmToSU(304.8)).toBe(6096);
  });

  it("rounds half to even, like Python's round()", () => {
    expect(mmToSU(0.125)).toBe(2); // 2.5 -> 2
    expect(mmToSU(0.375)).toBe(8); // 7.5 -> 8
    expect(mmToSU(-0.125)).toBe(-2);
  });
});

describe("command framing", () => {
  it("terminates every command with ETX", () => {
    expect(Array.from(frameCommands(["FG", "J1"]))).toEqual([0x46, 0x47, 0x03, 0x4a, 0x31, 0x03]);
  });

  it("chunks on command boundaries only", () => {
    const bytes = frameCommands(Array.from({ length: 500 }, (_, i) => `D${i},${i}`));
    const chunks = chunkFrames(bytes, 64);
    expect(chunks.every((c) => c.length <= 64 && c[c.length - 1] === 0x03)).toBe(true);
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(bytes.length);
    expect(new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => Array.from(c))))).toBe(new TextDecoder().decode(bytes));
  });
});

describe("Cameo 3 command sequences", () => {
  it("sets up the 12x12 mat, AutoBlade in holder 1 and the sticker-paper preset", () => {
    expect(setupCommands(cameo3, STICKER_PAPER)).toEqual([
      "TG1",
      "FN0",
      "TB50,0",
      "\\0,0",
      "Z6096,6096",
      "J1",
      "!10,1",
      "FX20,1",
      "FE0,1",
      "FF1,0,1",
      "FF1,1,1",
      "FC0,1,1",
      "FC18,1,1",
      "TF1,1",
    ]);
  });

  it("clamps material values to the model's ranges", () => {
    const cmds = setupCommands(cameo3, { ...STICKER_PAPER, pressure: 99, speed: 0, autoBladeDepth: 42 });
    expect(cmds).toContain("FX33,1");
    expect(cmds).toContain("!1,1");
    expect(cmds).toContain("TF10,1");
  });

  it("searches for the marks exactly where the Letter PDF prints them", () => {
    const { regmarks } = layoutJob(letter, cameo3, "standard");
    // marks 195.9 x 259.4 mm apart, search starting 10mm before the 10mm mark origin
    expect(regmarkCommands(regmarks!)).toEqual(["TB50,0", "TB99", "TB52,2", "TB51,400", "TB53,10", "TB55,1", "TB123,5188,3918,0,0"]);
  });

  it("can send the mark distances width-first", () => {
    const { regmarks } = layoutJob(letter, cameo3, "standard");
    expect(regmarkCommands(regmarks!, "width_height").at(-1)).toBe("TB123,3918,5188,0,0");
    expect(manualRegmarkCommand(regmarks!, "width_height")).toBe("TB23,3918,5188");
    expect(manualRegmarkCommand(regmarks!)).toBe("TB23,5188,3918");
  });

  it("moves with axes swapped", () => {
    expect(moveCommand(10, 25)).toBe("M500,200");
  });

  it("swaps axes: M/D take (down, across)", () => {
    expect(pathCommands(testSquarePaths(15, 15, 10, 0), noOffset)).toEqual(["M300,300", "D300,500", "D500,500", "D500,300", "D300,300"]);
  });

  it("applies the frame offset (mark-relative coordinates)", () => {
    const frame: CutFrame = { offsetXmm: -10, offsetYmm: -10, clip: noOffset.clip };
    expect(pathCommands([[[40, 50], [45, 50]]], frame)).toEqual(["M800,600", "D800,700"]);
  });

  it("refuses points outside the clip area instead of clipping them", () => {
    expect(() => pathCommands([[[10, 10], [150, 10]]], noOffset)).toThrow(CutOutOfBoundsError);
  });

  it("parks the tool at the job start", () => {
    expect(homeCommands()).toEqual(["L0", "\\0,0", "M0,0", "J0", "FN0", "TB50,0"]);
  });

  it("decodes status replies, including padded ones", () => {
    expect(parseStatus("0")).toBe("ready");
    expect(parseStatus("    1")).toBe("moving");
    expect(parseStatus("2")).toBe("unloaded");
    expect(parseStatus("???")).toBe("unknown");
  });
});

describe("paper types", () => {
  it("each points at a cut material, and printer paper cuts through slower and deeper", async () => {
    const { PAPER_TYPES } = await import("../paperTypes");
    const { CUT_MATERIALS, PRINTER_PAPER_20LB, STICKER_PAPER: sticker } = await import("./materials");
    for (const pt of PAPER_TYPES) expect(CUT_MATERIALS).toContain(pt.cutMaterial);
    const printer = PAPER_TYPES.find((p) => p.id === "printer-paper-20lb")!;
    expect(printer.adhesive).toBe(false);
    expect(PAPER_TYPES.filter((p) => p.adhesive).every((p) => /sticker/i.test(p.name))).toBe(true);
    expect(setupCommands(cameo3, PRINTER_PAPER_20LB)).toEqual(expect.arrayContaining(["!5,1", "FX10,1", "TF2,1"]));
    expect(PRINTER_PAPER_20LB.autoBladeDepth).toBeGreaterThan(sticker.autoBladeDepth);
  });
});
