import { describe, expect, it } from "vitest";
import { FakeTransport } from "./fakeTransport";
import { LoggingTransport, printable } from "./transport";

const enc = new TextEncoder();

describe("printable", () => {
  it("names escape sequences and shows ETX as |", () => {
    expect(printable(new Uint8Array([0x1b, 0x04, 0x46, 0x47, 0x03, 0x1b, 0x05, 0x07]))).toBe("<ESC EOT>FG|<ESC ENQ><07>");
  });
});

describe("LoggingTransport", () => {
  it("records replies that were drained without being read", async () => {
    const log = new LoggingTransport(new FakeTransport((w) => (w === "X\x03" ? "    1\x03" : null)));
    await log.write(enc.encode("X\x03"));
    log.drain();
    expect(log.format()).toMatch(/<- \(unread\) {5}1\|/);
  });

  it("counts repeated status polls instead of logging each one", async () => {
    const replies = ["1", "1", "1", "1", "3", "3", "0"];
    const log = new LoggingTransport(new FakeTransport((w) => (w === "\x1b\x05" ? replies.shift()! + "\x03" : null)));
    for (let i = 0; i < 7; i++) {
      await log.write(new Uint8Array([0x1b, 0x05]));
      await log.read(100);
    }
    const lines = log.entries().map((e) => `${e.kind} ${e.text}`);
    expect(lines).toEqual([
      "out <ESC ENQ>",
      "in 1|",
      "note status 1 repeated 3 more times over 0.0 s",
      "out <ESC ENQ>",
      "in 3|",
      "note status 3 repeated 1 more time over 0.0 s",
      "out <ESC ENQ>",
      "in 0|",
    ]);
  });

  it("shows a run of polls still being counted, and starts afresh after anything else", async () => {
    const log = new LoggingTransport(new FakeTransport((w) => (w === "\x1b\x05" ? "1\x03" : null)));
    const poll = async () => {
      await log.write(new Uint8Array([0x1b, 0x05]));
      await log.read(100);
    };
    await poll();
    await poll();
    expect(log.format()).toMatch(/## status 1 repeated 1 more time/);
    log.note("packet 2/2");
    await poll();
    expect(log.entries().map((e) => e.text)).toEqual(["<ESC ENQ>", "1|", "status 1 repeated 1 more time over 0.0 s", "packet 2/2", "<ESC ENQ>", "1|"]);
  });

  it("keeps the start of the session when a long job overflows the log", async () => {
    const log = new LoggingTransport(new FakeTransport(() => null));
    log.note("handshake");
    const total = LoggingTransport.HEAD + LoggingTransport.TAIL + 500;
    for (let i = 0; i < total; i++) await log.write(enc.encode(`D${i}\x03`));
    const entries = log.entries();
    expect(entries[0].text).toBe("handshake");
    expect(entries.length).toBe(LoggingTransport.HEAD + LoggingTransport.TAIL);
    expect(entries.at(-1)!.text).toBe(`D${total - 1}|`);
    expect(log.format()).toMatch(/\.\.\. 501 entries omitted \.\.\./);
  });
});
