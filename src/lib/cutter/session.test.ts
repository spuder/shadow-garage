import { afterEach, describe, expect, it, vi } from "vitest";
import { SHEET_SIZES } from "../sheet";
import { cameo3Responder, FakeTransport } from "./fakeTransport";
import { layoutJob, testSquarePaths } from "./job";
import { WHITE_STICKER_PAPER } from "./materials";
import { modelById } from "./models";
import { CutterNotReadyError, RegmarkNotFoundError } from "./protocol";
import { CutterSession, type CutJob, type CutPhase } from "./session";

const cameo3 = modelById("silhouette-cameo3")!;
const letter = SHEET_SIZES.find((s) => s.name === "Letter")!;
const NOT_FOUND = "    1\x03";
const FOUND = "    0\x03";

function job(regmarks: boolean): CutJob {
  const layout = layoutJob(letter, cameo3, regmarks ? "standard" : false);
  return { paths: testSquarePaths(40, 40, 10, 0), ...layout, material: WHITE_STICKER_PAPER };
}

/** Top-of-search positions (SU) of every mark search sent. */
const searchTops = (log: string[]) => log.filter((c) => c.startsWith("TB123")).map((c) => Number(c.split(",")[3]));

afterEach(() => {
  vi.useRealTimers();
});

// Unless a test says otherwise, the scripted cutter has the mat out when the app connects
// (status 2) and loaded from then on (status 0): connect, load the printed sheet, send.

describe("connecting", () => {
  it("resets, reads the firmware and calibration, and checks whether the mat is in", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    expect(session.firmware).toBe("CAMEO V1.10");
    expect(t.log).toEqual(["<ESC EOT>", "FG", "TB71", "FA", "TC", "<ESC ENQ>"]);
    expect(session.log.format()).toMatch(/## mat out at connect/);
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
  it("sends exactly what inkscape-silhouette sends: the connect reset (mat out) serves the job", async () => {
    // Transcript from fablabnbg/inkscape-silhouette's Graphtec.py in dry-run mode
    // (force_hardware='Silhouette_Cameo3', inc_queries=True): setup(media=134, toolholder=1,
    // cuttingmat='cameo_12x12', autoblade=True, depth=1), then plot() of a 10mm square at sheet
    // (40,40) with regmark=True, regsearch=True, regwidth=195.9, reglength=259.4,
    // regorigin=(10,10), endposition='start'. Status polls (ESC ENQ) are omitted from both sides.
    // Same commands; the one difference is timing: we reset with the mat out, upstream after load.
    const upstream = [
      "<ESC EOT>", "FG", "TB71", "FA", "TC",
      "TG1", "FN0", "TB50,0", "\\0,0", "Z6096,6096", "J1", "!10,1", "FX20,1", "FE0,1",
      "FF1,0,1", "FF1,1,1", "FC0,1,1", "FC18,1,1", "TF1,1",
      "TB50,0", "TB99", "TB52,2", "TB51,400", "TB53,10", "TB55,1", "TB123,5188,3918,0,0",
      "M600,600", "D600,800", "D800,800", "D800,600", "D600,600",
      "L0", "\\0,0", "M0,0", "J0", "FN0", "TB50,0",
    ];
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    await session.run(job(true));
    expect(t.log.filter((c) => c !== "<ESC ENQ>")).toEqual(upstream);
  });

  it("runs setup, mark search, cut and park in order, reporting phases and progress", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    const phases: CutPhase[] = [];
    const progress: number[] = [];
    await session.run(job(true), { onPhase: (p) => phases.push(p), onProgress: (f) => progress.push(f) });
    expect(phases).toEqual(["waiting", "setup", "regmarks", "cutting", "finishing", "done"]);
    expect(progress.at(-1)).toBe(1);
    const log = t.log;
    // square at sheet (40,40) lands at mark-relative (30,30) = 600 SU
    expect(log.slice(log.indexOf("M600,600"), log.indexOf("M600,600") + 5)).toEqual(["M600,600", "D600,800", "D800,800", "D800,600", "D600,600"]);
    expect(log.slice(-6)).toEqual(["L0", "\\0,0", "M0,0", "J0", "FN0", "TB50,0"]);
  });

  it("with the mat already in, asks for it out, resets, then asks for it back in", async () => {
    // connect: loaded; job: loaded -> still loaded -> out -> (reset) -> out -> loaded
    const t = new FakeTransport(cameo3Responder({ statuses: ["0", "0", "0", "2", "2", "0"] }));
    const session = await CutterSession.open(t, cameo3);
    t.writes.length = 0;
    vi.useFakeTimers();
    const phases: CutPhase[] = [];
    const run = session.run(job(true), { onPhase: (p) => phases.push(p) });
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(phases.slice(0, 4)).toEqual(["waiting", "unloadMat", "loadMat", "setup"]);
    // the reset happens while the mat is out: after the first "2", before the final "0"
    expect(t.log.slice(0, 11)).toEqual(["<ESC ENQ>", "<ESC ENQ>", "<ESC ENQ>", "<ESC EOT>", "FG", "TB71", "FA", "TC", "<ESC ENQ>", "<ESC ENQ>", "TG1"]);
  });

  it("needs the unload/reset/load again for the next job", async () => {
    // connect: out; job 1: loaded (+1 poll after its cut); job 2: loaded -> out -> (reset) -> loaded
    const t = new FakeTransport(cameo3Responder({ statuses: ["2", "0", "0", "0", "2", "0"] }));
    const session = await CutterSession.open(t, cameo3);
    vi.useFakeTimers();
    await session.run(job(true));
    t.writes.length = 0;
    const phases: CutPhase[] = [];
    const run = session.run(job(true), { onPhase: (p) => phases.push(p) });
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(phases.slice(0, 3)).toEqual(["waiting", "unloadMat", "loadMat"]);
    expect(t.log.filter((c) => c === "<ESC EOT>")).toHaveLength(1);
  });

  it("skips the unload prompt when the mat is already out, and just resets and waits for it", async () => {
    // connect: out; job 1 uses the connect reset; the user unloads before job 2
    const t = new FakeTransport(cameo3Responder({ statuses: ["2", "0", "0", "2", "0"] }));
    const session = await CutterSession.open(t, cameo3);
    vi.useFakeTimers();
    await session.run(job(true));
    const phases: CutPhase[] = [];
    const run = session.run(job(true), { onPhase: (p) => phases.push(p) });
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(phases.slice(0, 3)).toEqual(["waiting", "loadMat", "setup"]);
  });

  it("gives up if the mat is never taken out, without resetting", async () => {
    const t = new FakeTransport(cameo3Responder({ statuses: ["0"] }));
    const session = await CutterSession.open(t, cameo3);
    t.writes.length = 0;
    vi.useFakeTimers();
    const run = expect(session.run(job(true))).rejects.toThrow(CutterNotReadyError);
    await vi.advanceTimersByTimeAsync(301_000);
    await run;
    expect(t.log.every((c) => c === "<ESC ENQ>")).toBe(true);
    expect(session.isBusy).toBe(false);
  });

  it("can be cancelled while waiting for the mat", async () => {
    const t = new FakeTransport(cameo3Responder({ statuses: ["0"] }));
    const session = await CutterSession.open(t, cameo3);
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = expect(session.run(job(true), {}, controller.signal)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await run;
    expect(session.isBusy).toBe(false);
  });

  it("uses the model's mark-distance order and scan offset", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, { ...cameo3, regmarkArgOrder: "width_height", regmarkScanOffsetMm: 5 });
    await session.run(job(true));
    expect(t.log).toContain("TB123,3918,5188,100,0");
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
      [2, 4, 3],
      [3, 4, 5],
    ]);
    expect(searchTops(t.log)).toEqual([0, 60, 100]); // 0, 3, 5 mm in SU
    expect(t.log).toContain("M600,600"); // then cuts
  });

  it("stops before cutting when every attempt fails", async () => {
    const t = new FakeTransport(cameo3Responder({ regmarkReply: NOT_FOUND }));
    const session = await CutterSession.open(t, cameo3);
    await expect(session.run(job(true))).rejects.toThrow(RegmarkNotFoundError);
    expect(searchTops(t.log)).toEqual([0, 60, 100, 140]);
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
    expect(searchTops(t.log)).toEqual([0, 60]);
  });

  it("uses the model's retry positions", async () => {
    const t = new FakeTransport(cameo3Responder({ regmarkReply: NOT_FOUND }));
    const session = await CutterSession.open(t, { ...cameo3, regmarkSearchStepsMm: [0, 2] });
    await expect(session.run(job(true))).rejects.toThrow(RegmarkNotFoundError);
    expect(searchTops(t.log)).toEqual([0, 40]);
  });
});

describe("cut-only job (test cut)", () => {
  it("waits for the mat, resets with it in, and skips the mark search", async () => {
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
    const t = new FakeTransport(cameo3Responder({ statuses: ["2", "2", "2", "0"] }));
    const session = await CutterSession.open(t, cameo3);
    const phases: CutPhase[] = [];
    const run = session.run(job(false), { onPhase: (p) => phases.push(p) });
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    expect(phases.slice(0, 3)).toEqual(["waiting", "loadMat", "loadMat"]);
    expect(phases.at(-1)).toBe("done");
  });

  it("means the next print-and-cut job needs the unload/reset/load", async () => {
    // connect: out; test cut: loaded (+1 poll); job: loaded -> out -> loaded
    const t = new FakeTransport(cameo3Responder({ statuses: ["2", "0", "0", "0", "2", "0"] }));
    const session = await CutterSession.open(t, cameo3);
    vi.useFakeTimers();
    await session.run(job(false));
    const phases: CutPhase[] = [];
    const run = session.run(job(true), { onPhase: (p) => phases.push(p) });
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(phases).toContain("unloadMat");
  });
});

describe("homing", () => {
  it("homes after the mat is ready and before setup, waiting until it stops", async () => {
    // connect: out; job: loaded; homing: moving, moving, stopped
    const t = new FakeTransport(cameo3Responder({ statuses: ["2", "0", "1", "1", "0"] }));
    const session = await CutterSession.open(t, { ...cameo3, homeCommand: "TT" });
    t.writes.length = 0;
    vi.useFakeTimers();
    const run = session.run(job(true));
    await vi.advanceTimersByTimeAsync(2000);
    await run;
    expect(t.log.slice(0, 6)).toEqual(["<ESC ENQ>", "TT", "<ESC ENQ>", "<ESC ENQ>", "<ESC ENQ>", "TG1"]);
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
    const session = await CutterSession.open(t, cameo3);
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

describe("abort, log and diagnostics", () => {
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
    expect(text).toMatch(/## connect: Silhouette Cameo 3 via fake cutter; mark search args height_width; scan offset 0 mm; home none/);
    expect(text).toMatch(/<- CAMEO V1\.10 {4}\|/);
    expect(text).toMatch(/## job: cut, 1 paths; sheet bbox \(40\.00, 40\.00\)-\(50\.00, 50\.00\) mm; frame offset \(-10, -10\) mm; marks standard auto/);
    expect(text).toMatch(/## mat loaded since a reset with it out/);
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
