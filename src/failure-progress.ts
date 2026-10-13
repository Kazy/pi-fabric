import type { FabricExecutionTraceV1 } from "./audit/trace.js";
import { isPiShellRef } from "./core/pi-tools.js";
import { isPartialReadText } from "./providers/partial-read-guard.js";
import type { FabricPriorCall } from "./runtime/kernel.js";

const MAX_COMPLETED_CALLS = 8;
const MAX_TRUNCATED_NOTES = 8;
const MAX_PATH_CHARS = 100;

const compactPath = (value: string): string => {
  const singleLine = value.replaceAll(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_PATH_CHARS) return singleLine;
  return `…${singleLine.slice(-(MAX_PATH_CHARS - 1))}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const truncationFix = ({ ref, args, result }: FabricPriorCall): string | undefined => {
  if (isRecord(result) && result.fabricTruncated === true) {
    return "was cut at executor.maxNestedResultChars. Write the data to a file and process it in parts.";
  }
  // An explicit limit asks for part of the file, so its notice is expected.
  if (ref === "pi.read" && typeof result === "string" && args.limit === undefined && isPartialReadText(result)) {
    return "holds a truncation notice, not the whole file. Use pi.read({path, raw: true}).";
  }
  if (isPiShellRef(ref) && isRecord(result) && result.truncated === true) {
    return "holds only the end of the output. Pass full: true, or read fullOutputPath with pi.read({path, raw: true}).";
  }
  return undefined;
};

/**
 * Parked results that are not the full data. A program that parses them
 * fails with an error that does not name the cause, so name it here.
 */
export const parkedTruncationNotes = (calls: readonly FabricPriorCall[]): string[] => {
  const notes: string[] = [];
  for (const [index, call] of calls.entries()) {
    const fix = truncationFix(call);
    if (!fix) continue;
    const path = call.args.path;
    const label = typeof path === "string" ? `${call.ref}(${compactPath(path)})` : call.ref;
    notes.push(`prior.calls[${index}] ${label} ${fix}`);
    if (notes.length >= MAX_TRUNCATED_NOTES) break;
  }
  return notes;
};

export const formatFailureProgress = (
  trace: FabricExecutionTraceV1,
  parkedPriorCalls = 0,
  truncationNotes: readonly string[] = [],
): string | undefined => {
  if (trace.outcome === "succeeded") return undefined;
  const completed = trace.operations.filter(
    (operation) => operation.outcome === "succeeded",
  );
  if (completed.length === 0) return undefined;
  const summaries = completed.slice(0, MAX_COMPLETED_CALLS).map((operation) => {
    const path = operation.args.path;
    return typeof path === "string"
      ? `${operation.ref}(${compactPath(path)})`
      : operation.ref;
  });
  const omitted = completed.length - summaries.length;
  const parkedNote = parkedPriorCalls > 0
    ? `Their results are parked: in your next fabric_exec program read \`prior.get(ref, args)\` or \`prior.calls[i].result\` (typed from the parked values, cleared when that program runs) instead of calling them again.`
    : undefined;
  return [
    `Completed before the outer failure (outputs not returned): ${summaries.join("; ")}${
      omitted > 0 ? `; +${omitted} more` : ""
    }.`,
    ...(parkedNote ? [parkedNote] : []),
    ...(truncationNotes.length > 0 ? ["Truncated results:", ...truncationNotes.map((note) => `- ${note}`)] : []),
    "Successful calls may already have changed the workspace; inspect before repeating mutations.",
  ].join("\n");
};
