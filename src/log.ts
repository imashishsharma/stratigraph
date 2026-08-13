/**
 * Progress and diagnostics go to stderr; a command's actual product goes to
 * stdout. So `stratigraph doctor > report.txt` captures the report, while
 * `stratigraph ingest` progress stays out of a pipe feeding `jq`.
 */
let quiet = false;

/**
 * What stdout carries.
 *
 * `--format json` does not add a second stream, it replaces the product on the
 * one that already exists: the human lines a command prints are the same
 * information as the document, so emitting both would put two answers in one
 * pipe. Progress on stderr is unaffected either way, which is what lets
 * `stratigraph analyze --format json | jq` work with progress still visible.
 */
export type OutputFormat = 'text' | 'json';

let format: OutputFormat = 'text';

export function setFormat(value: OutputFormat): void {
  format = value;
}

export function outputFormat(): OutputFormat {
  return format;
}

/** A command's output proper. Never suppressed by --quiet; silent under JSON. */
export function print(message: string): void {
  if (format === 'json') return;
  process.stdout.write(`${message}\n`);
}

/** The whole product, as one document. Pretty-printed: these get read by people too. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function info(message: string): void {
  if (!quiet) process.stderr.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}
