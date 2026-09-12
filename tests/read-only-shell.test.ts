import { describe, expect, it } from "vitest";
import { readOnlyShellNotes, readOnlyShellReplacements } from "../src/core/read-only-shell.js";

describe("readOnlyShellReplacements", () => {
  it("names pi.ls and pi.read for a listing plus a file read", () => {
    expect(readOnlyShellReplacements("cd /repo && ls -la && cat README.md | head -30")).toEqual([
      "pi.ls(path)",
      "pi.read({ path, offset, limit })",
    ]);
  });

  it("flags grep and find chains with filters and discards", () => {
    expect(readOnlyShellReplacements("grep -rn 'foo' src 2>/dev/null | sort | uniq -c")).toEqual([
      "pi.grep({ pattern, path, glob, limit })",
    ]);
    expect(readOnlyShellReplacements("find . -name '*.ts' | xargs wc -l | tail -1")).toEqual([
      "pi.find({ pattern, path, limit })",
    ]);
    expect(readOnlyShellReplacements("ls ~/.cargo/registry/src/*/ 2>&1 | grep -E '^(aead|rand)'")).toEqual([
      "pi.ls(path)",
      "pi.grep({ pattern, path, glob, limit })",
    ]);
  });

  it("returns undefined when any segment is not a read", () => {
    for (const command of [
      "cd /repo && cargo build 2>&1 | tail -20",
      "ls && jj log -n 5",
      "git status",
      "grep -rn foo src > out.txt",
      "cat a | tee b",
      "cat a | sed -i 's/x/y/' b",
      "ls; rm -rf node_modules",
      "find . -name '*.log' -delete",
      "find . -name '*.ts' -exec sed -i s/a/b/ {} +",
      "fd -e log -x rm",
    ]) {
      expect(readOnlyShellReplacements(command), command).toBeUndefined();
    }
  });

  it("returns undefined for control flow and substitutions it cannot classify", () => {
    expect(readOnlyShellReplacements("for f in *; do cat $f; done")).toBeUndefined();
    expect(readOnlyShellReplacements("cat $(ls | head -1)")).toBeUndefined();
    expect(readOnlyShellReplacements("ls `pwd`")).toBeUndefined();
    expect(readOnlyShellReplacements("if [ -f x ]; then cat x; fi")).toBeUndefined();
  });

  it("ignores operators inside quotes and unterminated quotes", () => {
    expect(readOnlyShellReplacements("grep -n 'a && b > c' src/x.ts")).toEqual(["pi.grep({ pattern, path, glob, limit })"]);
    expect(readOnlyShellReplacements('cat "file with ; semicolon"')).toEqual(["pi.read({ path, offset, limit })"]);
    expect(readOnlyShellReplacements("cat 'unterminated")).toBeUndefined();
  });

  it("does not flag stdin filters or neutral-only commands", () => {
    expect(readOnlyShellReplacements("echo hi | head -1")).toBeUndefined();
    expect(readOnlyShellReplacements("pwd; echo done")).toBeUndefined();
    expect(readOnlyShellReplacements("cat")).toBeUndefined();
  });

  it("sees through env assignments and xargs", () => {
    expect(readOnlyShellReplacements("LC_ALL=C ls -1 src")).toEqual(["pi.ls(path)"]);
    expect(readOnlyShellReplacements("find src -name '*.ts' | xargs grep -l TODO")).toEqual([
      "pi.find({ pattern, path, limit })",
      "pi.grep({ pattern, path, glob, limit })",
    ]);
    expect(readOnlyShellReplacements("find src | xargs rm")).toBeUndefined();
  });
});

describe("readOnlyShellNotes", () => {
  const bash = (command: string, success = true) => ({ ref: "pi.bash", success, args: { command } });

  it("numbers shell calls, skips failed and non-shell calls, and caps at three notes", () => {
    const notes = readOnlyShellNotes([
      { ref: "pi.read", success: true, args: { path: "x" } },
      bash("cargo build"),
      bash("ls -la"),
      bash("cat x", false),
      bash("grep foo src"),
      bash("find . -name a"),
      bash("cat y"),
    ]);
    expect(notes).toBeDefined();
    const lines = notes!.split("\n");
    expect(lines[0]).toBe("Fabric notes:");
    expect(lines.slice(1)).toHaveLength(3);
    expect(lines[1]).toContain("shell call 2 (`ls -la`)");
    expect(lines[2]).toContain("shell call 4 (`grep foo src`)");
    expect(lines[3]).toContain("shell call 5 (`find . -name a`)");
    expect(notes).not.toContain("cat y");
  });

  it("returns undefined when no shell call was read-only", () => {
    expect(readOnlyShellNotes([bash("cargo test"), bash("jj st")])).toBeUndefined();
    expect(readOnlyShellNotes([])).toBeUndefined();
  });

  it("shortens long commands in the preview", () => {
    const long = `cat ${"a".repeat(200)}`;
    const notes = readOnlyShellNotes([bash(long)]);
    expect(notes).toContain("\u2026");
    expect(notes!.length).toBeLessThan(400);
  });
});
