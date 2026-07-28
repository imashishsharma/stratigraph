import type { Readable } from 'node:stream';

import type { Db } from '../db/database.js';
import { readFacts } from './ndjson.js';
import { SqliteFactWriter, type FactWriterStats } from './writer.js';

/**
 * Read a stream of NDJSON facts into the store under an open run.
 *
 * The core's half of the extractor protocol, shared by `ingest` (reading a
 * captured file or stdin) and `extract` (reading a spawned extractor's stdout).
 * Run lifecycle stays with the caller, because `extract` can only decide
 * whether a run succeeded after the child process has also exited.
 */
export async function ingestInto(
  db: Db,
  runId: number,
  source: Readable,
): Promise<FactWriterStats> {
  const writer = new SqliteFactWriter(db, runId);
  try {
    for await (const fact of readFacts(source)) {
      writer.write(fact);
    }
    return writer.close();
  } catch (err) {
    // Commit what was read before the bad line: a partial run that says it
    // failed is more useful for diagnosis than an empty one.
    writer.close();
    throw err;
  }
}
