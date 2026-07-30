/**
 * `stratigraph mcp` — serve the fact store over MCP on stdio.
 *
 * Layer 5, and the strictest layer boundary in the tool: this command opens the
 * database **read-only**, never starts an extractor, and never writes a row. A
 * stale database is reported as stale; it is not silently repaired. ADR-0015
 * has the reasoning, including why a tool call is a bad place to start a JVM.
 *
 * stdout belongs to the JSON-RPC transport, so nothing here may `print`.
 * Everything this command says goes to stderr, which is where MCP clients
 * collect a server's logs.
 */

import { existsSync } from 'node:fs';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig, type ConfigOverrides } from '../config.js';
import { assertSchemaCurrent, openDatabase, type Db } from '../db/database.js';
import { findRun, latestRun } from '../db/run.js';
import { info } from '../log.js';
import { createServer } from '../mcp/server.js';

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

export interface McpOptions extends ConfigOverrides {
  /** Serve a specific run instead of the most recent one. */
  run?: number | undefined;
}

export interface McpServing {
  runId: number;
  dbPath: string;
  db: Db;
  /** Resolves when the transport closes. */
  closed: Promise<void>;
}

/**
 * Resolve the run, open the store read-only, and serve until stdin closes.
 *
 * The run is pinned here rather than per call so that two answers in one
 * session cannot describe two different snapshots of the repository.
 */
export async function runMcp(options: McpOptions): Promise<McpServing> {
  const config = loadConfig(options);

  if (!existsSync(config.dbPath)) {
    throw new McpError(
      `no fact store at ${config.dbPath} — the MCP server only reads, it never extracts. ` +
        `Run \`stratigraph init\`, then \`stratigraph extract\` and \`stratigraph history\`, ` +
        `then start this again.`,
    );
  }

  const db = openDatabase(config.dbPath, { mustExist: true, readonly: true });
  try {
    assertSchemaCurrent(db);

    const run = options.run === undefined ? latestRun(db) : findRun(db, options.run);
    if (run === null) {
      throw new McpError(
        options.run === undefined
          ? `${config.dbPath} contains no runs. Run \`stratigraph extract\` or ` +
            `\`stratigraph history\` first.`
          : `run ${options.run} is not in ${config.dbPath}.`,
      );
    }

    const server = createServer({
      db,
      runId: run.id,
      minCommits: config.history.minCommits,
    });

    const transport = new StdioServerTransport();
    const closed = new Promise<void>((resolve) => {
      transport.onclose = () => {
        db.close();
        resolve();
      };
    });

    await server.connect(transport);
    // stderr: stdout is the protocol. Clients surface this in their logs, and
    // it is the one line that says which snapshot the answers describe.
    info(
      `serving run ${run.id} of ${run.repoPath} (${run.repoHead ?? 'unknown head'}) ` +
        `from ${config.dbPath}, read-only`,
    );

    return { runId: run.id, dbPath: config.dbPath, db, closed };
  } catch (err) {
    if (db.open) db.close();
    throw err;
  }
}
