import { afterEach, describe, expect, it, vi } from "vitest";
import { SHEET_SIZES } from "../sheet";
import { cameo3Responder, FakeTransport } from "./fakeTransport";
import { layoutJob, testSquarePaths } from "./job";
import { STICKER_PAPER } from "./materials";
import { modelById } from "./models";
import { CutterCancelledError, RegmarkNotFoundError } from "./protocol";
import { CutterSession, type CutJob, type CutPhase } from "./session";

const cameo3 = modelById("silhouette-cameo3")!;
const cameo4 = modelById("silhouette-cameo4")!;
const letter = SHEET_SIZES.find((s) => s.name === "Letter")!;
const NOT_FOUND = "    1\x03";
const FOUND = "    0\x03";

function job(regmarks: boolean): CutJob {
  const layout = layoutJob(letter, cameo3, regmarks ? "standard" : false);
  return { paths: testSquarePaths(40, 40, 10, 0), ...layout, material: STICKER_PAPER };
}

/** Top-of-search positions (SU) of every mark search sent. */
const searchTops = (log: string[]) => log.filter((c) => c.startsWith("TB123")).map((c) => Number(c.split(",")[3]));

afterEach(() => {
  vi.useRealTimers();
});

describe("connecting", () => {
  it("resets and reads the firmware and calibration", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    expect(session.firmware).toBe("CAMEO V1.10");
    expect(t.log).toEqual(["<ESC EOT>", "FG", "TB71", "FA", "TC"]);
  });

  it("closes the transport if the cutter doesn't answer", async () => {
    vi.useFakeTimers();
    const t = new FakeTransport(() => null);
    const open = expect(CutterSession.open(t, cameo3)).rejects.toThrow(/No reply/);
    await vi.advanceTimersByTimeAsync(11_000);
    await open;
    expect(t.closed).toBe(true);
  });
});

describe("print-and-cut job", () => {
  it("sends exactly what one inkscape-silhouette run sends", async () => {
    // Transcript from fablabnbg/inkscape-silhouette's Graphtec.py in dry-run mode
    // (force_hardware='Silhouette_Cameo3', inc_queries=True): setup(media=134, toolholder=1,
    // cuttingmat='cameo_12x12', autoblade=True, depth=1), then plot() of a 10mm square at sheet
    // (40,40) with regmark=True, regsearch=True, regwidth=195.9, reglength=259.4,
    // regorigin=(10,10), endposition='start'. Status polls (ESC ENQ) are omitted from both sides.
    // Compared with upstream's scan start and media-134 speed and pressure (10, 20); the Cameo 3
    // defaults start the scan 3 mm lower and cut at speed 1, pressure 1 (all tuned on hardware).
    const upstream = [
      "<ESC EOT>", "FG", "TB71", "FA", "TC",
      "TG1", "FN0", "TB50,0", "\\0,0", "Z6096,6096", "J1", "!10,1", "FX20,1", "FE0,1",
      "FF1,0,1", "FF1,1,1", "FC0,1,1", "FC18,1,1", "TF1,1",
      "TB50,0", "TB99", "TB52,2", "TB51,400", "TB53,10", "TB55,1", "TB123,5188,3918,0,0",
      "M600,600", "D600,800", "D800,800", "D800,600", "D600,600",
      "L0", "\\0,0", "M0,0", "J0", "FN0", "TB50,0",
    ];
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, { ...cameo3, regmarkScanOffsetMm: 0 });
    t.writes.length = 0; // each job re-initializes, so a job alone is one full upstream run
    await session.run({ ...job(true), material: { ...STICKER_PAPER, speed: 10, pressure: 20 } });
    expect(t.log.filter((c) => c !== "<ESC ENQ>")).toEqual(upstream);
  });

  it("sends a Cameo 4 exactly what one inkscape-silhouette run sends", async () => {
    // The same upstream run as above with force_hardware='Silhouette_Cameo4'. Upstream's dry run
    // gets no answer to the tool setup query (ESC NAK); an AutoBlade answer, as here, sends the same.
    const upstream = [
      "<ESC EOT>", "FG", "TB71", "FA",
      "TG1", "FN0", "TB50,0", "\\0,0", "Z6096,6096", "<ESC NAK>",
      "J1", "FX20,1", "TJ0", "!10,1", "FC0,1,1", "FE0,1", "FF1,0,1", "FF1,1,1", "FX20,1", "TJ3", "FC18,1,1", "TF1,1",
      "TB50,0", "TB99", "TB52,2", "TB51,400", "TB53,10", "TB55,1", "TB123,5188,3918,0,0",
      "M600,600", "D600,800", "D800,800", "D800,600", "D600,600",
      "L0", "\\0,0", "M0,0", "J0", "FN0", "TB50,0",
    ];
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, { ...cameo4, regmarkScanOffsetMm: 0, regmarkSearchMarginMm: 10 });
    t.writes.length = 0;
    await session.run({ ...job(true), material: { ...STICKER_PAPER, speed: 10, pressure: 20 } });
    expect(t.log.filter((c) => c !== "<ESC ENQ>")).toEqual(upstream);
  });

  it("checks the mat, resets with it loaded, then sets up, scans, cuts and parks", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    t.writes.length = 0;
    const phases: CutPhase[] = [];
    const progress: number[] = [];
    await session.run(job(true), { onPhase: (p) => phases.push(p), onProgress: (f) => progress.push(f) });
    expect(phases).toEqual(["waiting", "waiting", "setup", "regmarks", "cutting", "finishing", "done"]);
    expect(progress.at(-1)).toBe(1);
    const log = t.log;
    expect(log.slice(0, 7)).toEqual(["<ESC ENQ>", "<ESC EOT>", "FG", "TB71", "FA", "TC", "TG1"]);
    // square at sheet (40,40) lands at mark-relative (30,30) = 600 SU
    expect(log.slice(log.indexOf("M600,600"), log.indexOf("M600,600") + 5)).toEqual(["M600,600", "D600,800", "D800,800", "D800,600", "D600,600"]);
    expect(log.slice(-6)).toEqual(["L0", "\\0,0", "M0,0", "J0", "FN0", "TB50,0"]);
  });

  it("re-initializes at the start of every job", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    await session.run(job(true));
    await session.run(job(true));
    const log = t.log.filter((c) => c !== "<ESC ENQ>");
    const inits = log.flatMap((c, i) => (c === "<ESC EOT>" ? [i] : []));
    expect(inits).toHaveLength(3); // connect + two jobs
    expect(log.slice(inits[2] - 1, inits[2] + 6)).toEqual(["TB50,0", "<ESC EOT>", "FG", "TB71", "FA", "TC", "TG1"]);
  });

  it("starts the Cameo 3's scan 3 mm lower than upstream by default", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    await session.run(job(true));
    expect(t.log).toContain("TB123,5188,3918,60,0");
  });

  it("starts the Cameo 4's scan just below the square by default", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo4);
    await session.run(job(true));
    expect(t.log).toContain("TB123,5188,3918,320,200");
  });

  it("uses the model's mark-distance order and scan offset", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, { ...cameo3, regmarkArgOrder: "width_height", regmarkScanOffsetMm: 5 });
    await session.run(job(true));
    expect(t.log).toContain("TB123,3918,5188,100,0");
  });
});

describe("dry run", () => {
  it("does the full setup and mark scan, then traces the same points with the blade up", async () => {
    const cut = new FakeTransport(cameo3Responder());
    await (await CutterSession.open(cut, cameo3)).run(job(true));
    const dry = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(dry, cameo3);
    await session.run({ ...job(true), dryRun: true });

    expect(dry.log.some((c) => /^D\d/.test(c))).toBe(false); // nothing cut
    expect(dry.log).toContain("TF1,1");
    expect(dry.log).toContain("TB123,5188,3918,60,0");
    // same positions as the real cut, every draw turned into a move
    const points = (log: string[]) => log.filter((c) => /^[MD]\d/.test(c) && c !== "M0,0").map((c) => c.slice(1));
    expect(points(dry.log)).toEqual(points(cut.log));
    expect(session.log.format()).toMatch(/## job: cut \(dry run, blade up\)/);
  });

  it("simplifies detailed outlines so the one-move-at-a-time trace stays short", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    // a 20 mm circle with 360 points
    const circle = Array.from({ length: 360 }, (_, k) => [80 + 10 * Math.cos((k * Math.PI) / 180), 80 + 10 * Math.sin((k * Math.PI) / 180)] as [number, number]);
    t.writes.length = 0;
    await session.run({ ...job(false), paths: [circle], dryRun: true });
    const moves = t.writes.filter((w) => /^M\d/.test(w) && !w.startsWith("M0,0")).length;
    expect(moves).toBeLessThan(30);
    expect(moves).toBeGreaterThan(4);
    expect(session.log.format()).toMatch(/## dry run: \d+ moves \(outlines simplified to 1 mm\)/);
  });

  it("sends the moves one at a time, waiting for the carriage between them", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    const paths = Array.from({ length: 4 }, (_, k) => testSquarePaths(40 + k * 20, 40, 10, 0)[0]);
    t.writes.length = 0;
    await session.run({ ...job(false), paths, dryRun: true });
    const moveWrites = t.writes.filter((w) => /^M\d/.test(w) && !w.startsWith("M0,0"));
    expect(moveWrites.length).toBe(20); // 4 squares x 5 points
    expect(moveWrites.every((w) => w.split("\x03").filter(Boolean).length === 1)).toBe(true);
    // every move is followed by a status poll before the next move
    const seq = t.writes.map((w) => (/^M\d/.test(w) && !w.startsWith("M0,0") ? "M" : w === "\x1b\x05" ? "?" : "x"));
    const firstMove = seq.indexOf("M");
    for (let k = firstMove; k < seq.lastIndexOf("M"); k++) if (seq[k] === "M") expect(seq[k + 1]).toBe("?");
  });
});

describe("mark search retries", () => {
  it("retries further down the sheet until the marks are found", async () => {
    const t = new FakeTransport(cameo3Responder({ regmarkReply: [NOT_FOUND, NOT_FOUND, FOUND] }));
    const session = await CutterSession.open(t, cameo3);
    const attempts: [number, number, number][] = [];
    await session.run(job(true), { onRegmarkAttempt: (n, of, mm) => attempts.push([n, of, mm]) });
    expect(attempts).toEqual([
      [1, 4, 0],
      [2, 4, 2],
      [3, 4, 4],
    ]);
    expect(searchTops(t.log)).toEqual([60, 100, 140]); // 3 mm base offset, then +2, +4 mm, in SU
    expect(t.log).toContain("M600,600"); // then cuts
  });

  it("stops before cutting when every attempt fails", async () => {
    const t = new FakeTransport(cameo3Responder({ regmarkReply: NOT_FOUND }));
    const session = await CutterSession.open(t, cameo3);
    await expect(session.run(job(true))).rejects.toThrow(RegmarkNotFoundError);
    expect(searchTops(t.log)).toEqual([60, 100, 140, 180]);
    expect(t.log.some((c) => c.startsWith("M600"))).toBe(false);
    expect(session.isBusy).toBe(false);
  });

  it("treats a silent search as not found after 40 s, and retries", async () => {
    vi.useFakeTimers();
    const t = new FakeTransport(cameo3Responder({ regmarkReply: [null, FOUND] }));
    const session = await CutterSession.open(t, cameo3);
    const run = session.run(job(true));
    await vi.advanceTimersByTimeAsync(41_000);
    await run;
    expect(searchTops(t.log)).toEqual([60, 100]);
  });

  it("uses the model's retry positions", async () => {
    const t = new FakeTransport(cameo3Responder({ regmarkReply: NOT_FOUND }));
    const session = await CutterSession.open(t, { ...cameo3, regmarkScanOffsetMm: 0, regmarkSearchStepsMm: [0, 1] });
    await expect(session.run(job(true))).rejects.toThrow(RegmarkNotFoundError);
    expect(searchTops(t.log)).toEqual([0, 20]);
  });
});

describe("cut-only job (test cut)", () => {
  it("resets with the mat in and skips the mark search", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    t.writes.length = 0;
    await session.run(job(false));
    expect(t.log.slice(0, 7)).toEqual(["<ESC ENQ>", "<ESC EOT>", "FG", "TB71", "FA", "TC", "TG1"]);
    expect(t.log.some((c) => c.startsWith("TB123"))).toBe(false);
    expect(t.log).toContain("M800,800"); // (40,40) mm from the sheet corner
  });

  it("asks for the mat while the cutter reports it out", async () => {
    vi.useFakeTimers();
    const t = new FakeTransport(cameo3Responder({ statuses: ["2", "2", "0"] }));
    const session = await CutterSession.open(t, cameo3);
    const phases: CutPhase[] = [];
    const run = session.run(job(false), { onPhase: (p) => phases.push(p) });
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    expect(phases.slice(0, 3)).toEqual(["waiting", "loadMat", "loadMat"]);
    expect(phases.at(-1)).toBe("done");
  });
});

describe("homing", () => {
  it("homes after the reset and before setup, waiting until it stops", async () => {
    // mat check: ready; homing: moving, moving, stopped
    const t = new FakeTransport(cameo3Responder({ statuses: ["0", "1", "1", "0"] }));
    const session = await CutterSession.open(t, { ...cameo3, homeCommand: "TT" });
    t.writes.length = 0;
    vi.useFakeTimers();
    const run = session.run(job(true));
    await vi.advanceTimersByTimeAsync(2000);
    await run;
    expect(t.log.slice(0, 11)).toEqual(["<ESC ENQ>", "<ESC EOT>", "FG", "TB71", "FA", "TC", "TT", "<ESC ENQ>", "<ESC ENQ>", "<ESC ENQ>", "TG1"]);
  });

  it("sends the model's home command, or none", async () => {
    for (const [homeCommand, expected] of [["H", ["H"]], [null, []]] as const) {
      const t = new FakeTransport(cameo3Responder());
      const session = await CutterSession.open(t, { ...cameo3, homeCommand });
      await session.run(job(false));
      expect(t.log.filter((c) => c === "TT" || c === "H")).toEqual(expected);
    }
  });

  it("homes on its own for the Home button, and not while a job runs", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, { ...cameo3, homeCommand: "TT" });
    t.writes.length = 0;
    await session.home();
    expect(t.log).toEqual(["TT", "<ESC ENQ>"]);
    const run = session.run(job(false));
    await expect(session.home()).rejects.toThrow(/busy/);
    await run;
  });
});

describe("manual registration", () => {
  it("registers from where the user jogged the blade", async () => {
    const cutter = cameo3Responder();
    const t = new FakeTransport((w) => (/TB23,[^\x03]*\x03$/.test(w) ? FOUND : cutter(w)));
    const session = await CutterSession.open(t, { ...cameo3, regmarkScanOffsetMm: 0 });
    const phases: CutPhase[] = [];
    await session.run(
      { ...job(true), registration: "manual" },
      {
        onPhase: (p) => phases.push(p),
        onManualRegistration: async (jog) => {
          expect([jog.x, jog.y]).toEqual([10, 10]); // starts where the top-left mark should be
          await jog.move(2, -1);
          await jog.move(-50, 0); // clamped to the mat edge
        },
      }
    );
    expect(phases).toContain("manualRegmarks");
    const log = t.log;
    expect(log.some((c) => c.startsWith("TB123"))).toBe(false);
    expect(log.slice(log.indexOf("TB55,1"), log.indexOf("TB23,5188,3918") + 1)).toEqual(["TB55,1", "M200,200", "M180,240", "M180,0", "TB23,5188,3918"]);
    expect(log.indexOf("TB23,5188,3918")).toBeLessThan(log.indexOf("M600,600"));
  });

  it("cuts nothing when cancelled", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    const controller = new AbortController();
    const run = session.run(
      { ...job(true), registration: "manual" },
      {
        onManualRegistration: () => {
          controller.abort();
          return Promise.reject(new DOMException("Cancelled", "AbortError"));
        },
      },
      controller.signal
    );
    await expect(run).rejects.toThrow("Cancelled");
    expect(t.log.some((c) => c.startsWith("TB23") || c.startsWith("D"))).toBe(false);
  });
});

describe("pause on the cutter", () => {
  it("shows the pause, then carries on when the cutter resumes", async () => {
    vi.useFakeTimers();
    // One "0" for the check before the job, then the cut: moving, paused, moving, done.
    const t = new FakeTransport(cameo3Responder({ statuses: ["0", "1", "3", "3", "3", "1", "0"] }));
    const session = await CutterSession.open(t, cameo3);
    const phases: CutPhase[] = [];
    const run = session.run(job(false), { onPhase: (p) => phases.push(p) });
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    expect(phases.slice(phases.indexOf("cutting"))).toEqual(["cutting", "paused", "cutting", "finishing", "done"]);
    const text = session.log.format();
    expect(text.match(/## paused on the cutter/g)).toHaveLength(1);
    expect(text.match(/## resumed/g)).toHaveLength(1);
  });
});

describe("cancel on the cutter", () => {
  // A job big enough to need several packets, so there's a "next packet" that must not be sent.
  const manySquares = () => Array.from({ length: 60 }, (_, i) => testSquarePaths(40 + (i % 10) * 12, 40 + Math.floor(i / 10) * 12, 5, 0)[0]);

  it.each([["ready", "0"], ["mat unloaded", "2"]])("stops sending when a pause ends in %s without moving", async (_, after) => {
    vi.useFakeTimers();
    // Check before the job, then the first packet: moving, paused, then cancelled on the screen.
    const t = new FakeTransport(cameo3Responder({ statuses: ["0", "1", "3", "3", after] }));
    const session = await CutterSession.open(t, cameo3);
    t.writes.length = 0;
    const phases: CutPhase[] = [];
    const run = session.run({ ...job(false), paths: manySquares() }, { onPhase: (p) => phases.push(p) });
    const settled = expect(run).rejects.toBeInstanceOf(CutterCancelledError);
    await vi.advanceTimersByTimeAsync(5000);
    await settled;
    const log = t.log.filter((c) => c !== "<ESC ENQ>");
    const packetStarts = log.filter((c, i) => c.startsWith("M") && log[i - 1]?.startsWith("D")).length;
    expect(session.log.format()).toMatch(/## packet 1\/\d+ starts/);
    expect(session.log.format()).not.toMatch(/## packet 2\/\d+ starts/);
    expect(packetStarts).toBeGreaterThan(0); // sanity: the first packet itself had several squares
    expect(log).not.toContain("L0"); // no park either: the cutter is left alone
    expect(phases).not.toContain("done");
  });
});

describe("abort, log and diagnostics", () => {
  it("logs where each packet of the cut starts", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    const paths = Array.from({ length: 60 }, (_, i) => testSquarePaths(40 + (i % 10) * 12, 40 + Math.floor(i / 10) * 12, 5, 0)[0]);
    await session.run({ ...job(false), paths });
    const notes = session.log.format().match(/## packet \d+\/\d+ starts at [MD]\d+,\d+/g)!;
    const packets = t.writes.filter((w) => /^[MD]\d/.test(w)).length;
    expect(packets).toBeGreaterThan(1);
    expect(notes).toHaveLength(packets);
    expect(notes[0]).toBe("## packet 1/" + packets + " starts at M800,800");
  });

  it("resets the cutter when a job is aborted mid-cut", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    const controller = new AbortController();
    const paths = Array.from({ length: 200 }, (_, i) => testSquarePaths(40 + (i % 10) * 12, 40 + Math.floor(i / 10) * 10, 5, 0)[0]);
    const run = session.run({ ...job(false), paths }, { onProgress: () => controller.abort() }, controller.signal);
    await expect(run).rejects.toThrow();
    expect(t.log.at(-1)).toBe("<ESC EOT>");
    expect(t.log).not.toContain("L0");
  });

  it("logs the connection, job summary, commands and replies", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    await session.run(job(true));
    const text = session.log.format();
    expect(text).toMatch(/## connect: Silhouette Cameo 3 via fake cutter; mark search args height_width; scan offset 3 mm; scan margin 10 mm; home none/);
    expect(text).toMatch(/<- CAMEO V1\.10 {4}\|/);
    expect(text).toMatch(/## job: cut, 1 paths; sheet bbox \(40\.00, 40\.00\)-\(50\.00, 50\.00\) mm; frame offset \(-10, -10\) mm; marks standard auto/);
    expect(text).toMatch(/## mark search 1\/4, starting 0 mm further down/);
    expect(text).toMatch(/<- {5}0\|/); // "<- " then the reply "    0"
    expect(text).toMatch(/## job done/);
  });

  it("sends raw diagnostic commands and returns the replies", async () => {
    vi.useFakeTimers();
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    t.writes.length = 0;
    const raw = session.sendRaw(["  TG0 ", "", "<esc enq>", "TF1,1", "FG"], 1500);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await raw).toBe("0|CAMEO V1.10    |");
    expect(t.log).toEqual(["TG0", "<ESC ENQ>", "TF1,1", "FG"]);
  });
});
