import { describe, expect, it } from "vitest";
import { validationMessage } from "../src/core/action-arguments.js";

const schema = {
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
    const message = validationMessage(schema, { pattern: "x", limit: {} });
    expect(message).toBe("/limit: must be number");
  });

  it("names each unexpected key alongside typed failures", () => {
    const message = validationMessage(schema, { pattern: "x", limit: "5", extra: true });
    expect(message).toContain("/limit: must be number");
    expect(message).toContain("/extra: must not have additional properties");
  });

  it("keeps root-level messages without a path prefix", () => {
    const message = validationMessage(schema, {});
    expect(message).toBeDefined();
    expect(message).not.toMatch(/^\/: /);
    expect(message).toContain("pattern");
  });

  it("returns undefined for valid input", () => {
    expect(validationMessage(schema, { pattern: "x", path: "src", limit: 3 })).toBeUndefined();
  });
});
