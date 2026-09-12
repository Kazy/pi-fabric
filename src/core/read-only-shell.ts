// Shell commands that only read the filesystem have typed pi.* equivalents.
// A model that writes `ls -la && cat x | head` inside pi.bash gets an untyped
// blob and a second round trip. Naming the replacement in the same result
// corrects the habit at the moment it shows, without blocking the call.

const READ_REPLACEMENTS: Readonly<Record<string, string>> = {
  ls: "pi.ls(path)",
  tree: "pi.ls(path)",
  cat: "pi.read({ path, offset, limit })",
  head: "pi.read({ path, offset, limit })",
  tail: "pi.read({ path, offset, limit })",
  grep: "pi.grep({ pattern, path, glob, limit })",
  egrep: "pi.grep({ pattern, path, glob, limit })",
  fgrep: "pi.grep({ pattern, path, glob, limit })",
  rg: "pi.grep({ pattern, path, glob, limit })",
  find: "pi.find({ pattern, path, limit })",
  fd: "pi.find({ pattern, path, limit })",
};

// Filters and shell plumbing that neither read files on their own nor write.
const NEUTRAL_COMMANDS = new Set([
  "cd", "echo", "printf", "wc", "sort", "uniq", "cut", "tr", "awk", "sed", "xargs",
  "true", "false", "set", "export", "env", "pwd", "basename", "dirname", "realpath",
  "stat", "file", "test", "[", "column", "nl", "tac", "rev", "jq", "yq", "diff", "comm",
]);

// cat/head/tail read a file only with an operand; alone they filter stdin.
const STDIN_FILTERS = new Set(["cat", "head", "tail"]);

// find/fd flags that run or delete; the walk is then not a read.
const FIND_MUTATION_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-x", "--exec", "-X", "--exec-batch"]);

const CONTROL_FLOW = /(^|[\s;|&(])(for|while|until|if|case|function)\s|\$\(|`/;
const MAX_NOTES = 3;
const MAX_COMMAND_PREVIEW = 80;

// Split on `&&`, `||`, `;`, `|`, and newlines outside quotes. Returns
// undefined for a redirect that writes a file, because the command is then
// not read-only whatever else it does.
const splitSegments = (command: string): string[] | undefined => {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[++i];
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[++i];
      continue;
    }
    if (ch === ">") {
      // `2>&1` and `>/dev/null` discard; anything else writes a file.
      const rest = command.slice(i + 1).replace(/^>?\s*/, "");
      if (!rest.startsWith("&") && !rest.startsWith("/dev/null")) return undefined;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) return undefined;
  segments.push(current);
  return segments.map((segment) => segment.replace(/^[\s(]+|[\s)]+$/g, "")).filter(Boolean);
};

const words = (segment: string): string[] =>
  segment.split(/\s+/).filter(Boolean).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));

const hasFileOperand = (argv: string[]): boolean =>
  argv.slice(1).some((word) => !word.startsWith("-") && !/^\d?>/.test(word) && word !== "2>&1");

/** Undefined when the command is not read-only; otherwise the pi.* replacements in order of use. */
export const readOnlyShellReplacements = (command: string): string[] | undefined => {
  if (CONTROL_FLOW.test(command)) return undefined;
  const segments = splitSegments(command);
  if (!segments) return undefined;
  const replacements: string[] = [];
  for (const segment of segments) {
    let argv = words(segment);
    while (argv[0] === "xargs" || argv[0] === "sudo" || argv[0] === "env") argv = argv.slice(1);
    const head = argv[0];
    if (head === undefined) continue;
    if (head === "sed" && argv.includes("-i")) return undefined;
    if ((head === "find" || head === "fd") && argv.some((word) => FIND_MUTATION_FLAGS.has(word))) return undefined;
    const replacement = READ_REPLACEMENTS[head];
    if (replacement !== undefined) {
      if (STDIN_FILTERS.has(head) && !hasFileOperand(argv)) continue;
      if (!replacements.includes(replacement)) replacements.push(replacement);
      continue;
    }
    if (!NEUTRAL_COMMANDS.has(head)) return undefined;
  }
  return replacements.length > 0 ? replacements : undefined;
};

const preview = (command: string): string => {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > MAX_COMMAND_PREVIEW ? `${flat.slice(0, MAX_COMMAND_PREVIEW - 1)}\u2026` : flat;
};

/** One note per successful read-only pi.bash call, bounded, for the outer fabric_exec result. */
export const readOnlyShellNotes = (
  audits: ReadonlyArray<{ ref: string; success?: boolean; args?: Record<string, unknown> }>,
): string | undefined => {
  const notes: string[] = [];
  let index = 0;
  for (const audit of audits) {
    if (audit.ref !== "pi.bash" && audit.ref !== "pi.powershell") continue;
    index++;
    if (audit.success !== true) continue;
    const command = audit.args?.command;
    if (typeof command !== "string") continue;
    const replacements = readOnlyShellReplacements(command);
    if (!replacements) continue;
    notes.push(
      `- shell call ${index} (\`${preview(command)}\`) only reads files. Next time use ${replacements.join(", ")}; ` +
        "search a wildcard directory from its parent with `glob`.",
    );
    if (notes.length === MAX_NOTES) break;
  }
  return notes.length > 0 ? `Fabric notes:\n${notes.join("\n")}` : undefined;
};
