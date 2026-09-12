import { describe, expect, it } from "vitest";
import { buildPriorGuestDeclarations } from "../src/runtime/prior-guest-types.js";
import type { FabricPriorCall } from "../src/runtime/kernel.js";
import { guestTypeDeclarations } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

const parked: FabricPriorCall[] = [
  { ref: "pi.read", args: { path: "a" }, result: "text of a" },
  { ref: "demo.echo", args: { value: "A" }, result: { value: "A", count: 1 } },
  { ref: "demo.echo", args: { value: "B", nested: { deep: [1, "x"] } }, result: { value: "B", count: 2 } },
];

const declarationsFor = (calls: readonly FabricPriorCall[]) =>
  guestTypeDeclarations(true, { prior: buildPriorGuestDeclarations(calls) });

const check = (code: string, calls: readonly FabricPriorCall[] = parked) => typeCheckFabricCode(code, declarationsFor(calls));

describe("prior guest declarations", () => {
  it("types get() by literal ref and args and the result by its parked shape", () => {
    const accepted = check(`
const text: string = prior.get("pi.read");
const alsoText: string = prior.get("pi.read", { path: "a" });
const a: { value: string; count: number } = prior.get("demo.echo", { value: "A" });
const b = prior.get("demo.echo", { value: "B", nested: { deep: [1, "x"] } });
const deep: string = b.value;
const fromTuple: number = prior.calls[2].result.count;
return { text, alsoText, a, deep, fromTuple, n: prior.calls.length };
`);
    expect(accepted.errors).toEqual([]);
  });

  it("rejects a ref that was not parked, wrong args, and an ambiguous ref without args", () => {
    for (const code of [
      'return prior.get("pi.grep");',
      'return prior.get("pi.read", { path: "b" });',
      'return prior.get("demo.echo");',
      'return prior.get("demo.echo", { value: "C" });',
      "return prior.calls[3];",
    ]) {
      const result = check(code);
      expect(result.errors.length, code).toBeGreaterThan(0);
    }
  });

  it("rejects every get() when nothing is parked but keeps calls readable", () => {
    expect(check('return prior.get("pi.read");', []).errors.length).toBeGreaterThan(0);
    expect(check("return prior.calls.length;", []).errors).toEqual([]);
  });

  it("falls back to a structural args type for oversized literal args", () => {
    const big = [{ ref: "pi.write", args: { path: "x", content: "y".repeat(3_000) }, result: { ok: true, output: "w", details: null } }];
    const declaration = buildPriorGuestDeclarations(big);
    expect(declaration).toContain("content: string");
    expect(declaration).not.toContain("yyyyyyyy");
    const accepted = check('const r = prior.get("pi.write", { path: "x", content: "anything" }); return r.ok;', big);
    expect(accepted.errors).toEqual([]);
  });

  it("renders arrays, nulls, and non-identifier keys", () => {
    const calls = [{ ref: "x.y", args: { "weird key": null }, result: [{ a: 1 }, { a: 2 }] }];
    const declaration = buildPriorGuestDeclarations(calls);
    expect(declaration).toContain('"weird key": null');
    expect(declaration).toContain("Array<{ a: number }>");
    expect(check('return prior.get("x.y", { "weird key": null })[0].a;', calls).errors).toEqual([]);
  });
});
