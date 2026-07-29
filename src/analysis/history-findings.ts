/**
 * History claims, written as findings with commit citations.
 *
 * ADR-0010 draws the line: `file_metric` and `temporal_coupling` hold counts,
 * and these three rules hold claims about what the counts mean. Each cites the
 * commits that produced it, so a reader who disagrees can run `git show` and
 * settle it — which is also what makes M2's acceptance criterion answerable at
 * all.
 *
 * Citations are commits rather than files because `citation.file_id` points at
 * `source_file`, which only has rows for files an extractor walked. History
 * covers the XML, SQL and properties files no extractor parses, and those turn
 * up in coupling pairs constantly.
 */

import type { Db } from '../db/database.js';
import type { CoupledPair } from './coupling.js';
import type { Hotspot } from './hotspots.js';

export const COUPLING_RULE = 'logical-coupling';
export const HOTSPOT_RULE = 'hotspot';
export const BUS_FACTOR_RULE = 'bus-factor';

const RULES = [COUPLING_RULE, HOTSPOT_RULE, BUS_FACTOR_RULE];

/** Commits cited per finding. Enough to check the claim, few enough to read. */
const EVIDENCE = 5;

export interface RecordedFindings {
  coupling: number;
  hotspots: number;
  busFactor: number;
}

/**
 * Write the three history rules for a run, replacing any from a previous
 * analysis. Citations go with them by `ON DELETE CASCADE`.
 */
export function recordHistoryFindings(
  db: Db,
  runId: number,
  input: {
    pairs: readonly CoupledPair[];
    hotspots: readonly Hotspot[];
    busFactor: readonly Hotspot[];
    /**
     * Whether this run has a static graph to have checked against.
     *
     * Without it, `staticEdges = 0` for every pair — not because nothing
     * connects them but because nothing was looked at. Reporting that as "no
     * dependency" would be asserting an absence never established, which is
     * the failure CLAUDE.md is written against.
     */
    staticGraph: boolean;
  },
): RecordedFindings {
  const insertFinding = db.prepare(
    `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by)
     VALUES (@runId, @rule, @title, @detail, @severity, 'algorithm')`,
  );
  const insertCitation = db.prepare(
    `INSERT INTO citation (finding_id, kind, commit_sha) VALUES (?, 'commit', ?)`,
  );

  const sharedCommits = db.prepare(
    /* sql */ `
    SELECT c.sha FROM git_commit c
     WHERE c.run_id = @runId AND c.is_merge = 0
       AND EXISTS (SELECT 1 FROM commit_file f
                    WHERE f.commit_id = c.id AND f.canonical_path = @a)
       AND EXISTS (SELECT 1 FROM commit_file f
                    WHERE f.commit_id = c.id AND f.canonical_path = @b)
     ORDER BY c.authored_at DESC
     LIMIT @limit`,
  );
  const churnCommits = db.prepare(
    /* sql */ `
    SELECT c.sha FROM commit_file f
      JOIN git_commit c ON c.id = f.commit_id
     WHERE f.run_id = @runId AND f.canonical_path = @path AND c.is_merge = 0
     ORDER BY (f.insertions + f.deletions) DESC, c.authored_at DESC
     LIMIT @limit`,
  );
  const authorCommits = db.prepare(
    /* sql */ `
    SELECT c.sha FROM commit_file f
      JOIN git_commit c ON c.id = f.commit_id
     WHERE f.run_id = @runId AND f.canonical_path = @path AND c.is_merge = 0
       AND c.author_email = @email
     ORDER BY c.authored_at DESC
     LIMIT @limit`,
  );

  const write = (
    rule: string,
    title: string,
    detail: string,
    severity: string,
    shas: string[],
  ): void => {
    const findingId = Number(
      insertFinding.run({ runId, rule, title, detail, severity }).lastInsertRowid,
    );
    for (const sha of shas) insertCitation.run(findingId, sha);
  };

  const counts: RecordedFindings = { coupling: 0, hotspots: 0, busFactor: 0 };

  db.transaction(() => {
    for (const rule of RULES) {
      db.prepare('DELETE FROM finding WHERE run_id = ? AND rule = ?').run(runId, rule);
    }

    for (const pair of input.pairs) {
      // Only pairs the static graph cannot explain. A pair that co-changes and
      // also imports is the dependency doing its job, not news — and on a large
      // repository those would bury the ones that matter.
      if (pair.staticEdges > 0) continue;
      const shas = (
        sharedCommits.all({ runId, a: pair.pathA, b: pair.pathB, limit: EVIDENCE }) as Array<{
          sha: string;
        }>
      ).map((row) => row.sha);

      write(
        COUPLING_RULE,
        input.staticGraph
          ? `${pair.pathA} and ${pair.pathB} change together, with no dependency between them`
          : `${pair.pathA} and ${pair.pathB} change together`,
        [
          `  ${pair.shared} of the ${Math.min(pair.commitsA, pair.commitsB)} commits touching ` +
            `either file touch both (strength ${pair.strength.toFixed(2)}), ` +
            `${pair.lift.toFixed(1)}x what independent files would share.`,
          `  ${pair.pathA}: ${pair.commitsA} commits`,
          `  ${pair.pathB}: ${pair.commitsB} commits`,
          input.staticGraph
            ? `  No imports, calls, inheritance or injection connects them in the static graph.`
            : `  This run has no extracted code, so nothing was checked for a dependency — ` +
              `no evidence was found either way. Run \`stratigraph extract\` to establish it.`,
        ].join('\n'),
        pair.strength >= 0.8 ? 'high' : pair.strength >= 0.5 ? 'medium' : 'low',
        shas,
      );
      counts.coupling += 1;
    }

    for (const [index, file] of input.hotspots.entries()) {
      const shas = (
        churnCommits.all({ runId, path: file.path, limit: EVIDENCE }) as Array<{ sha: string }>
      ).map((row) => row.sha);

      write(
        HOTSPOT_RULE,
        `${file.path} is changed often and is structurally dense`,
        [
          `  ${file.commits} commits, ${file.churn} lines changed, indentation ${file.complexity}.`,
          `  ${file.authors} author(s); the most frequent wrote ` +
            `${Math.round(file.topAuthorShare * 100)}% of the commits.`,
          `  Indentation is a proxy for nesting, not a parsed measure of complexity.`,
        ].join('\n'),
        index < 3 ? 'high' : index < 10 ? 'medium' : 'low',
        shas,
      );
      counts.hotspots += 1;
    }

    for (const file of input.busFactor) {
      const shas =
        file.topAuthor === null
          ? []
          : (
              authorCommits.all({
                runId,
                path: file.path,
                email: file.topAuthor,
                limit: EVIDENCE,
              }) as Array<{ sha: string }>
            ).map((row) => row.sha);

      write(
        BUS_FACTOR_RULE,
        `${file.path} has a bus factor of ${file.busFactor}`,
        [
          `  ${Math.round(file.topAuthorShare * 100)}% of its ${file.commits} commits come from ` +
            `one author, out of ${file.authors} who have touched it.`,
          `  This is a statement about where knowledge is concentrated, not about the author.`,
        ].join('\n'),
        file.authors === 1 ? 'high' : 'medium',
        shas,
      );
      counts.busFactor += 1;
    }
  })();

  return counts;
}
