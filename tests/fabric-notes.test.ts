import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { fabricNotes, readThenWriteNoteLines } from "../src/core/fabric-notes.js";

const CWD = "/repo";
const call = (ref: string, path: string, success = true) => ({ ref, success, args: { path } });
const read = (path: string, success = true) => call("pi.read", path, success);
const write = (path: string, success = true) => call("pi.write", path, success);

describe("readThenWriteNoteLines", () => {
  it("flags a write to a file that the program read first", () => {
    const lines = readThenWriteNoteLines([read("src/a.ts"), write("src/a.ts")], CWD);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("`src/a.ts`");
    expect(lines[0]).toContain("pi.edit");
  });

  it("matches the same file through relative, ./, @, absolute and .. spellings", () => {
    for (const [readPath, writePath] of [
      ["src/a.ts", "./src/a.ts"],
      ["@src/a.ts", "/repo/src/a.ts"],
      ["/repo/src/../src/a.ts", "src/a.ts"],
      ["/repo/src/a.ts", "@./src/a.ts"],
    ] as const) {
      expect(readThenWriteNoteLines([read(readPath), write(writePath)], CWD), `${readPath} -> ${writePath}`)
        .toHaveLength(1);
    }
  });

  it("expands ~ like the pi tools do", () => {
    const home = homedir();
    expect(readThenWriteNoteLines([read("~/x.md"), write(`${home}/x.md`)], CWD)).toHaveLength(1);
  });

  it("ignores a write that comes before the read", () => {
    expect(readThenWriteNoteLines([write("a.ts"), read("a.ts")], CWD)).toEqual([]);
  });

  it("ignores failed reads and failed writes", () => {
    expect(readThenWriteNoteLines([read("a.ts", false), write("a.ts")], CWD)).toEqual([]);
    expect(readThenWriteNoteLines([read("a.ts"), write("a.ts", false)], CWD)).toEqual([]);
  });

  it("ignores new files, other files, and pi.edit", () => {
    expect(readThenWriteNoteLines([write("new.ts")], CWD)).toEqual([]);
    expect(readThenWriteNoteLines([read("a.ts"), write("b.ts")], CWD)).toEqual([]);
    expect(readThenWriteNoteLines([read("a.ts"), call("pi.edit", "a.ts")], CWD)).toEqual([]);
  });

  it("does not treat a different directory with the same file name as the same file", () => {
    expect(readThenWriteNoteLines([read("src/index.ts"), write("tests/index.ts")], CWD)).toEqual([]);
  });

  it("survives audits without usable args", () => {
    const odd = [
      { ref: "pi.read", success: true },
      { ref: "pi.read", success: true, args: { path: 42 } },
      { ref: "pi.write", success: true, args: { path: "" } },
      { ref: "pi.write", success: true, args: { fabricTruncated: true, preview: "{}" } },
    ];
    expect(readThenWriteNoteLines(odd, CWD)).toEqual([]);
  });

  it("lists each file once and bounds the list", () => {
    const audits = ["a", "b", "c", "d", "e"].flatMap((name) => [read(name), write(name), write(name)]);
    const lines = readThenWriteNoteLines(audits, CWD);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("`a`, `b`, `c` (+2 more)");
    expect(lines[0]!.match(/`a`/g)).toHaveLength(1);
  });
});

describe("fabricNotes", () => {
  it("puts rewrite and shell notes under one header", () => {
    const notes = fabricNotes(
      [read("a.ts"), write("a.ts"), { ref: "pi.bash", success: true, args: { command: "ls" } }],
      CWD,
    );
    expect(notes!.match(/Fabric notes:/g)).toHaveLength(1);
    expect(notes).toContain("pi.write replaced");
    expect(notes).toContain("shell call 1");
  });

  it("returns undefined when there is nothing to note", () => {
    expect(fabricNotes([read("a.ts"), call("pi.edit", "a.ts")], CWD)).toBeUndefined();
    expect(fabricNotes([], CWD)).toBeUndefined();
  });
});
