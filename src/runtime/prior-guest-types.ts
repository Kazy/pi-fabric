import type { FabricPriorCall } from "./kernel.js";

// Renders the `prior` declaration from the calls parked by the previous
// failed program. Args become literal types so an overload matches only the
// exact parked call; results become structural types from the parked value.
// A non-matching call must fail as TS2769 (no overload), because the checker
// suppresses plain assignability misses (TS2345) by design.

const MAX_DEPTH = 5;
const MAX_MEMBERS = 64;
const MAX_LITERAL_ARG_CHARS = 2_000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const propertyKey = (name: string): string =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);

const literalType = (value: unknown, depth: number): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "number";
  if (depth >= MAX_DEPTH) return "unknown";
  if (Array.isArray(value)) {
    if (value.length === 0) return "readonly []";
    return `readonly [${value.slice(0, MAX_MEMBERS).map((entry) => literalType(entry, depth + 1)).join(", ")}]`;
  }
  if (isRecord(value)) {
    const members = Object.keys(value).sort().slice(0, MAX_MEMBERS)
      .map((key) => `${propertyKey(key)}: ${literalType(value[key], depth + 1)}`);
    return members.length === 0 ? "Record<string, never>" : `{ ${members.join("; ")} }`;
  }
  return "unknown";
};

const shapeType = (value: unknown, depth: number): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (depth >= MAX_DEPTH) return "unknown";
  if (Array.isArray(value)) {
    if (value.length === 0) return "unknown[]";
    const members = [...new Set(value.slice(0, MAX_MEMBERS).map((entry) => shapeType(entry, depth + 1)))];
    return `Array<${members.join(" | ")}>`;
  }
  if (isRecord(value)) {
    const members = Object.keys(value).sort().slice(0, MAX_MEMBERS)
      .map((key) => `${propertyKey(key)}: ${shapeType(value[key], depth + 1)}`);
    return members.length === 0 ? "Record<string, never>" : `{ ${members.join("; ")} }`;
  }
  return "unknown";
};

// Long literal args (a whole file passed to write) would bloat the declaration;
// fall back to the structural shape, which still pins the key set.
const argsType = (args: Record<string, unknown>): string => {
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? "{}";
  } catch {
    return "Record<string, unknown>";
  }
  return serialized.length > MAX_LITERAL_ARG_CHARS ? shapeType(args, 0) : literalType(args, 0);
};

export const buildPriorGuestDeclarations = (calls: readonly FabricPriorCall[]): string => {
  const refCounts = new Map<string, number>();
  for (const call of calls) refCounts.set(call.ref, (refCounts.get(call.ref) ?? 0) + 1);
  const entries = calls.map((call) => ({
    ref: JSON.stringify(call.ref),
    args: argsType(call.args),
    result: shapeType(call.result, 0),
    unique: refCounts.get(call.ref) === 1,
  }));
  const tuple = entries.length === 0
    ? "readonly []"
    : `readonly [\n${entries.map((entry) => `    { ref: ${entry.ref}; args: ${entry.args}; result: ${entry.result} }`).join(",\n")}\n  ]`;
  const overloads = entries.map((entry) =>
    `  get(ref: ${entry.ref}, args${entry.unique ? "?" : ""}: ${entry.args}): ${entry.result};`,
  );
  // With a single arity-compatible signature TypeScript reports TS2345, which
  // the checker suppresses. A second signature turns a miss into TS2769, and
  // an empty store makes get a non-callable `never` (TS2349) instead.
  const closing = entries.length === 0
    ? ["  get: never;"]
    : ["  get(ref: never, args?: never): never;"];
  return [
    "// Results parked by the previous failed fabric_exec program; typed from the parked values.",
    "interface FabricPriorParkedApi {",
    `  calls: ${tuple};`,
    ...overloads,
    ...closing,
    "}",
    "declare const prior: FabricPriorParkedApi;",
    "",
  ].join("\n");
};
