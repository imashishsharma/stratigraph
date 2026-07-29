import { loadConfig, type ConfigOverrides } from '../config.js';
import { detectClusters, type ClusterResult } from '../analysis/clusters.js';
import {
  computeTemporalCoupling,
  type CoupledPair,
  type CouplingStats,
} from '../analysis/coupling.js';
import { detectPackageCycles, type CycleFinding } from '../analysis/cycles.js';
import { recordHistoryFindings, type RecordedFindings } from '../analysis/history-findings.js';
import { busFactorRisks, topHotspots, type Hotspot } from '../analysis/hotspots.js';
import {
  detectIntentMismatches,
  type IntentMismatch,
} from '../analysis/intent-mismatch.js';
import { buildPackageGraph, DEPENDENCY_EDGE_KINDS } from '../analysis/package-graph.js';
import { assertSchemaCurrent, openDatabase, type Db } from '../db/database.js';
import { latestRun } from '../db/run.js';
import { info, print } from '../log.js';

/** Rows per report section, unless `--top` says otherwise. */
export const DEFAULT_TOP = 20;

export interface AnalyzeOptions extends ConfigOverrides {
  /** Analyse a specific run instead of the most recent one. */
  run?: number | undefined;
  /** Rows per section. */
  top?: number | undefined;
}

export interface AnalyzeResult {
  runId: number;
  packages: number;
  dependencies: number;
  cycles: CycleFinding[];
  /** Reported pairs: the top ones with no static dependency. */
  coupling: CoupledPair[];
  couplingStats: CouplingStats | null;
  hotspots: Hotspot[];
  busFactor: Hotspot[];
  /** Layer 4: the package partition. Null when there are no packages to group. */
  clusters: ClusterResult | null;
  /** Layer 4: packages whose name and edges disagree. */
  mismatches: IntentMismatch[];
  findings: RecordedFindings | null;
  /**
   * Whether this run has any extracted dependency to have checked against.
   *
   * Without one, every pair's `staticEdges` is zero because nothing was
   * looked at, not because nothing connects them. The two must not read the
   * same in a report.
   */
  staticGraph: boolean;
}

/**
 * Derive structure from facts already in the store.
 *
 * Reads nothing from disk beyond the database — this is layers 2 and 3 into
 * layer 4, and layers do not reach backwards. Everything it writes is a
 * `finding` carrying citations: into `edge` rows for cycles, into commit shas
 * for everything history-derived.
 *
 * Each section runs only if its input exists, so a run with facts and no
 * history works, and so does a run with history and no facts — which is the
 * normal case on a machine with no JDK.
 */
export function runAnalyze(options: AnalyzeOptions): AnalyzeResult {
  const config = loadConfig(options);
  const top = options.top ?? DEFAULT_TOP;
  const db = openDatabase(config.dbPath, { mustExist: true });
  try {
    assertSchemaCurrent(db);

    const runId = options.run ?? latestRun(db)?.id;
    if (runId === undefined) {
      throw new AnalysisError(
        `no runs in ${config.dbPath} — run \`stratigraph extract\` or \`stratigraph history\` first`,
      );
    }

    const graph = buildPackageGraph(db, runId);
    const commits = countCommits(db, runId);

    if (graph.packages.size === 0 && commits === 0) {
      throw new AnalysisError(
        `run ${runId} contains neither code facts nor history — nothing to analyse. ` +
          `Run \`stratigraph extract\` for structure, \`stratigraph history\` for churn ` +
          `and coupling, or both.`,
      );
    }

    const result: AnalyzeResult = {
      runId,
      packages: graph.packages.size,
      dependencies: graph.dependencies.length,
      cycles: [],
      coupling: [],
      couplingStats: null,
      hotspots: [],
      busFactor: [],
      clusters: null,
      mismatches: [],
      findings: null,
      staticGraph: countDependencyEdges(db, runId) > 0,
    };

    if (graph.packages.size > 0) {
      result.cycles = detectPackageCycles(db, runId);
      info(
        `run ${runId}: ${graph.packages.size} packages, ${graph.dependencies.length} package dependencies`,
      );

      // Layer 4, but algorithmic: clustering and the mismatch rule need no
      // model, which is what lets `--no-llm` produce a complete report.
      result.clusters = detectClusters(db, runId, config.interpret);
      result.mismatches = detectIntentMismatches(db, runId, result.clusters.clusters);
      info(
        `run ${runId}: ${result.clusters.clusters.length} clusters ` +
          `(modularity ${result.clusters.modularity.toFixed(3)}), ` +
          `${result.mismatches.length} intent mismatches`,
      );
    }

    if (commits > 0) {
      const { stats, pairs } = computeTemporalCoupling(db, runId, config.history);
      result.couplingStats = stats;
      // The pairs worth reporting are the ones the static graph cannot see.
      result.coupling = pairs.filter((pair) => pair.staticEdges === 0).slice(0, top);
      result.hotspots = topHotspots(db, runId, top);
      result.busFactor = busFactorRisks(db, runId, top, config.history.minCommits);
      result.findings = recordHistoryFindings(db, runId, {
        pairs: result.coupling,
        hotspots: result.hotspots,
        busFactor: result.busFactor,
        staticGraph: result.staticGraph,
      });
      info(
        `run ${runId}: ${commits} commits, ${stats.commitsConsidered} considered, ` +
          `${stats.stored} coupled pairs stored`,
      );
    }

    report(result, top, graph.packages.size, commits, config.interpret.couplingWeight);
    return result;
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

function countCommits(db: Db, runId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM git_commit WHERE run_id = ?').get(runId) as {
      n: number;
    }
  ).n;
}

/**
 * Edges of the kinds that mean "code here depends on code there".
 *
 * Counted rather than inferred from the package graph, because a single-module
 * repository has plenty of dependencies and no *package-level* ones.
 */
function countDependencyEdges(db: Db, runId: number): number {
  const kinds = DEPENDENCY_EDGE_KINDS.map((kind) => `'${kind}'`).join(', ');
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM edge
          WHERE run_id = ? AND confidence = 'fact' AND kind IN (${kinds})`,
      )
      .get(runId) as { n: number }
  ).n;
}

/**
 * The findings are the command's product, so they go to stdout, and each one
 * prints the evidence that justifies it — the edges for a cycle, the commits
 * for anything history-derived. A claim the reader cannot check without
 * opening the database is the unfalsifiable kind this project is written
 * against.
 */
function report(
  result: AnalyzeResult,
  top: number,
  packages: number,
  commits: number,
  couplingWeight: number,
): void {
  reportCycles(result.cycles, packages);
  reportClusters(result.clusters, top, couplingWeight);
  reportMismatches(result.mismatches, top);
  reportCoupling(result, top);
  reportHotspots(result.hotspots, top);
  reportBusFactor(result.busFactor, top);
  if (commits === 0) {
    print('');
    print('No history mined for this run — run `stratigraph history` for churn and coupling.');
  }
}

/**
 * Clusters, with the knob that produced them printed alongside.
 *
 * `couplingWeight` decides how much history is allowed to move a package
 * (ADR-0012), so a reader who disagrees with the grouping can see which value
 * produced it and change it, rather than arguing with a black box.
 */
function reportClusters(
  clusters: ClusterResult | null,
  top: number,
  couplingWeight: number,
): void {
  if (clusters === null) return;

  const grouped = clusters.clusters.filter((cluster) => cluster.members.length > 1);
  print('');
  if (grouped.length === 0) {
    print('No package clusters: nothing groups with anything else.');
    return;
  }

  print(
    `${grouped.length} package ${grouped.length === 1 ? 'cluster' : 'clusters'} ` +
      `(modularity ${clusters.modularity.toFixed(3)}, coupling weight ${couplingWeight}):`,
  );
  if (clusters.stats.couplingRows > 0) {
    print(
      `  ${clusters.stats.couplingRowsPlaced} of ${clusters.stats.couplingRows} coupled pairs ` +
        `sit in two different packages and took part; the rest name a file no extractor ` +
        `parsed, or two files in one package.`,
    );
  }

  for (const [n, cluster] of grouped.slice(0, top).entries()) {
    print('');
    const label = cluster.name === null ? cluster.prefix : `${cluster.name} (${cluster.prefix})`;
    print(`${n + 1}. ${label} — ${cluster.members.length} packages`);
    if (cluster.description !== null) print(`   ${cluster.description}`);
    for (const member of cluster.members) print(`     ${member.fqn}`);
  }

  print('');
  if (grouped.length > top) {
    print(`  Showing ${top} of ${grouped.length} clusters — raise --top for more.`);
  }
  if (clusters.singletons > 0) {
    // A package that groups with nothing is a fact about the graph, but three
    // hundred of them one per line would bury the clusters that matter.
    print(`  ${clusters.singletons} package(s) group with nothing and are not listed.`);
  }
  if (clusters.clusters.every((cluster) => cluster.name === null)) {
    print('  Cluster names and descriptions are not written: no interpretation ran.');
  }
}

/** The sharpest thing the structural report produces. See ADR-0014. */
function reportMismatches(mismatches: IntentMismatch[], top: number): void {
  if (mismatches.length === 0) return;

  print('');
  print(`Packages whose name and edges disagree (top ${top}):`);
  for (const [n, mismatch] of mismatches.slice(0, top).entries()) {
    print('');
    print(`${n + 1}. [${mismatch.severity}] ${mismatch.title}`);
    print(mismatch.detail);
  }
  if (mismatches.length > top) {
    print('');
    print(`  Showing ${top} of ${mismatches.length} — raise --top for more.`);
  }
}

function reportCycles(cycles: CycleFinding[], packages: number): void {
  if (packages === 0) return;
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

function reportCoupling(result: AnalyzeResult, top: number): void {
  const stats = result.couplingStats;
  if (stats === null) return;

  const withDependency = stats.withStaticDependency;
  const unexplained = stats.stored - withDependency;

  print('');
  print(
    result.staticGraph
      ? `Files that change together with no dependency between them (top ${top}):`
      : `Files that change together (top ${top}):`,
  );
  if (!result.staticGraph) {
    // Without extraction every pair has zero static edges — because nothing
    // was looked at, not because nothing connects them. Saying "no dependency"
    // here would assert an absence that was never established.
    print(
      '  This run has no extracted code, so none of these were checked for a dependency.',
    );
    print('  Run `stratigraph extract` to separate hidden coupling from ordinary imports.');
  }

  if (result.coupling.length === 0) {
    print('  None.');
    // Distinguish "looked and found nothing" from "could not look", because
    // an empty section reads like a clean repository either way.
    print(
      `  ${stats.commitsConsidered} commits considered, ${stats.pairsSeen} co-changing pairs seen; ` +
        `${stats.pairsBelowMinShared} below the shared-commit floor, ` +
        `${stats.pairsBelowLift} no more often than chance.`,
    );
    if (withDependency > 0) {
      print(
        `  ${withDependency} coupled pair(s) were found, but the static graph already ` +
          `explains all of them.`,
      );
    }
    if (stats.commitsCapped > 0) {
      print(`  ${stats.commitsCapped} commits were too broad to pair (see history.maxFilesPerCommit).`);
    }
    return;
  }

  for (const [n, pair] of result.coupling.entries()) {
    print('');
    print(`${n + 1}. ${pair.pathA}`);
    print(`   ${pair.pathB}`);
    print(
      `   ${pair.shared} shared commits — strength ${pair.strength.toFixed(2)}, ` +
        `${pair.lift.toFixed(1)}x chance ` +
        `(${pair.commitsA} and ${pair.commitsB} commits respectively)`,
    );
    // Two build files can never have an edge between them, so "no static
    // dependency" is true of them and says nothing. Marked, so a reader
    // scanning the list can tell the checkable findings from the rest.
    if (result.staticGraph && !(pair.parsedA && pair.parsedB)) {
      const unparsed = [
        ...(pair.parsedA ? [] : [pair.pathA]),
        ...(pair.parsedB ? [] : [pair.pathB]),
      ];
      print(
        `   note: no extractor parses ${unparsed.length === 2 ? 'either file' : unparsed[0]}, ` +
          `so nothing could have connected them`,
      );
    }
  }

  print('');
  if (unexplained > result.coupling.length) {
    // Showing 20 of 300 and saying nothing reads as "there are 20".
    print(
      `  Showing ${result.coupling.length} of ${unexplained} pairs with no static dependency ` +
        `— raise --top for more.`,
    );
  }
  if (withDependency > 0) {
    print(
      `  ${stats.stored} coupled pairs stored in total; ${withDependency} of them already ` +
        `have a dependency in the static graph and are not repeated here.`,
    );
  }
  if (stats.commitsCapped > 0) {
    print(`  ${stats.commitsCapped} commits were too broad to pair (see history.maxFilesPerCommit).`);
  }
}

function reportHotspots(hotspots: Hotspot[], top: number): void {
  if (hotspots.length === 0) return;
  print('');
  print(`Hotspots — churn x complexity (top ${top}):`);
  for (const [n, file] of hotspots.entries()) {
    print(
      `${String(n + 1).padStart(3)}. ${file.path}` +
        `\n     ${file.commits} commits, ${file.churn} lines changed, indentation ${file.complexity}, ` +
        `${file.authors} author(s), bus factor ${file.busFactor}`,
    );
  }
}

function reportBusFactor(files: Hotspot[], top: number): void {
  if (files.length === 0) return;
  print('');
  print(`Files whose history is one person (top ${top}):`);
  for (const file of files) {
    print(
      `   ${file.path} — ${Math.round(file.topAuthorShare * 100)}% of ${file.commits} commits, ` +
        `${file.authors} author(s) in total`,
    );
  }
}
