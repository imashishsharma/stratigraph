import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadModuleInfo } from '../src/analysis/deployables.js';
import { runInit } from '../src/commands/init.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import type { Fact } from '../src/facts/types.js';
import { setQuiet } from '../src/log.js';
import { buildC4Model, elementId, type C4Diagram } from '../src/present/c4.js';
import { toStructurizr } from '../src/present/structurizr.js';

/**
 * Containers are deployables (ADR-0040), split packages belong to each module
 * (ADR-0041), and Angular packages are boundaries (ADR-0042) — asserted against
 * the fixtures' own goldens, so the core is tested on exactly what the
 * extractors emit without needing a JDK to produce it.
 */

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(REPO_ROOT, 'fixtures');

let db: Db;
let runId: number;

beforeEach(() => {
  const cwd = mkdtempSync(join(tmpdir(), 'stratigraph-containers-'));
  runInit({ repo: join(FIXTURES, 'tiny-java'), cwd });
  db = openDatabase(join(cwd, '.stratigraph', 'tiny-java.db'), { mustExist: true });
  runId = createRun(db, join(FIXTURES, 'tiny-java')).id;
});

afterEach(() => {
  if (db.open) db.close();
});

function seed(facts: object[]): void {
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of facts) writer.write(parseFact(JSON.stringify(fact)) as Fact);
  writer.close();
}

/** Write a fixture's golden fact stream into the store, as `extract` would. */
function ingestGolden(fixture: string): void {
  const lines = readFileSync(join(FIXTURES, fixture, 'expected-facts.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  seed(lines.map((line) => JSON.parse(line) as object));
}

function model() {
  return buildC4Model(db, runId, { top: 20 });
}

function containers(): string[] {
  return model()
    .container.elements.filter((element) => element.kind === 'container')
    .map((element) => element.name);
}

function componentsOf(scope: string): C4Diagram | undefined {
  return model().components.find((diagram) => diagram.scope === scope);
}

describe('containers are deployables (ADR-0040)', () => {
  it('draws the two Boot apps of a Maven build, and not its aggregator, BOM or library', () => {
    ingestGolden('maven-multi');
    expect(containers()).toEqual(['billing-app', 'orders-app']);

    const { container } = model();
    const orders = container.elements.find((element) => element.name === 'orders-app');
    expect(orders?.evidence).toContainEqual({
      kind: 'file',
      label: 'spring-boot: maven:build/plugins/spring-boot-maven-plugin',
      path: 'orders-app/pom.xml',
      line: 17,
    });
    // The main class proves billing-app: an annotated_with edge, cited.
    const billing = container.elements.find((element) => element.name === 'billing-app');
    expect(billing?.evidence).toContainEqual({
      kind: 'edge',
      label: 'spring-boot: @SpringBootApplication com.example.multi.billing.BillingApplication',
      path: 'billing-app/src/main/java/com/example/multi/billing/BillingApplication.java',
      line: 7,
    });

    const notes = container.notes.join('\n');
    expect(notes).toContain('aggregator or BOM modules (packaging pom), which group the build and deploy nothing: multi-bom, multi-parent');
    expect(notes).toContain('library modules, with no deployability proof: shared');
    // Both apps use the library; neither calls the other, so no line between them.
    expect(container.relationships.filter((r) => r.to.startsWith('container_'))).toEqual([]);
    expect(notes).toContain('start or end in library or aggregator code');
  });

  it('classifies every module and says why', () => {
    ingestGolden('maven-multi');
    expect(loadModuleInfo(db, runId).map((m) => `${m.name}:${m.role}`)).toEqual([
      'billing-app:deployable',
      'multi-bom:aggregator',
      'multi-parent:aggregator',
      'orders-app:deployable',
      'shared:library',
    ]);
  });

  it('draws the library inside each container that depends on it, under a scoped id', () => {
    ingestGolden('maven-multi');
    const orders = componentsOf('com.example.multi:orders-app');
    const billing = componentsOf('com.example.multi:billing-app');
    const shared = (diagram: C4Diagram | undefined) =>
      diagram?.elements.find((element) => element.name === 'com.example.multi.shared');

    expect(shared(orders)?.group).toBe('library shared');
    expect(shared(orders)?.groupInference).toBe(false);
    expect(shared(orders)?.id).not.toBe(shared(billing)?.id);
    expect(orders?.relationships.map((r) => [r.from, r.to, r.label])).toEqual([
      [
        elementId('component', 'com.example.multi.orders'),
        shared(orders)?.id,
        'calls, imports',
      ],
    ]);
    // No library gets a component diagram of its own: it is not a container.
    expect(model().components.map((diagram) => diagram.scope)).toEqual([
      'com.example.multi:billing-app',
      'com.example.multi:orders-app',
    ]);
  });

  it('writes Structurizr DSL that declares no identifier twice', () => {
    ingestGolden('maven-multi');
    const dsl = toStructurizr(model());
    const declared = [...dsl.matchAll(/^\s*(\w+) = (?:container|component|softwareSystem)\b/gm)].map(
      (match) => match[1],
    );
    expect(declared).toContain(elementId('container', 'com.example.multi:orders-app'));
    expect(declared.length).toBeGreaterThan(4);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('finds a Gradle Boot app by its own plugins block, and nothing applied from above', () => {
    ingestGolden('gradle-multi');
    expect(containers()).toEqual(['app']);
    expect(model().container.notes.join('\n')).toContain(
      'library modules, with no deployability proof: gradle-multi, lib',
    );
  });

  it('finds a WAR by its packaging', () => {
    ingestGolden('war-app');
    expect(containers()).toEqual(['war-app']);
    expect(model().container.elements[0]?.evidence).toContainEqual({
      kind: 'file',
      label: 'war: maven:packaging=war',
      path: 'pom.xml',
      line: 9,
    });
  });

  it('finds an Angular application, and draws its library inside it', () => {
    ingestGolden('angular-workspace');
    expect(containers()).toEqual(['shop']);
    const shop = componentsOf('shop');
    expect(shop?.elements.map((e) => `${e.name}${e.group === null ? '' : ` [${e.group}]`}`)).toEqual([
      'projects/shop',
      'projects/shop/src/app/admin',
      'projects/shop/src/app/orders',
      'projects/ui-kit [library @shop/ui-kit]',
    ]);
  });

  it('falls back to one container per module when nothing is provably deployable, and says so', () => {
    ingestGolden('tiny-java');
    expect(containers()).toEqual(['tiny-java']);
    expect(model().container.notes.join('\n')).toContain('No module is a proved deployable');
  });
});

describe('split packages (ADR-0041)', () => {
  it('counts each half in its own module', () => {
    ingestGolden('split-package');
    expect(containers()).toEqual(['extra']);
    const extra = model().container.elements.find((element) => element.name === 'extra');
    // report + util; Report, ReportApplication and Numbers. Strings is core's half of util.
    expect(extra?.description).toBe('2 package(s), 3 type(s)');
    expect(componentsOf('com.example.split:extra')?.elements.map((e) => e.name)).toEqual([
      'com.example.split.report',
      'com.example.split.util',
    ]);
    expect(componentsOf('com.example.split:extra')?.notes.join('\n')).toContain(
      'com.example.split.util: split across modules',
    );
  });

  it('places a type in a split package by its file, not by the package parent', () => {
    const module = (fqn: string, root: string) => ({
      v: 1,
      type: 'node',
      kind: 'module',
      fqn,
      name: fqn,
      attrs: { root, deployable: 'war', deployableFile: `${root}/pom.xml`, deployableLine: 1 },
    });
    const type = (fqn: string, pkg: string, file: string) => ({
      v: 1,
      type: 'node',
      kind: 'class',
      fqn,
      name: fqn,
      parent: { kind: 'package', fqn: pkg },
      file,
    });
    seed([
      { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0' },
      module('a', 'a'),
      module('b', 'b'),
      { v: 1, type: 'node', kind: 'package', fqn: 'p', name: 'p', parent: { kind: 'module', fqn: 'a' } },
      { v: 1, type: 'node', kind: 'package', fqn: 'q', name: 'q', parent: { kind: 'module', fqn: 'a' } },
      type('p.X', 'p', 'a/src/p/X.java'),
      type('p.Y', 'p', 'b/src/p/Y.java'),
      type('q.Z', 'q', 'a/src/q/Z.java'),
      { v: 1, type: 'edge', kind: 'contains', src: { kind: 'module', fqn: 'a' }, dst: { kind: 'package', fqn: 'p' }, file: 'a/src/p/X.java', line: 1 },
      { v: 1, type: 'edge', kind: 'contains', src: { kind: 'module', fqn: 'b' }, dst: { kind: 'package', fqn: 'p' }, file: 'b/src/p/Y.java', line: 1 },
      { v: 1, type: 'edge', kind: 'imports', src: { kind: 'class', fqn: 'q.Z' }, dst: { kind: 'class', fqn: 'p.Y' }, file: 'a/src/q/Z.java', line: 3 },
      { v: 1, type: 'edge', kind: 'imports', src: { kind: 'class', fqn: 'q.Z' }, dst: { kind: 'class', fqn: 'p.X' }, file: 'a/src/q/Z.java', line: 4 },
    ]);

    // Before ADR-0041, p.Y sat in module a with the rest of p, and this line
    // did not exist.
    expect(model().container.relationships.map((r) => [r.from, r.to, r.count])).toEqual([
      [elementId('container', 'a'), elementId('container', 'b'), 1],
    ]);
  });
});

describe('a main class declared in two modules (ADR-0040)', () => {
  it('makes both modules deployable, since each states it contains one', () => {
    const plugin = (root: string) => ({
      root,
      buildFile: `${root}/pom.xml`,
      deployable: 'spring-boot',
      deployableFile: `${root}/pom.xml`,
      deployableLine: 10,
      deployableRule: 'maven:build/plugins/spring-boot-maven-plugin',
    });
    seed([
      { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0' },
      { v: 1, type: 'file', path: 'a/src/main/java/app/App.java', language: 'java' },
      { v: 1, type: 'file', path: 'b/src/main/java/app/App.java', language: 'java' },
      { v: 1, type: 'node', kind: 'module', fqn: 'x:a', name: 'a', attrs: plugin('a') },
      { v: 1, type: 'node', kind: 'module', fqn: 'x:b', name: 'b', attrs: plugin('b') },
      { v: 1, type: 'node', kind: 'package', fqn: 'app', name: 'app', parent: { kind: 'module', fqn: 'x:a' } },
      { v: 1, type: 'node', kind: 'class', fqn: 'app.App', name: 'App', parent: { kind: 'package', fqn: 'app' }, file: 'a/src/main/java/app/App.java' },
      { v: 1, type: 'edge', kind: 'contains', src: { kind: 'module', fqn: 'x:a' }, dst: { kind: 'class', fqn: 'app.App' }, file: 'a/src/main/java/app/App.java', line: 5, attrs: { main: true } },
      { v: 1, type: 'edge', kind: 'contains', src: { kind: 'module', fqn: 'x:b' }, dst: { kind: 'class', fqn: 'app.App' }, file: 'b/src/main/java/app/App.java', line: 5, attrs: { main: true } },
    ]);
    expect(loadModuleInfo(db, runId).map((m) => `${m.fqn} ${m.role}`)).toEqual(['x:a deployable', 'x:b deployable']);
  });
});
