import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import type { FabricProvider } from "../src/protocol.js";

const descriptor = {
  name: "echo",
  description: "Echo a value; fail:true throws",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" }, fail: { type: "boolean" } },
    required: ["value"],
    additionalProperties: false,
  },
  risk: "read" as const,
};

const makeService = () => {
  const invocations: Array<Record<string, unknown>> = [];
  const provider: FabricProvider = {
    name: "demo",
    description: "Demo",
    async list() { return [descriptor]; },
    async describe(name) { return name === "echo" ? descriptor : undefined; },
    async invoke(_name, args) {
      invocations.push(args);
      if (args.fail === true) throw new Error(`boom:${String(args.value)}`);
      return { value: args.value, length: String(args.value).length };
    },
  };
  const registry = new ActionRegistry();
  registry.register(provider);
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = false;
  config.approvals.read = "allow";
  const service = new FabricExecutionService(registry, config);
  const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
  let n = 0;
  const run = (code: string) =>
    service.execute({ code, signal: undefined, parentToolCallId: `prior-${n++}`, context, onPartial() {} });
  return { run, invocations };
};

const echo = (value: string, fail = false) =>
  `await tools.call({ ref: "demo.echo", args: { value: ${JSON.stringify(value)}${fail ? ", fail: true" : ""} } })`;

describe("prior results across executions", () => {
  it("parks completed results on failure and serves them typed to the next program without re-invoking", async () => {
    const { run, invocations } = makeService();
    const failed = await run(`const a = ${echo("A")}; const b = ${echo("B", true)}; return { a, b };`);
    expect(failed.success).toBe(false);
    expect(failed.parkedPriorCalls).toBe(1);
    expect(invocations).toHaveLength(2);

    const next = await run(`
const a = prior.get("demo.echo", { value: "A" });
const len: number = a.length;
return { value: a.value, len, parked: prior.calls.length };
`);
    expect(next.typeErrors).toBeUndefined();
    expect(next.success, next.error).toBe(true);
    expect(next.value).toEqual({ value: "A", len: 1, parked: 1 });
    expect(invocations).toHaveLength(2);
  });

  it("clears the store when the next program runs, and a successful program parks nothing", async () => {
    const { run } = makeService();
    await run(`${echo("A")}; ${echo("B", true)}; return 1;`);
    const consumed = await run("return prior.calls.length;");
    expect(consumed.value).toBe(1);
    const empty = await run("return prior.calls.length;");
    expect(empty.value).toBe(0);
    expect(empty.parkedPriorCalls).toBeUndefined();
    const stale = await run('return prior.get("demo.echo", { value: "A" });');
    expect(stale.success).toBe(false);
    expect(stale.typeErrors?.length ?? 0).toBeGreaterThan(0);

    const ok = await run(`${echo("C")}; return 2;`);
    expect(ok.success).toBe(true);
    expect(ok.parkedPriorCalls).toBeUndefined();
    expect((await run("return prior.calls.length;")).value).toBe(0);
  });

  it("keeps the parked results across a program that fails the type check", async () => {
    const { run } = makeService();
    await run(`${echo("A")}; ${echo("B", true)}; return 1;`);
    const typeFailure = await run("return undefinedName();");
    expect(typeFailure.typeErrors?.length ?? 0).toBeGreaterThan(0);
    const next = await run('return prior.get("demo.echo", { value: "A" }).value;');
    expect(next.success, next.error).toBe(true);
    expect(next.value).toBe("A");
  });

  it("rejects a program that names a parked call that does not exist", async () => {
    const { run } = makeService();
    await run(`${echo("A")}; ${echo("B", true)}; return 1;`);
    const wrong = await run('return prior.get("demo.echo", { value: "Z" });');
    expect(wrong.success).toBe(false);
    expect(wrong.typeErrors?.length ?? 0).toBeGreaterThan(0);
    // The type failure did not consume the store.
    const right = await run('return prior.get("demo.echo", { value: "A" }).value;');
    expect(right.value).toBe("A");
  });

  it("caps the parked store and skips discovery answers", async () => {
    const { run } = makeService();
    const many = Array.from({ length: 40 }, (_, i) => echo(`v${i}`)).join("; ");
    const failed = await run(`await tools.list(); ${many}; ${echo("X", true)}; return 1;`);
    expect(failed.success).toBe(false);
    expect(failed.parkedPriorCalls).toBe(32);
    const next = await run("return prior.calls.map((call) => call.ref);");
    expect(next.value).toEqual(Array.from({ length: 32 }, () => "demo.echo"));
  });
});
