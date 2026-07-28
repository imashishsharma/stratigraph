/**
 * Logs go to stderr, always. stdout belongs to machine-readable output so that
 * `stratigraph ... | jq` keeps working.
 */
let quiet = false;

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
