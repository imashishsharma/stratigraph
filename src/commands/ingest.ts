import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';

import { loadConfig, type ConfigOverrides } from '../config.js';
import { assertSchemaCurrent, openDatabase } from '../db/database.js';
import { createRun, finishRun } from '../db/run.js';
import { readFacts } from '../facts/ndjson.js';
import { SqliteFactWriter, type FactWriterStats } from '../facts/writer.js';
import { info } from '../log.js';

export interface IngestOptions extends ConfigOverrides {
  /** NDJSON file to read. Reads stdin when absent. */
  from?: string | undefined;
}

export interface IngestResult extends FactWriterStats {
  runId: number;
}

/**
 * Read a stream of NDJSON facts and write them into the store.
 *
 * This is the core's half of the extractor protocol. Extractors are separate
 * processes in whatever language suits their parser; all the core ever sees is
 * this stream. `stratigraph ingest --from facts.ndjson` is also how you replay a
 * captured extractor run without re-parsing anything.
 */
export async function runIngest(options: IngestOptions): Promise<IngestResult> {
  const config = loadConfig(options);
  const db = openDatabase(config.dbPath, { mustExist: true });
  try {
    assertSchemaCurrent(db);
    const run = createRun(db, config.repoPath);
    const writer = new SqliteFactWriter(db, run.id);
    const source: Readable = options.from ? createReadStream(options.from) : process.stdin;

    try {
      for await (const fact of readFacts(source)) {
        writer.write(fact);
      }
      const stats = writer.close();
      finishRun(db, run.id, 'ok');
      info(
        `run ${run.id}: ${stats.nodes} nodes (+${stats.stubs} stubs), ${stats.edges} edges, ` +
          `${stats.files} files, ${stats.diagnostics} diagnostics`,
      );
      return { runId: run.id, ...stats };
    } catch (err) {
      writer.close();
      finishRun(db, run.id, 'failed');
      throw err;
    }
  } finally {
    db.close();
  }
}
