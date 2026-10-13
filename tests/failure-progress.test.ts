import { describe, expect, it } from "vitest";
import {
  FABRIC_EXECUTION_TRACE_KIND,
  FABRIC_EXECUTION_TRACE_VERSION,
  type FabricExecutionTraceV1,
} from "../src/audit/trace.js";
import { formatFailureProgress, parkedTruncationNotes } from "../src/failure-progress.js";

const trace = (
  outcome: FabricExecutionTraceV1["outcome"],
  operations: FabricExecutionTraceV1["operations"],
): FabricExecutionTraceV1 => ({
  kind: FABRIC_EXECUTION_TRACE_KIND,
  version: FABRIC_EXECUTION_TRACE_VERSION,
  outcome,
  phases: [],
  operations,
  counts: {
    droppedValues: 0,
    truncatedValues: 0,
    redactedValues: 0,
    droppedOperations: 0,
  },
});

describe("formatFailureProgress", () => {
  it("tells the model where parked results live when the host kept them", () => {
    const operations = [{ ref: "pi.read", args: { path: "a.ts" }, outcome: "succeeded" as const }];
    const parked = formatFailureProgress(trace("failed", operations as never), 1);
    expect(parked).toContain("prior.get(ref, args)");
    expect(parked).toContain("prior.calls[i].result");
    const unparked = formatFailureProgress(trace("failed", operations as never));
    expect(unparked).not.toContain("prior.");
  });

  it("reports completed refs and paths without exposing results", () => {
    const formatted = formatFailureProgress(trace("failed", [
      {
        type: "call",
        sequence: 0,
        ref: "pi.read",
        args: { path: "src/input.ts", offset: 10, limit: 20 },
        outcome: "succeeded",
        result: "sensitive source text",
      },
      {
        type: "call",
        sequence: 1,
        ref: "pi.edit",
        args: { path: "src/output.ts" },
        outcome: "succeeded",
        result: { ok: true },
      },
      {
        type: "call",
        sequence: 2,
        ref: "pi.bash",
        args: { command: "npm test -- --runInBand" },
        outcome: "failed",
        error: "tests failed",
      },
    ]));

    expect(formatted).toContain("pi.read(src/input.ts); pi.edit(src/output.ts)");
    expect(formatted).toContain("inspect before repeating mutations");
    expect(formatted).not.toContain("sensitive source text");
    expect(formatted).not.toContain("npm test");
  });

  it("stays absent for successful runs or failures with no completed calls", () => {
    expect(formatFailureProgress(trace("succeeded", []))).toBeUndefined();
    expect(formatFailureProgress(trace("failed", [{
      type: "call",
      sequence: 0,
      ref: "pi.bash",
      args: {},
      outcome: "failed",
    }]))).toBeUndefined();
  });

  it("bounds long call lists and paths", () => {
    const operations: FabricExecutionTraceV1["operations"] = Array.from(
      { length: 12 },
      (_, sequence) => ({
        type: "call",
        sequence,
        ref: "pi.edit",
        args: { path: `src/${"nested/".repeat(30)}file-${sequence}.ts` },
        outcome: "succeeded",
      }),
    );
    const formatted = formatFailureProgress(trace("failed", operations));
    expect(formatted).toContain("+4 more");
    expect(formatted!.length).toBeLessThan(1_200);
  });
});

describe("parkedTruncationNotes", () => {
  const longLine = "[Line 1 is 1.2MB, exceeds 50.0KB limit. Use bash: sed -n '1p' /tmp/a.json | head -c 51200]";

  it("names a read that returned a notice in place of the file, and the call that fixes it", () => {
    const notes = parkedTruncationNotes([
      { ref: "pi.write", args: { path: "/tmp/q.sql" }, result: { ok: true, output: "", details: null } },
      { ref: "pi.read", args: { path: "/tmp/a.json" }, result: longLine },
    ]);
    expect(notes).toEqual([expect.stringContaining("prior.calls[1] pi.read(/tmp/a.json)")]);
    expect(notes[0]).toContain("raw: true");
  });

  it("flags a read cut by the line limit but not one the program limited itself", () => {
    const cut = "1\n2\n\n[Showing lines 1-2000 of 9000. Use offset=2001 to continue.]";
    expect(parkedTruncationNotes([{ ref: "pi.read", args: { path: "a" }, result: cut }])).toHaveLength(1);
    expect(parkedTruncationNotes([{ ref: "pi.read", args: { path: "a", limit: 2000 }, result: cut }])).toEqual([]);
    expect(parkedTruncationNotes([{ ref: "pi.read", args: { path: "a" }, result: "[1,2,3]" }])).toEqual([]);
  });

  it("flags truncated shell output and results cut by the nested result limit", () => {
    const notes = parkedTruncationNotes([
      { ref: "pi.bash", args: { command: "snowsql -f q.sql" }, result: { ok: true, output: "tail", truncated: true, fullOutputPath: "/tmp/out" } },
      { ref: "pi.bash", args: { command: "echo hi" }, result: { ok: true, output: "hi" } },
      { ref: "pi.bash", args: { command: "echo hi" }, result: { ok: true, output: "x", truncated: false } },
      { ref: "mcp.db.query", args: {}, result: { fabricTruncated: true, originalBytes: 9_000_000 } },
    ]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^prior\.calls\[0\] pi\.bash .*full: true/);
    expect(notes[0]).not.toContain("snowsql");
    expect(notes[1]).toMatch(/^prior\.calls\[3\] mcp\.db\.query .*maxNestedResultChars/);
  });

  it("bounds the number of notes", () => {
    const calls = Array.from({ length: 20 }, () => ({ ref: "pi.read", args: { path: "a" }, result: longLine }));
    expect(parkedTruncationNotes(calls)).toHaveLength(8);
  });

  it("adds the notes to the failure message", () => {
    const operations = [{ type: "call", sequence: 0, ref: "pi.read", args: { path: "/tmp/a.json" }, outcome: "succeeded" }];
    const formatted = formatFailureProgress(trace("failed", operations as never), 1, ["prior.calls[0] pi.read(/tmp/a.json) holds a notice"]);
    expect(formatted).toContain("Truncated results:\n- prior.calls[0] pi.read(/tmp/a.json) holds a notice");
    expect(formatFailureProgress(trace("failed", operations as never), 1)).not.toContain("Truncated results");
  });
});
