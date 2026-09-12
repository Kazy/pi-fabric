import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { validationMessage } from "../src/core/action-arguments.js";

vi.mock("typebox/value", async importOriginal => {
  const actual = await importOriginal<typeof import("typebox/value")>();
  return { ...actual, Value: { ...actual.Value, Errors: vi.fn(actual.Value.Errors) } };
});

const schema = { type: "object", properties: { target: { type: "object", properties: { css: { type: "string" } }, required: ["css"] } }, required: ["target"] };

describe("validation error paths", () => {
  it("reports the real TypeBox nested /target/css failure", () => {
    expect(validationMessage(schema, { target: { css: 42 } })).toMatch(/^\/target\/css: /);
    expect(validationMessage(schema, { target: { css: "main" } })).toBeUndefined();
  });
  it.each([
    [{ instancePath: "/target/css", path: "/legacy" }, "/target/css: invalid"],
    [{ path: "/target/css" }, "/target/css: invalid"],
    [{ instancePath: null, path: "/target/css" }, "/target/css: invalid"],
    [{ instancePath: "", path: "/legacy" }, "invalid"],
  ])("prefers instancePath with a nullish legacy fallback: %j", (location, expected) => {
    const spy = vi.spyOn(Value, "Errors").mockReturnValue([{ ...location, message: "invalid" }] as any);
    try {
      expect(validationMessage(schema, { target: { css: 42 } })).toBe(expected);
    } finally { spy.mockRestore(); }
  });
});

const grepSchema = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    limit: { type: "number" },
  },
  required: ["pattern"],
  additionalProperties: false,
};

describe("validationMessage", () => {
  it("names the failing nested field", () => {
    const message = validationMessage(grepSchema, { pattern: "x", limit: {} });
    expect(message).toBe("/limit: must be number");
  });

  it("names each unexpected key alongside typed failures", () => {
    const message = validationMessage(grepSchema, { pattern: "x", limit: "5", extra: true });
    expect(message).toContain("/limit: must be number");
    expect(message).toContain("/extra: must not have additional properties");
  });

  it("keeps root-level messages without a path prefix", () => {
    const message = validationMessage(grepSchema, {});
    expect(message).toBeDefined();
    expect(message).not.toMatch(/^\/: /);
    expect(message).toContain("pattern");
  });

  it("returns undefined for valid input", () => {
    expect(validationMessage(grepSchema, { pattern: "x", path: "src", limit: 3 })).toBeUndefined();
  });
});
