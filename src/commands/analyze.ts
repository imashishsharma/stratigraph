import { loadConfig, type ConfigOverrides } from '../config.js';
import { detectPackageCycles, type CycleFinding } from '../analysis/cycles.js';
import { buildPackageGraph } from '../analysis/package-graph.js';
import { assertSchemaCurrent, openDatabase } from '../db/database.js';
import { latestRun } from '../db/run.js';
import { info, print } from '../log.js';

export interface AnalyzeOptions extends ConfigOverrides {
  /** Analyse a specific run instead of the most recent one. */
  run?: number | undefined;
}

export interface AnalyzeResult {
  runId: number;
  packages: number;
  dependencies: number;
  cycles: CycleFinding[];
}

/**
 * Derive structure from facts already in the store.
 *
 * Reads nothing from disk beyond the database — this is layer 2 → layer 4, and
 * layers do not reach backwards. Everything it writes is a `finding` carrying
 * citations into the `edge` rows that produced it.
 */
export function runAnalyze(options: AnalyzeOptions): AnalyzeResult {
  const config = loadConfig(options);
  const db = openDatabase(config.dbPath, { mustExist: true });
  try {
    assertSchemaCurrent(db);

    const runId = options.run ?? latestRun(db)?.id;
    if (runId === undefined) {
      throw new AnalysisError(
        `no facts in ${config.dbPath} — run \`stratigraph extract\` first`,
      );
    }

    const graph = buildPackageGraph(db, runId);
    if (graph.packages.size === 0) {
      throw new AnalysisError(
        `run ${runId} contains no packages — nothing to analyse`,
      );
    }

    const cycles = detectPackageCycles(db, runId);
    info(
      `run ${runId}: ${graph.packages.size} packages, ${graph.dependencies.length} package dependencies`,
    );

    report(cycles);

    return {
      runId,
      packages: graph.packages.size,
      dependencies: graph.dependencies.length,
      cycles,
    };
  } finally {
    db.close();
  }
}

export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisError';
  }
}

/**
 * The findings are the command's product, so they go to stdout. Each hop prints
 * the edges that justify it, because "these packages form a cycle" is a claim
 * the reader must be able to check without opening the database.
 */
function report(cycles: CycleFinding[]): void {
  if (cycles.length === 0) {
    print('No package cycles found.');
    return;
  }

  print(`${cycles.length} package ${cycles.length === 1 ? 'cycle' : 'cycles'}:`);
  for (const [n, cycle] of cycles.entries()) {
    print('');
    print(`${n + 1}. [${cycle.severity}] ${cycle.path.join(' → ')} → ${cycle.path[0]}`);
    if (cycle.componentSize > cycle.path.length) {
      print(
        `   shortest cycle in a component of ${cycle.componentSize} mutually dependent packages`,
      );
    }
    for (const hop of cycle.hops) {
      print(`   ${hop.from} → ${hop.to}`);
      for (const edge of hop.evidence) {
        const where = edge.path
          ? `${edge.path}${edge.line === null ? '' : `:${edge.line}`}`
          : 'no file recorded';
        print(`     ${edge.kind}  ${edge.srcFqn} → ${edge.dstFqn}  [${where}]`);
      }
      if (hop.evidence.length === 0) print('     (no citable edge)');
    }
  }
}
