/**
 * Progress and diagnostics go to stderr; a command's actual product goes to
 * stdout. So `stratigraph doctor > report.txt` captures the report, while
 * `stratigraph ingest` progress stays out of a pipe feeding `jq`.
 */
let quiet = false;

/** A command's output proper. Never suppressed by --quiet. */
export function print(message: string): void {
  process.stdout.write(`${message}\n`);
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
