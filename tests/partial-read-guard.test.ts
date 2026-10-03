import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { readCoverage } from "../src/providers/partial-read-guard.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";

const roots: string[] = [];
const registries: ActionRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-partial-read-"));
  roots.push(cwd);
  const registry = new ActionRegistry();
  registries.push(registry);
  registry.register(new PiToolsProvider(cwd));
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.approvals.write = "allow";
  const service = new FabricExecutionService(registry, config);
  let id = 0;
  const run = (code: string, parentToolCallId = `partial-read-${++id}`) => service.execute({
    code, signal: undefined, parentToolCallId,
    context: { cwd, hasUI: false } as ExtensionContext, onPartial() {},
  });
  const file = (name: string, content: string) => {
    fs.writeFileSync(path.join(cwd, name), content);
    return content;
  };
  const text = (name: string) => fs.readFileSync(path.join(cwd, name), "utf8");
  return { cwd, run, file, text };
};

// 600 lines of 100 bytes: over 50KB, under 2000 lines, so the byte cap cuts it.
const bytesHeavy = Array.from({ length: 600 }, (_, i) => `${String(i + 1).padStart(4, "0")}${"x".repeat(95)}`).join("\n");
const linesHeavy = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");

// The exact failure: strip the notice, edit the text, write it back.
const readModifyWrite = (target: string, read = `await pi.read(${JSON.stringify(target)})`) => `
const text = ${read};
const body = text.replace(/\\n\\n\\[[^\\]]*\\]$/, "");
await pi.write({ path: ${JSON.stringify(target)}, content: body + "\\nnote" });
return "wrote";
`;

describe("partial read guard", () => {
  it("refuses to write back a read cut at 50KB and leaves the file intact", async () => {
    const { run, file, text } = fixture();
    const original = file("big.txt", bytesHeavy);
    const result = await run(readModifyWrite("big.txt"));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pi\.write refused: this program read only part of big\.txt \(\d+ of 600 lines\)/);
    expect(text("big.txt")).toBe(original);
  });

  it("refuses after a read cut at 2000 lines", async () => {
    const { run, file, text } = fixture();
    const original = file("long.txt", linesHeavy);
    const result = await run(readModifyWrite("long.txt"));
    expect(result.error).toContain("(2000 of 3000 lines)");
    expect(text("long.txt")).toBe(original);
  });

  it("refuses after a read with an explicit limit", async () => {
    const { run, file, text } = fixture();
    const original = file("small.txt", "a\nb\nc\nd");
    const result = await run(readModifyWrite("small.txt", `await pi.read({ path: "small.txt", limit: 2 })`));
    expect(result.error).toContain("(2 of 4 lines)");
    expect(text("small.txt")).toBe(original);
  });

  it("refuses after a read that started past line 1, even though it reached the end", async () => {
    const { run, file, text } = fixture();
    const original = file("tail.txt", "a\nb\nc\nd");
    const result = await run(readModifyWrite("tail.txt", `await pi.read({ path: "tail.txt", offset: 3 })`));
    expect(result.error).toContain("(2 of 4 lines)");
    expect(text("tail.txt")).toBe(original);
  });

  it("matches the read and the write when they spell the same path differently", async () => {
    const { run, file, cwd, text } = fixture();
    const original = file("big.txt", bytesHeavy);
    for (const [read, write] of [["@big.txt", "big.txt"], ["./big.txt", path.join(cwd, "big.txt")], ["sub/../big.txt", "big.txt"]]) {
      fs.mkdirSync(path.join(cwd, "sub"), { recursive: true });
      const result = await run(`
const text = await pi.read(${JSON.stringify(read)});
await pi.write({ path: ${JSON.stringify(write)}, content: text });
`);
      expect(result.error, `${read} -> ${write}`).toContain("pi.write refused");
      expect(text("big.txt")).toBe(original);
    }
  });

  it("refuses a write that goes through tools.call", async () => {
    const { run, file, text } = fixture();
    const original = file("big.txt", bytesHeavy);
    const result = await run(`
const text = await pi.read("big.txt");
await tools.call({ ref: "pi.write", args: { path: "big.txt", content: text } });
`);
    expect(result.error).toContain("pi.write refused");
    expect(text("big.txt")).toBe(original);
  });

  it("refuses after a read whose first line exceeds the byte cap", async () => {
    const { run, file, text } = fixture();
    const original = file("minified.js", "x".repeat(60 * 1024));
    const result = await run(readModifyWrite("minified.js"));
    expect(result.error).toContain("pi.write refused: this program read only part of minified.js");
    expect(text("minified.js")).toBe(original);
  });

  it("refuses while chunked reads leave a gap", async () => {
    const { run, file, text } = fixture();
    const original = file("long.txt", linesHeavy);
    const result = await run(`
const first = await pi.read("long.txt");
const last = await pi.read({ path: "long.txt", offset: 2500 });
await pi.write({ path: "long.txt", content: first + last });
`);
    expect(result.error).toContain("(2501 of 3000 lines)");
    expect(text("long.txt")).toBe(original);
  });

  it("allows a write after chunked reads cover every line, in any order and with overlap", async () => {
    const { run, file, text } = fixture();
    file("long.txt", linesHeavy);
    const result = await run(`
const strip = (t) => t.replace(/\\n\\n\\[[^\\]]*\\]$/, "");
const tail = await pi.read({ path: "long.txt", offset: 1500 });
const head = strip(await pi.read({ path: "long.txt", limit: 1499 }));
await pi.write({ path: "long.txt", content: head + "\\n" + tail });
return "wrote";
`);
    expect(result.error).toBeUndefined();
    expect(text("long.txt")).toBe(linesHeavy);
  });

  it("allows a write after a complete read, with or without a trailing newline", async () => {
    const { run, file, text } = fixture();
    file("a.txt", "one\ntwo\n");
    file("b.txt", "one\ntwo");
    file("empty.txt", "");
    const result = await run(`
for (const name of ["a.txt", "b.txt", "empty.txt"]) {
  const t = await pi.read(name);
  await pi.write({ path: name, content: t + "!" });
}
return "wrote";
`);
    expect(result.error).toBeUndefined();
    expect([text("a.txt"), text("b.txt"), text("empty.txt")]).toEqual(["one\ntwo\n!", "one\ntwo!", "!"]);
  });

  it("allows a file of exactly 2000 lines, which pi.read returns in full", async () => {
    const { run, file, text } = fixture();
    const content = file("exact.txt", Array.from({ length: 2000 }, (_, i) => `l${i}`).join("\n"));
    const result = await run(`await pi.write({ path: "exact.txt", content: await pi.read("exact.txt") }); return 1;`);
    expect(result.error).toBeUndefined();
    expect(text("exact.txt")).toBe(content);
  });

  it("does not block pi.edit, a write without a read, or a write to another file", async () => {
    const { run, file, text } = fixture();
    file("big.txt", bytesHeavy);
    const result = await run(`
await pi.read("big.txt");
await pi.edit({ path: "big.txt", oldText: "0001", newText: "FIRST" });
await pi.write({ path: "other.txt", content: "fresh" });
return "ok";
`);
    expect(result.error).toBeUndefined();
    expect(text("big.txt").startsWith("FIRST")).toBe(true);
    expect(text("other.txt")).toBe("fresh");
  });

  it("allows a second write after the program wrote the whole file itself", async () => {
    const { run, file, text } = fixture();
    file("big.txt", bytesHeavy);
    const result = await run(`
await pi.read("big.txt");
await pi.write({ path: "fresh.txt", content: "x" });
await pi.read({ path: "fresh.txt" });
await pi.write({ path: "fresh.txt", content: "y" });
return "ok";
`);
    expect(result.error).toBeUndefined();
    expect(text("fresh.txt")).toBe("y");
  });

  it("writes with force: true and keeps the flag out of the file and the result", async () => {
    const { run, file, text } = fixture();
    file("big.txt", bytesHeavy);
    const result = await run(`
const head = await pi.read("big.txt");
const written = await pi.write({ path: "big.txt", content: "replaced", force: true });
return written.output;
`);
    expect(result.error).toBeUndefined();
    expect(text("big.txt")).toBe("replaced");
    expect(String(result.value)).not.toContain("force");
  });

  it("still refuses with force: false, and rejects a force that is not a boolean", async () => {
    const { run, file, text } = fixture();
    const original = file("big.txt", bytesHeavy);
    const off = await run(`await pi.read("big.txt"); await pi.write({ path: "big.txt", content: "x", force: false });`);
    expect(off.error).toContain("pi.write refused");
    expect(off.error).toContain("force: true");
    const loose = await run(`await pi.read("big.txt"); await tools.call({ ref: "pi.write", args: { path: "big.txt", content: "x", force: "yes" } });`);
    expect(loose.success).toBe(false);
    expect(loose.error).not.toContain("pi.write refused");
    expect(text("big.txt")).toBe(original);
  });

  it("keeps the record per program and drops it when the program ends", async () => {
    const { run, file, text } = fixture();
    file("big.txt", bytesHeavy);
    const first = await run(`await pi.read("big.txt"); return 1;`, "reused-id");
    expect(first.error).toBeUndefined();
    // Same parent id: the invocation ended, so its record must be gone.
    const again = await run(`await pi.write({ path: "big.txt", content: "replaced" }); return 1;`, "reused-id");
    expect(again.error).toBeUndefined();
    expect(text("big.txt")).toBe("replaced");
  });
});

describe("readCoverage", () => {
  it("does not read a notice from file content that only looks like one", () => {
    const content = "code\n\n[Showing lines 1-2 of 9. Use offset=3 to continue.]\nmore";
    expect(readCoverage(content, undefined)).toEqual({ range: [1, 4], total: 4 });
  });
});
