import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInit } from '../src/commands/init.js';
import { ReportError, runReport } from '../src/commands/report.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createRun } from '../src/db/run.js';
import { parseFact } from '../src/facts/ndjson.js';
import { SqliteFactWriter } from '../src/facts/writer.js';
import type { Fact } from '../src/facts/types.js';
import { setQuiet } from '../src/log.js';

setQuiet(true);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

let cwd: string;
let db: Db;
let runId: number;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'stratigraph-report-'));
  runInit({ repo: FIXTURE, cwd });
  db = openDatabase(join(cwd, '.stratigraph', 'tiny-java.db'), { mustExist: true });
  runId = createRun(db, FIXTURE).id;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (db.open) db.close();
});

function seed(facts: object[]): void {
  const writer = new SqliteFactWriter(db, runId);
  for (const fact of facts) writer.write(parseFact(JSON.stringify(fact)) as Fact);
  writer.close();
}

/** Two modules, two packages each side of one dependency, and a table. */
function seedRepository(): void {
  seed([
    { v: 1, type: 'meta', extractor: 'java', extractorVersion: '0.0.0' },
    { v: 1, type: 'file', path: 'server/src/a/A.java', language: 'java' },
    { v: 1, type: 'file', path: 'server/src/b/B.java', language: 'java' },
    { v: 1, type: 'node', kind: 'module', fqn: 'server', name: 'server' },
    {
      v: 1,
      type: 'node',
      kind: 'package',
      fqn: 'a',
      name: 'a',
      parent: { kind: 'module', fqn: 'server' },
    },
    {
      v: 1,
      type: 'node',
      kind: 'package',
      fqn: 'b',
      name: 'b',
      parent: { kind: 'module', fqn: 'server' },
    },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'a.A',
      name: 'A',
      parent: { kind: 'package', fqn: 'a' },
      file: 'server/src/a/A.java',
    },
    {
      v: 1,
      type: 'node',
      kind: 'class',
      fqn: 'b.B',
      name: 'B',
      parent: { kind: 'package', fqn: 'b' },
      file: 'server/src/b/B.java',
    },
    { v: 1, type: 'node', kind: 'table', fqn: 'orders', name: 'orders' },
    {
      v: 1,
      type: 'edge',
      kind: 'imports',
      src: { kind: 'class', fqn: 'a.A' },
      dst: { kind: 'class', fqn: 'b.B' },
      file: 'server/src/a/A.java',
      line: 3,
    },
    {
      v: 1,
      type: 'edge',
      kind: 'maps_to',
      src: { kind: 'class', fqn: 'b.B' },
      dst: { kind: 'table', fqn: 'orders' },
      file: 'server/src/b/B.java',
      line: 8,
    },
    { v: 1, type: 'diagnostic', level: 'warn', message: 'could not resolve a type' },
  ]);
}

function finding(title: string, severity = 'high'): void {
  const id = Number(
    db
      .prepare(
        `INSERT INTO finding (run_id, rule, title, detail, severity, authored_by)
         VALUES (?, 'package-cycle', ?, 'the detail', ?, 'algorithm')`,
      )
      .run(runId, title, severity).lastInsertRowid,
  );
  const edgeId = (db.prepare(`SELECT id FROM edge WHERE run_id = ? LIMIT 1`).get(runId) as {
    id: number;
  }).id;
  db.prepare(`INSERT INTO citation (finding_id, kind, edge_id) VALUES (?, 'edge', ?)`).run(
    id,
    edgeId,
  );
}

function report(options: { out?: string; top?: number; run?: number } = {}) {
  return runReport({ repo: FIXTURE, cwd, out: options.out ?? 'arch', ...options });
}

function read(name: string): string {
  return readFileSync(join(cwd, 'arch', name), 'utf8');
}

describe('stratigraph report', () => {
  it('writes every output, and only those', () => {
    seedRepository();
    const result = report();

    expect(readdirSync(result.outDir).sort()).toEqual([
      // One class diagram per package that declares a type…
      'c4-code-a.mmd',
      'c4-code-b.mmd',
      'c4-component-server.mmd',
      'c4-container.mmd',
      'c4-context.mmd',
      // …and a data model, because this fixture maps a class to a table.
      'data-model.mmd',
      'findings.md',
      'index.html',
      'workspace.dsl',
    ]);
    expect(result.runId).toBe(runId);
  });

  it('creates the output directory, including missing parents', () => {
    seedRepository();
    const result = report({ out: 'docs/generated/arch' });
    expect(readdirSync(result.outDir)).toContain('index.html');
  });

  it('produces the same bytes when run twice on the same run', () => {
    seedRepository();
    finding('a cycle');

    const first = report().files.map((file) => readFileSync(file, 'utf8'));
    const second = report().files.map((file) => readFileSync(file, 'utf8'));
    expect(second).toEqual(first);
  });

  it('derives nothing: it never writes to the fact store', () => {
    seedRepository();
    const before = db.prepare(`SELECT COUNT(*) AS n FROM edge`).get() as { n: number };
    report();
    const after = db.prepare(`SELECT COUNT(*) AS n FROM edge`).get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe('the report is self-contained', () => {
  beforeEach(() => {
    seedRepository();
    finding('a cycle');
    report();
  });

  it('references nothing outside itself', () => {
    const html = read('index.html');
    // The SVG namespace is a identifier, not a fetch; nothing else may be a URL.
    expect(html.replaceAll('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<script');
    expect(html).not.toContain(' src=');
    expect(html).not.toContain('@import');
  });

  it('renders the diagrams inline rather than linking to them', () => {
    const html = read('index.html');
    expect(html).toContain('<svg class="diagram"');
    expect(html).toContain('<style>');
  });

  it('shows the evidence for every relationship it draws', () => {
    const html = read('index.html');
    expect(html).toContain('imports a.A → b.B');
    expect(html).toContain('server/src/a/A.java:3');
  });

  it('says what it did not look at', () => {
    const html = read('index.html');
    expect(html).toContain('What this report did not see');
    expect(html).toContain('No git history was mined');
    expect(html).toContain('warn</code> diagnostic(s) from the java extractor');
    expect(html).toContain('Nothing outside this source tree was examined');
  });

  it('marks the absence of a person as a decision, not an oversight', () => {
    expect(read('index.html')).toContain('No fact in this run identifies a person');
    expect(read('c4-context.mmd')).toContain('no actor is drawn');
  });
});

describe('what the report writes', () => {
  it('names a component file after the container it describes', () => {
    seedRepository();
    expect(report().files.map((f) => f.split(/[\\/]/).pop())).toContain(
      'c4-component-server.mmd',
    );
  });

  it('carries findings into both the HTML and the markdown', () => {
    seedRepository();
    finding('a.A and b.B depend on each other');
    report();

    expect(read('index.html')).toContain('a.A and b.B depend on each other');
    expect(read('findings.md')).toContain('### 1. a.A and b.B depend on each other');
  });

  it('caps sections at --top and says what it left out', () => {
    seedRepository();
    for (let n = 0; n < 4; n += 1) finding(`finding ${n}`);
    report({ top: 2 });

    expect(read('findings.md')).toContain('Showing 2 of 4 findings');
    expect(read('index.html')).toContain('Showing 2 of 4');
  });

  it('writes a valid workspace even when the run holds nothing', () => {
    const dsl = (report(), read('workspace.dsl'));
    expect(dsl).toContain('workspace "tiny-java"');
    expect(dsl).toContain('systemContext system');
  });
});

describe('stratigraph report refuses', () => {
  it('when there is no fact store, naming the commands that would make one', () => {
    const empty = mkdtempSync(join(tmpdir(), 'stratigraph-report-empty-'));
    expect(() => runReport({ repo: FIXTURE, cwd: empty, out: 'arch' })).toThrow(ReportError);
    expect(() => runReport({ repo: FIXTURE, cwd: empty, out: 'arch' })).toThrow(
      /stratigraph extract.*stratigraph analyze/s,
    );
  });

  it('when the requested run is not in the store', () => {
    seedRepository();
    expect(() => report({ run: 999 })).toThrow(/run 999 is not in/);
  });

  it('when the store has no runs at all', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'stratigraph-report-fresh-'));
    runInit({ repo: FIXTURE, cwd: fresh });
    expect(() => runReport({ repo: FIXTURE, cwd: fresh, out: 'arch' })).toThrow(/no runs in/);
  });
});

describe('a run nobody analysed', () => {
  // `extract` opens a new run and `report` renders the latest one, so this is
  // one forgotten command away at any time. Reporting it as "no findings" is
  // the confidently-wrong output the whole project is written against.
  it('says no rule ran, in the HTML and in the file that leaves the machine', () => {
    seedRepository();
    report();

    for (const name of ['index.html', 'findings.md']) {
      const out = read(name);
      expect(out).toMatch(/No rule has been evaluated against this run/);
      expect(out).not.toMatch(/every rule that ran found nothing/);
    }
  });

  it('warns on the command line as well as in the report', () => {
    const warnings: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      warnings.push(String(chunk));
      return true;
    });
    setQuiet(false);
    try {
      seedRepository();
      report();
    } finally {
      setQuiet(true);
    }

    expect(warnings.join('')).toMatch(/no analysis output/);
    expect(warnings.join('')).toMatch(/not because the repository is clean/);
  });

  it('states it as a limit of the run, with the command that fixes it', () => {
    seedRepository();
    report();

    expect(read('findings.md')).toMatch(/## Limits of this run/);
    expect(read('findings.md')).toMatch(/stratigraph analyze/);
  });

  it('keeps the clean-result wording once analysis has stored something', () => {
    seedRepository();
    finding('a.A depends on b.B');
    report();

    expect(read('index.html')).not.toMatch(/No rule has been evaluated/);
    expect(read('findings.md')).not.toMatch(/No rule has been evaluated/);
  });
});

describe('a branded report (ADR-0025)', () => {
  function brandUp(accent: string): void {
    writeFileSync(join(cwd, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(
      join(cwd, 'stratigraph.config.json'),
      JSON.stringify({
        report: { brand: { name: 'Acme Corp', logo: 'logo.svg', accent } },
      }),
    );
  }

  it('carries the name, the embedded logo, and the accent', () => {
    seedRepository();
    brandUp('#7c3aed');
    report();
    const html = read('index.html');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('--accent: #7c3aed');
    // The diagrams take the accent through the derived ramp, not raw.
    expect(html).not.toContain('#b7d3f6');
  });

  it('is still self-contained and still deterministic', () => {
    seedRepository();
    brandUp('#7c3aed');
    report();
    const first = read('index.html');
    expect(first).not.toMatch(/src="(?!data:)/);
    report({ out: 'arch2' });
    expect(readFileSync(join(cwd, 'arch2', 'index.html'), 'utf8')).toBe(first);
  });

  it('reports an accent it had to step, in the limits panel', () => {
    seedRepository();
    brandUp('#fab219');
    report();
    const html = read('index.html');
    expect(html).toContain('cannot hold 3:1 contrast');
    // The light scheme takes the stepped colour; the dark scheme keeps the
    // original, which holds 3:1 on that surface as it is.
    expect(html).not.toMatch(/^:root \{ --accent: #fab219; \}$/m);
    expect(html).toContain('dark) { :root { --accent: #fab219; }');
  });

  it('fails the command on an unreadable logo, not the page on a broken image', () => {
    seedRepository();
    writeFileSync(
      join(cwd, 'stratigraph.config.json'),
      JSON.stringify({ report: { brand: { logo: 'missing.png' } } }),
    );
    expect(() => report()).toThrow(/cannot be read/);
  });
});
