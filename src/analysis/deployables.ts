/**
 * Which modules are deployables (ADR-0040).
 *
 * Two kinds of proof, both facts: what a build file says, recorded on the
 * module node by the extractor that read it, and a `@SpringBootApplication`
 * class, which is an `annotated_with` edge the Java extractor already emits.
 * The second is joined here to the module holding the class, by the same rule
 * every other module-level aggregate uses (ADR-0041). Nothing is inferred: a
 * module with neither proof is not a deployable, and says so.
 */

import type { Db } from '../db/database.js';
import type { DeployableKind, ModuleAttrs } from '../facts/types.js';
import { declaredInTest, moduleAncestry } from './package-graph.js';

const SPRING_BOOT_APPLICATION = 'org.springframework.boot.autoconfigure.SpringBootApplication';

/**
 * `@SpringBootApplication` is `@SpringBootConfiguration` + `@EnableAutoConfiguration`
 * (+ `@ComponentScan`); a class carrying either of the first two by hand is a
 * Boot application class too.
 */
const BOOT_MAIN_ANNOTATIONS = [
  SPRING_BOOT_APPLICATION,
  'org.springframework.boot.SpringBootConfiguration',
  'org.springframework.boot.autoconfigure.EnableAutoConfiguration',
];

export interface DeployableProof {
  kind: DeployableKind;
  /** `maven:packaging=war`, `annotation:@SpringBootApplication`, … */
  rule: string;
  path: string | null;
  line: number | null;
  /** `file` for a build-file proof, `edge` for an annotated class. */
  source: 'file' | 'edge';
  /** The annotated class, for an `edge` proof. */
  subject: string | null;
}

/** `deployable`, or why not: an aggregator/BOM (`pom` packaging), or a library. */
export type ModuleRole = 'deployable' | 'aggregator' | 'library';

export interface ModuleInfo {
  id: number;
  fqn: string;
  name: string;
  attrs: ModuleAttrs;
  role: ModuleRole;
  proofs: DeployableProof[];
}

export function loadModuleInfo(db: Db, runId: number): ModuleInfo[] {
  const rows = db
    .prepare(
      `SELECT id, fqn, name, attrs FROM node
        WHERE run_id = ? AND kind = 'module' AND is_stub = 0 ORDER BY fqn`,
    )
    .all(runId) as Array<{ id: number; fqn: string; name: string; attrs: string | null }>;

  const mainClasses = springBootApplications(db, runId);
  const withMain = modulesWithMainMethod(db, runId);

  return rows.map((row) => {
    const attrs = parseAttrs(row.attrs);
    const proofs: DeployableProof[] = [];
    // The Boot plugin repackages a module into an executable jar only when
    // there is a main class to launch; a library that applies it (to share a
    // build configuration) ships nothing runnable (ADR-0040, benchmark M11).
    const pluginOnly =
      attrs.deployable === 'spring-boot' && !withMain.has(row.id) && !mainClasses.has(row.id);
    if (attrs.deployable !== undefined && !pluginOnly) {
      proofs.push({
        kind: attrs.deployable,
        rule: attrs.deployableRule ?? attrs.deployable,
        path: attrs.deployableFile ?? attrs.buildFile ?? null,
        line: attrs.deployableLine ?? null,
        source: 'file',
        subject: null,
      });
    }
    proofs.push(...(mainClasses.get(row.id) ?? []));

    // A pom-packaged module produces nothing that runs, whatever it declares.
    const role: ModuleRole =
      attrs.packaging === 'pom' ? 'aggregator' : proofs.length > 0 ? 'deployable' : 'library';
    return { id: row.id, fqn: row.fqn, name: row.name, attrs, role, proofs: role === 'aggregator' ? [] : proofs };
  });
}

/** Modules declaring a `static void main(String[])` outside test code. */
function modulesWithMainMethod(db: Db, runId: number): Set<number> {
  const rows = db
    .prepare(
      /* sql */ `
      WITH RECURSIVE
        main_method(id) AS (
          SELECT n.id FROM node n
           WHERE n.run_id = @runId AND n.kind = 'method' AND n.is_stub = 0
             AND n.fqn LIKE '%#main(java.lang.String[])'
             AND NOT ${declaredInTest('n')}
        ),
        ${moduleAncestry('main_method')}
      SELECT DISTINCT ao.ancestor_id AS moduleId FROM ancestor_of ao`,
    )
    .all({ runId }) as Array<{ moduleId: number }>;
  return new Set(rows.map((row) => row.moduleId));
}

/** `@SpringBootApplication` classes outside test code, by the module holding them. */
function springBootApplications(db: Db, runId: number): Map<number, DeployableProof[]> {
  const rows = db
    .prepare(
      /* sql */ `
      WITH RECURSIVE
        main_class(id) AS (
          SELECT e.src_id FROM edge e JOIN node a ON a.id = e.dst_id
           WHERE e.run_id = @runId AND e.kind = 'annotated_with'
             AND a.fqn IN (${BOOT_MAIN_ANNOTATIONS.map((fqn) => `'${fqn}'`).join(', ')})
        ),
        ${moduleAncestry('main_class')}
      SELECT ao.ancestor_id AS moduleId, n.fqn AS subject, f.path AS path, e.line AS line,
             a.fqn AS annotation
        FROM edge e
        JOIN node a ON a.id = e.dst_id
        JOIN node n ON n.id = e.src_id
        JOIN ancestor_of ao ON ao.node_id = e.src_id
        LEFT JOIN source_file f ON f.id = e.file_id
       WHERE e.run_id = @runId AND e.kind = 'annotated_with'
         AND a.fqn IN (${BOOT_MAIN_ANNOTATIONS.map((fqn) => `'${fqn}'`).join(', ')})
       ORDER BY ao.ancestor_id, f.path, e.line`,
    )
    .all({ runId }) as Array<{
    moduleId: number;
    subject: string;
    path: string | null;
    line: number | null;
    annotation: string;
  }>;

  const byModule = new Map<number, DeployableProof[]>();
  for (const row of rows) {
    const list = byModule.get(row.moduleId) ?? [];
    list.push({
      kind: 'spring-boot',
      rule: `annotation:@${row.annotation.split('.').pop()}`,
      path: row.path,
      line: row.line,
      source: 'edge',
      subject: row.subject,
    });
    byModule.set(row.moduleId, list);
  }
  return byModule;
}

function parseAttrs(json: string | null): ModuleAttrs {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ModuleAttrs) : {};
  } catch {
    return {};
  }
}
