/**
 * The evidence pack: everything the model is allowed to refer to, and nothing
 * else.
 *
 * Each item carries an opaque, pack-local id — `e12`, not the database's edge
 * id 88431. ADR-0013 explains why that indirection is the load-bearing part: a
 * model that guesses a database id lands on a real row, so guessing fails open;
 * a model that guesses `e99` in a pack of twelve lands on nothing, and the
 * response is rejected.
 *
 * The pack is structural metadata by default. Source bodies go only under
 * `--send-source`, which is off by default and logged loudly when on, per
 * CLAUDE.md.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ClusterSummary } from '../analysis/clusters.js';
import type { IntentMismatch } from '../analysis/intent-mismatch.js';
import { DEPENDENCY_EDGE_KINDS } from '../analysis/package-graph.js';
import type { Db } from '../db/database.js';

/** How much of each kind of evidence a pack carries. Enough to describe, few enough to read. */
const LIMITS = { edges: 24, files: 12, commits: 8, sourceFiles: 3, sourceLines: 120 } as const;

export interface EvidenceRef {
  nodeId?: number;
  edgeId?: number;
  fileId?: number;
  line?: number | null;
  commitSha?: string;
}

export interface EvidenceItem {
  /** Pack-local and opaque. The only thing the model may cite. */
  id: string;
  kind: 'node' | 'edge' | 'file' | 'commit';
  /** What the model sees. */
  text: string;
  /** How a citation resolves back to a row. Never sent to the model. */
  ref: EvidenceRef;
}

export interface EvidencePack {
  clusterId: number;
  prefix: string;
  members: string[];
  items: EvidenceItem[];
  /**
   * Every identifier the pack contains, plus every dotted prefix of every
   * member package. Rule 3 of the contract checks prose against this.
   */
  vocabulary: Set<string>;
  /** The mismatch this cluster carries, if the algorithm found one. */
  mismatch: IntentMismatch | null;
  /** Source excerpts, present only under `--send-source`. */
  source: Array<{ path: string; body: string }>;
}

export interface PackOptions {
  /** Send raw source bodies. Off by default; logged loudly when on. */
  sendSource: boolean;
  /** Repository root, for reading source when `sendSource` is set. */
  repoPath: string;
}

/**
 * Assemble the pack for one cluster.
 *
 * Everything in it comes from a query. Nothing is summarised or paraphrased on
 * the way in, because a paraphrase is already an interpretation and the point
 * of the pack is to be the ground the interpretation stands on.
 */
export function buildEvidencePack(
  db: Db,
  runId: number,
  cluster: ClusterSummary,
  mismatch: IntentMismatch | null,
  options: PackOptions,
): EvidencePack {
  const items: EvidenceItem[] = [];
  let counters = { n: 0, e: 0, f: 0, c: 0 };

  const push = (
    prefix: keyof typeof counters,
    kind: EvidenceItem['kind'],
    text: string,
    ref: EvidenceRef,
  ): void => {
    counters = { ...counters, [prefix]: counters[prefix] + 1 };
    items.push({ id: `${prefix}${counters[prefix]}`, kind, text, ref });
  };

  for (const member of cluster.members) {
    push('n', 'node', `package ${member.fqn}`, { nodeId: member.nodeId });
  }

  const nodeIds = cluster.members.map((member) => member.nodeId);
  for (const edge of clusterEdges(db, runId, nodeIds, LIMITS.edges)) {
    push(
      'e',
      'edge',
      `${edge.kind} ${edge.srcFqn} -> ${edge.dstFqn}` +
        (edge.path ? ` at ${edge.path}${edge.line === null ? '' : `:${edge.line}`}` : ''),
      { edgeId: edge.edgeId, line: edge.line },
    );
  }

  for (const file of clusterFiles(db, runId, nodeIds, LIMITS.files)) {
    push(
      'f',
      'file',
      `file ${file.path}` +
        (file.commits === null
          ? ''
          : ` — ${file.commits} commits, ${file.churn} lines changed, ` +
            `${file.authors} author(s)`),
      { fileId: file.fileId },
    );
  }

  for (const commit of clusterCommits(db, runId, nodeIds, LIMITS.commits)) {
    push('c', 'commit', `commit ${commit.sha} "${commit.subject ?? ''}"`, {
      commitSha: commit.sha,
    });
  }

  const source = options.sendSource
    ? readSource(db, runId, nodeIds, options.repoPath)
    : [];

  return {
    clusterId: cluster.clusterId,
    prefix: cluster.prefix,
    members: cluster.members.map((member) => member.fqn),
    items,
    vocabulary: buildVocabulary(items, cluster, mismatch, source),
    mismatch,
    source,
  };
}

/**
 * Everything the prose may name.
 *
 * Dotted prefixes of every member are included deliberately: a cluster of
 * `com.example.shop.web` and `com.example.shop.repo` should be describable as
 * "the com.example.shop packages", and a prefix of a real package is not an
 * invented fact (ADR-0013).
 */
function buildVocabulary(
  items: readonly EvidenceItem[],
  cluster: ClusterSummary,
  mismatch: IntentMismatch | null,
  source: ReadonlyArray<{ path: string; body: string }>,
): Set<string> {
  const vocabulary = new Set<string>();

  const addPrefixes = (fqn: string): void => {
    const segments = fqn.split('.');
    for (let at = 1; at <= segments.length; at += 1) {
      vocabulary.add(segments.slice(0, at).join('.'));
    }
  };

  for (const member of cluster.members) addPrefixes(member.fqn);
  addPrefixes(cluster.prefix);

  if (mismatch !== null) {
    addPrefixes(mismatch.fqn);
    addPrefixes(mismatch.parent);
    addPrefixes(mismatch.expectedPrefix);
    addPrefixes(mismatch.actualPrefix);
    for (const sibling of mismatch.nameGroup) addPrefixes(sibling);
    for (const puller of mismatch.pulledBy) addPrefixes(puller);
  }

  // Anything rendered into an item's text is by definition something the model
  // was shown, so it is nameable.
  for (const item of items) {
    for (const token of tokensIn(item.text)) {
      vocabulary.add(token);
      if (token.includes('.') && !token.includes('/')) addPrefixes(token);
    }
  }
  for (const file of source) {
    vocabulary.add(file.path);
    for (const token of tokensIn(file.body)) vocabulary.add(token);
  }

  return vocabulary;
}

/** The same token shapes the contract's rule 3 looks for. */
function tokensIn(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g,
    /\b[\w.$-]+(?:\/[\w.$-]+)+\b/g,
    /\b[0-9a-f]{7,40}\b/g,
  ]) {
    for (const match of text.matchAll(pattern)) found.push(match[0]);
  }
  return found;
}

interface ClusterEdge {
  edgeId: number;
  kind: string;
  srcFqn: string;
  dstFqn: string;
  path: string | null;
  line: number | null;
}

/**
 * The heaviest dependency edges with at least one end inside the cluster.
 *
 * Both the internal edges (what holds it together) and the outgoing ones (what
 * it is for) matter to a description, so neither is filtered out here.
 */
function clusterEdges(
  db: Db,
  runId: number,
  nodeIds: readonly number[],
  limit: number,
): ClusterEdge[] {
  if (nodeIds.length === 0) return [];
  const kinds = DEPENDENCY_EDGE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const placeholders = nodeIds.map(() => '?').join(', ');

  return db
    .prepare(
      /* sql */ `
      WITH RECURSIVE
        ancestry(start_id, node_id, kind) AS (
            SELECT n.id, n.id, n.kind FROM node n WHERE n.run_id = ?
          UNION ALL
            SELECT a.start_id, p.id, p.kind
              FROM ancestry a
              JOIN node c ON c.id = a.node_id
              JOIN node p ON p.id = c.parent_id
             WHERE a.kind <> 'package'
        ),
        package_of(node_id, package_id) AS (
          SELECT a.start_id, a.node_id FROM ancestry a WHERE a.kind = 'package'
        )
      SELECT e.id AS edgeId, e.kind AS kind, sn.fqn AS srcFqn, dn.fqn AS dstFqn,
             f.path AS path, e.line AS line
        FROM edge e
        JOIN package_of sp ON sp.node_id = e.src_id
        JOIN package_of dp ON dp.node_id = e.dst_id
        JOIN node sn ON sn.id = e.src_id
        JOIN node dn ON dn.id = e.dst_id
        LEFT JOIN source_file f ON f.id = e.file_id
       WHERE e.run_id = ?
         AND e.kind IN (${kinds})
         AND e.confidence = 'fact'
         AND sp.package_id <> dp.package_id
         AND (sp.package_id IN (${placeholders}) OR dp.package_id IN (${placeholders}))
       ORDER BY e.weight DESC, e.id
       LIMIT ?`,
    )
    .all(runId, runId, ...nodeIds, ...nodeIds, limit) as ClusterEdge[];
}

interface ClusterFile {
  fileId: number;
  path: string;
  commits: number | null;
  churn: number | null;
  authors: number | null;
}

/** The cluster's files, most-changed first, with their history metrics attached. */
function clusterFiles(
  db: Db,
  runId: number,
  nodeIds: readonly number[],
  limit: number,
): ClusterFile[] {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => '?').join(', ');

  return db
    .prepare(
      /* sql */ `
      WITH RECURSIVE
        ancestry(file_id, node_id, kind) AS (
            SELECT n.file_id, n.id, n.kind FROM node n
             WHERE n.run_id = ? AND n.file_id IS NOT NULL AND n.is_stub = 0
               AND n.kind IN ('class', 'interface', 'enum', 'annotation')
          UNION ALL
            SELECT a.file_id, p.id, p.kind
              FROM ancestry a
              JOIN node c ON c.id = a.node_id
              JOIN node p ON p.id = c.parent_id
             WHERE a.kind <> 'package'
        )
      SELECT DISTINCT sf.id AS fileId, sf.path AS path,
             fm.commits AS commits, fm.churn AS churn, fm.authors AS authors
        FROM ancestry a
        JOIN source_file sf ON sf.id = a.file_id
        LEFT JOIN file_metric fm ON fm.run_id = ? AND fm.path = sf.path
       WHERE a.kind = 'package' AND a.node_id IN (${placeholders})
       ORDER BY COALESCE(fm.churn, 0) DESC, sf.path
       LIMIT ?`,
    )
    .all(runId, runId, ...nodeIds, limit) as ClusterFile[];
}

/** The commits that touched this cluster's files most heavily. */
function clusterCommits(
  db: Db,
  runId: number,
  nodeIds: readonly number[],
  limit: number,
): Array<{ sha: string; subject: string | null }> {
  const files = clusterFiles(db, runId, nodeIds, LIMITS.files);
  if (files.length === 0) return [];
  const placeholders = files.map(() => '?').join(', ');

  return db
    .prepare(
      /* sql */ `
      SELECT c.sha AS sha, c.subject AS subject
        FROM git_commit c
        JOIN commit_file cf ON cf.commit_id = c.id
       WHERE c.run_id = ? AND c.is_merge = 0 AND cf.canonical_path IN (${placeholders})
       GROUP BY c.id
       ORDER BY SUM(cf.insertions + cf.deletions) DESC, c.authored_at DESC
       LIMIT ?`,
    )
    .all(runId, ...files.map((file) => file.path), limit) as Array<{
    sha: string;
    subject: string | null;
  }>;
}

/**
 * Raw source, only under `--send-source`.
 *
 * Truncated per file, because the point is to give the model something to read
 * rather than to ship a repository over the wire. A file that cannot be read is
 * skipped rather than guessed at.
 */
function readSource(
  db: Db,
  runId: number,
  nodeIds: readonly number[],
  repoPath: string,
): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = [];
  for (const file of clusterFiles(db, runId, nodeIds, LIMITS.sourceFiles)) {
    try {
      const lines = readFileSync(join(repoPath, file.path), 'utf8').split('\n');
      out.push({
        path: file.path,
        body: lines.slice(0, LIMITS.sourceLines).join('\n'),
      });
    } catch {
      // Unreadable now, whatever it was at extraction time. Silence here is
      // safe: the pack simply carries less, and nothing is invented.
    }
  }
  return out;
}
