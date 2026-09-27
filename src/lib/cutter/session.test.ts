import { afterEach, describe, expect, it, vi } from "vitest";
import { SHEET_SIZES } from "../sheet";
import { cameo3Responder, FakeTransport } from "./fakeTransport";
import { layoutJob, testSquarePaths } from "./job";
import { WHITE_STICKER_PAPER } from "./materials";
import { modelById } from "./models";
import { RegmarkNotFoundError } from "./protocol";
import { CutterSession, type CutJob, type CutPhase } from "./session";

const cameo3 = modelById("silhouette-cameo3")!;
const letter = SHEET_SIZES.find((s) => s.name === "Letter")!;

function job(regmarks: boolean): CutJob {
  const layout = layoutJob(letter, cameo3, regmarks ? "standard" : false);
  return { paths: testSquarePaths(40, 40, 10, 0), ...layout, material: WHITE_STICKER_PAPER };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CutterSession", () => {
  it("handshakes with a reset, firmware query and the Cameo 3 init queries", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    expect(session.firmware).toBe("CAMEO V1.10");
    expect(t.log).toEqual(["<ESC EOT>", "FG", "TB71", "FA", "TC"]);
  });

  it("runs a print-and-cut job in order: ready check, setup, mark search, cut, park", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    t.writes.length = 0;
    const phases: CutPhase[] = [];
    const progress: number[] = [];
    await session.run(job(true), { onPhase: (p) => phases.push(p), onProgress: (f) => progress.push(f) });

    expect(phases).toEqual(["waiting", "waiting", "setup", "regmarks", "cutting", "finishing", "done"]);
    expect(progress.at(-1)).toBe(1);
    const log = t.log;
    const idx = (cmd: string) => log.indexOf(cmd);
    expect(idx("TG1")).toBeLessThan(idx("TB123,5188,3918,0,0"));
    // square at sheet (40,40) lands at mark-relative (30,30) = 600 SU
    expect(idx("TB123,5188,3918,0,0")).toBeLessThan(idx("M600,600"));
    expect(log.slice(idx("M600,600"), idx("M600,600") + 5)).toEqual(["M600,600", "D600,800", "D800,800", "D800,600", "D600,600"]);
    expect(log.slice(-6)).toEqual(["L0", "\\0,0", "M0,0", "J0", "FN0", "TB50,0"]);
  });

  it("sends exactly what inkscape-silhouette sends for the same job", async () => {
    // Transcript from fablabnbg/inkscape-silhouette's Graphtec.py in dry-run mode
    // (force_hardware='Silhouette_Cameo3', inc_queries=True): setup(media=134, toolholder=1,
    // cuttingmat='cameo_12x12', autoblade=True, depth=1), then plot() of a 10mm square at sheet
    // (40,40) with regmark=True, regsearch=True, regwidth=195.9, reglength=259.4,
    // regorigin=(10,10), endposition='start'. Status polls (ESC ENQ) are omitted from both sides.
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
    // Each job re-initializes, so a job's stream (connect handshake aside) is one full upstream run.
    t.writes.length = 0;
    await session.run(job(true));
    expect(t.log.filter((c) => c !== "<ESC ENQ>")).toEqual(upstream);
  });

  it("homes the carriage after the mat check and before setup, waiting until it stops", async () => {
    // statuses: mat check -> ready; homing -> moving, moving, ready
    const t = new FakeTransport(cameo3Responder({ statuses: ["0", "1", "1", "0"] }));
    const session = await CutterSession.open(t, { ...cameo3, homeCommand: "TT" });
    t.writes.length = 0;
    vi.useFakeTimers();
    const run = session.run(job(true));
    await vi.advanceTimersByTimeAsync(2000);
    await run;
    const log = t.log;
    expect(log.slice(0, 10)).toEqual(["<ESC ENQ>", "<ESC EOT>", "FG", "TB71", "FA", "TC", "TT", "<ESC ENQ>", "<ESC ENQ>", "<ESC ENQ>"]);
    expect(log.indexOf("TT")).toBeLessThan(log.indexOf("TG1"));
    expect(log.indexOf("TG1")).toBeLessThan(log.indexOf("TB123,5188,3918,0,0"));
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
    expect(session.log.format()).toMatch(/## home/);
    const run = session.run(job(false));
    await expect(session.home()).rejects.toThrow(/busy/);
    await run;
  });

  it("re-initializes the cutter at the start of every job", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    await session.run(job(true));
    await session.run(job(false));
    const log = t.log.filter((c) => c !== "<ESC ENQ>");
    const inits = log.flatMap((c, i) => (c === "<ESC EOT>" ? [i] : []));
    expect(inits).toHaveLength(3); // connect + two jobs
    // each job's reset comes before its setup, and after the previous job has parked
    expect(log.slice(inits[2] - 1, inits[2] + 6)).toEqual(["TB50,0", "<ESC EOT>", "FG", "TB71", "FA", "TC", "TG1"]);
  });

  it("skips the mark search for cut-only jobs", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    await session.run(job(false));
    expect(t.log.some((c) => c.startsWith("TB123"))).toBe(false);
    expect(t.log).toContain("M800,800"); // (40,40) mm from the sheet corner
  });

  it("asks for the mat while the cutter reports unloaded", async () => {
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

  it("stops before cutting when the marks aren't found", async () => {
    const t = new FakeTransport(cameo3Responder({ regmarkReply: "    1\x03" }));
    const session = await CutterSession.open(t, cameo3);
    await expect(session.run(job(true))).rejects.toThrow(RegmarkNotFoundError);
    expect(t.log.some((c) => c.startsWith("M600"))).toBe(false);
    expect(session.isBusy).toBe(false);
  });

  it("treats a silent mark search as not found after 40 s", async () => {
    vi.useFakeTimers();
    const t = new FakeTransport(cameo3Responder({ regmarkReply: null }));
    const session = await CutterSession.open(t, cameo3);
    const run = expect(session.run(job(true))).rejects.toThrow(RegmarkNotFoundError);
    await vi.advanceTimersByTimeAsync(41_000);
    await run;
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

  it("uses the model's mark-distance order in the search", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, { ...cameo3, regmarkArgOrder: "width_height" });
    await session.run(job(true));
    expect(t.log).toContain("TB123,3918,5188,0,0");
  });

  it("registers manually from where the user jogged the blade", async () => {
    const t = new FakeTransport((w) => (/TB23,[^\x03]*\x03$/.test(w) ? "    0\x03" : cameo3Responder()(w)));
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

  it("cancelling manual registration cuts nothing", async () => {
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

  it("logs the handshake, job summary, commands and replies", async () => {
    const t = new FakeTransport(cameo3Responder());
    const session = await CutterSession.open(t, cameo3);
    await session.run(job(true));
    const text = session.log.format();
    expect(text).toMatch(/## connect: Silhouette Cameo 3 via fake cutter; mark search args height_width; home none/);
    expect(text).toMatch(/-> <ESC EOT>/);
    expect(text).toMatch(/<- CAMEO V1\.10 {4}\|/);
    expect(text).toMatch(/## job: cut, 1 paths; sheet bbox \(40\.00, 40\.00\)-\(50\.00, 50\.00\) mm; frame offset \(-10, -10\) mm; marks standard auto/);
    expect(text).toMatch(/TB123,5188,3918,0,0\|/);
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
    expect(session.log.format()).toMatch(/-> TF1,1\|/);
  });

  it("closes the transport if the handshake fails", async () => {
    vi.useFakeTimers();
    const t = new FakeTransport(() => null);
    const open = expect(CutterSession.open(t, cameo3)).rejects.toThrow(/No reply/);
    await vi.advanceTimersByTimeAsync(11_000);
    await open;
    expect(t.closed).toBe(true);
  });
});
