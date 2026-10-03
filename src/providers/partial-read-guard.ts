// A program that writes back text from a partial pi.read silently drops the
// rest of the file. Track, per fabric_exec invocation, which lines of each
// path the guest has seen, and refuse a whole-file pi.write until it saw all.

const SHOWING = /\n\n\[Showing lines (\d+)-(\d+) of (\d+)(?: \([^)]*\))?\. Use offset=\d+ to continue\.\]$/;
const MORE = /\n\n\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/;
const LONG_LINE = /^\[Line \d+ is [^\]]*, exceeds [^\]]* limit\. Use bash: [^\]]*\]$/;

type Coverage = { ranges: Array<[number, number]>; total: number | undefined; blocked: boolean };

export type PartialReadNotice = { path: string; seen: number; total: number | undefined };

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;

// Returns the 1-based inclusive line range the read covered and the file's
// line count when the result shows it. `total` stays undefined only for a
// read that started past line 1 without a notice, which reached the end.
export const readCoverage = (
  text: string,
  offset: unknown,
): { range: [number, number] | undefined; total: number | undefined } => {
  const start = positive(offset) ?? 1;
  if (LONG_LINE.test(text)) return { range: undefined, total: undefined };
  const showing = SHOWING.exec(text);
  if (showing) return { range: [Number(showing[1]), Number(showing[2])], total: Number(showing[3]) };
  const more = MORE.exec(text);
  if (more) {
    const end = Number(more[2]) - 1;
    return { range: [start, end], total: end + Number(more[1]) };
  }
  const end = start + text.split("\n").length - 1;
  return { range: [start, end], total: end };
};

const seenLines = (ranges: ReadonlyArray<[number, number]>, total: number): number => {
  let seen = 0;
  let next = 1;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const lo = Math.max(from, next);
    const hi = Math.min(to, total);
    if (hi >= lo) {
      seen += hi - lo + 1;
      next = hi + 1;
    }
  }
  return seen;
};

export class PartialReadGuard {
  readonly #invocations = new Map<string, Map<string, Coverage>>();

  recordRead(invocation: string, path: string, text: string, offset: unknown): void {
    const files = this.#invocations.get(invocation) ?? new Map<string, Coverage>();
    this.#invocations.set(invocation, files);
    const coverage = files.get(path) ?? { ranges: [], total: undefined, blocked: false };
    files.set(path, coverage);
    const { range, total } = readCoverage(text, offset);
    if (range) coverage.ranges.push(range);
    else coverage.blocked = true;
    if (total !== undefined) coverage.total = total;
  }

  // A successful write replaces the file with text the guest holds in full.
  recordWrite(invocation: string, path: string): void {
    this.#invocations.get(invocation)?.delete(path);
  }

  partial(invocation: string, path: string): PartialReadNotice | undefined {
    const coverage = this.#invocations.get(invocation)?.get(path);
    if (!coverage) return undefined;
    const total = coverage.total;
    const seen = total === undefined ? 0 : seenLines(coverage.ranges, total);
    if (!coverage.blocked && total !== undefined && seen >= total) return undefined;
    return { path, seen, total };
  }

  end(invocation: string): void {
    this.#invocations.delete(invocation);
  }
}

export const partialReadWriteError = ({ path, seen, total }: PartialReadNotice): Error =>
  new Error(
    `pi.write refused: this program read only part of ${path}` +
      (total === undefined ? "" : ` (${seen} of ${total} lines)`) +
      ". pi.read stops at 2000 lines or 50KB, so writing that text back would delete the rest of the file. " +
      "Change the file with pi.edit, or read every remaining range with pi.read offset before a whole-file pi.write. " +
      "If the new content is meant to replace the whole file, pass force: true.",
  );
