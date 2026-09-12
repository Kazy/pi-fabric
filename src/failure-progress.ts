import type { FabricExecutionTraceV1 } from "./audit/trace.js";

const MAX_COMPLETED_CALLS = 8;
const MAX_PATH_CHARS = 100;

const compactPath = (value: string): string => {
  const singleLine = value.replaceAll(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_PATH_CHARS) return singleLine;
  return `…${singleLine.slice(-(MAX_PATH_CHARS - 1))}`;
};

export const formatFailureProgress = (
  trace: FabricExecutionTraceV1,
  parkedPriorCalls = 0,
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
    "Successful calls may already have changed the workspace; inspect before repeating mutations.",
  ].join("\n");
};
