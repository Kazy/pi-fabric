import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import type { FabricProvider } from "../src/protocol.js";

const descriptor = {
  name: "echo",
  description: "Echo a value",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  outputSchema: { type: "object", properties: { value: { type: "string" } } },
  risk: "read" as const,
};

const provider: FabricProvider = {
  name: "demo",
  description: "Demo",
  async list() {
    return [descriptor];
  },
  async describe(name) {
    return name === "echo" ? descriptor : undefined;
  },
  async invoke(_name, args) {
    return { value: args.value };
  },
};

const run = async (code: string) => {
  const registry = new ActionRegistry();
  registry.register(provider);
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = false;
  config.approvals.read = "allow";
  const service = new FabricExecutionService(registry, config);
  const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
  return service.execute({ code, signal: undefined, parentToolCallId: "list-test", context, onPartial() {} });
};

describe("tools.list summaries", () => {
  it("omits input and output schemas by default but keeps the navigation fields", async () => {
    const result = await run('return tools.list({ provider: "demo" });');
    expect(result.success).toBe(true);
    const [action] = result.value as Array<Record<string, unknown>>;
    expect(action).toMatchObject({ ref: "demo.echo", provider: "demo", name: "echo", description: "Echo a value", risk: "read" });
    expect(action).not.toHaveProperty("inputSchema");
    expect(action).not.toHaveProperty("outputSchema");
  });

  it("treats schemas: false and a missing argument the same", async () => {
    const result = await run('return [await tools.list(), await tools.list({ schemas: false })];');
    expect(result.success).toBe(true);
    const [bare, explicit] = result.value as [Array<Record<string, unknown>>, Array<Record<string, unknown>>];
    expect(bare).toEqual(explicit);
    expect(bare[0]).not.toHaveProperty("inputSchema");
  });

  it("returns full schemas when schemas: true is passed", async () => {
    const result = await run('return tools.list({ provider: "demo", schemas: true });');
    expect(result.success).toBe(true);
    const [action] = result.value as [Record<string, unknown>];
    expect(action.inputSchema).toMatchObject({ type: "object", required: ["value"] });
    expect(action.outputSchema).toEqual(descriptor.outputSchema);
  });

  it("does not strip schemas from search or describe", async () => {
    const result = await run('return { search: await tools.search({ query: "echo" }), one: await tools.describe({ ref: "demo.echo" }) };');
    expect(result.success).toBe(true);
    const value = result.value as { search: Array<Record<string, unknown>>; one: Record<string, unknown> };
    expect(value.search[0]).toHaveProperty("inputSchema");
    expect(value.one).toHaveProperty("inputSchema");
  });

  it("keeps summaries when the schemas flag is truthy but not boolean true", async () => {
    const result = await run('return tools.list({ provider: "demo", schemas: "yes" as unknown as true });');
    expect(result.success).toBe(true);
    const [action] = result.value as Array<Record<string, unknown>>;
    expect(action).not.toHaveProperty("inputSchema");
  });
});
