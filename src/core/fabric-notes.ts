// Notes appended to the outer fabric_exec result when a program used a pattern
// that has a safer pi.* form. They reach the model at the moment the habit
// shows, which rules in the prompt alone did not achieve. Nothing is blocked.
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { readOnlyShellNoteLines } from "./read-only-shell.js";

type NoteAudit = { ref: string; success?: boolean; args?: Record<string, unknown> };

const MAX_REWRITE_PATHS = 3;

// Same rules as the pi read/write tools, so `./a`, `a` and `@a` match.
export const resolveToolPath = (path: string, cwd: string): string => {
  let expanded = path.startsWith("@") ? path.slice(1) : path;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = homedir() + expanded.slice(1);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
};

const pathArg = (audit: NoteAudit): string | undefined => {
  const path = audit.args?.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
};

// A pi.write to a file that the same program read with pi.read is almost always
// read + String.replace + write. That form hides a missing anchor (no change,
// write still succeeds), changes only the first match, and expands `$&`/`$1`
// in the new text. pi.edit fails on all three.
export const readThenWriteNoteLines = (
  audits: ReadonlyArray<NoteAudit>,
  cwd: string,
): string[] => {
  const read = new Set<string>();
  const rewritten: string[] = [];
  const seen = new Set<string>();
  for (const audit of audits) {
    const path = pathArg(audit);
    if (path === undefined || audit.success !== true) continue;
    const resolved = resolveToolPath(path, cwd);
    if (audit.ref === "pi.read") read.add(resolved);
    else if (audit.ref === "pi.write" && read.has(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      rewritten.push(path);
    }
  }
  if (rewritten.length === 0) return [];
  const shown = rewritten.slice(0, MAX_REWRITE_PATHS).map((path) => `\`${path}\``).join(", ");
  const more = rewritten.length > MAX_REWRITE_PATHS ? ` (+${rewritten.length - MAX_REWRITE_PATHS} more)` : "";
  return [
    `- pi.write replaced ${shown}${more} after this program read it. For partial changes use ` +
      "`pi.edit({ path, edits: [{ oldText, newText }] })`: it fails on a missing or repeated anchor. " +
      "String.replace skips a missing anchor without error, changes only the first match, and expands `$&`/`$1` in the new text.",
  ];
};

export const fabricNotes = (audits: ReadonlyArray<NoteAudit>, cwd: string): string | undefined => {
  const lines = [...readThenWriteNoteLines(audits, cwd), ...readOnlyShellNoteLines(audits)];
  return lines.length > 0 ? `Fabric notes:\n${lines.join("\n")}` : undefined;
};
