import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, type Streams } from '../extractors/typescript/src/main.js';
import { parseFact } from '../src/facts/ndjson.js';
import type { DiagnosticFact, EdgeFact, Fact, NodeFact } from '../src/facts/types.js';

/**
 * The fixture contract, matching `ExtractorGoldenTest.java`: for the tiny
 * hand-written repository, the extractor must emit **exactly** the facts in its
 * `expected-facts.ndjson`.
 *
 * Exact, not "contains" — CLAUDE.md asks for exact assertions because a fact
 * appearing that should not (a guessed edge) is as much a failure as one going
 * missing, and a subset assertion catches only half of that.
 *
 * Regenerate with `UPDATE_GOLDENS=1 npx vitest run test/ts-extractor.test.ts`.
 * A regenerated golden is only worth having if a human reads the diff.
 */

const FIXTURES = resolve(import.meta.dirname, '..', 'fixtures');

async function extract(fixture: string): Promise<string[]> {
  const repo = join(FIXTURES, fixture);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const streams: Streams = {
    stdout: { write: (line) => stdout.push(line) },
    stderr: { write: (line) => stderr.push(line) },
  };

  const status = await run(['--repo', repo], streams);
  expect(status, `extractor failed: ${stderr.join('\n')}`).toBe(0);

  // The repository path in the `meta` fact is absolute and therefore
  // machine-specific. Nothing else is normalised: line numbers, ordering and
  // fqns are all part of the contract.
  //
  // It has to be redacted in its JSON-escaped form as well as its raw one.
  // On Windows the path separator is a backslash, so `D:\a\...` reaches the
  // NDJSON as `D:\\a\\...` and replacing the raw string matches nothing —
  // which is exactly how this passed on two platforms and failed on the third.
  const escaped = JSON.stringify(repo).slice(1, -1);
  return stdout.map((line) => line.replaceAll(escaped, '<repo>').replaceAll(repo, '<repo>'));
}

function facts(lines: string[]): Fact[] {
  return lines.map((line, index) => parseFact(line, index + 1));
}

describe('the TypeScript extractor', () => {
  it('emits exactly the expected facts for tiny-angular', async () => {
    const actual = await extract('tiny-angular');
    const golden = join(FIXTURES, 'tiny-angular', 'expected-facts.ndjson');

    if (process.env['UPDATE_GOLDENS'] === '1') {
      writeFileSync(golden, `${actual.join('\n')}\n`);
      return;
    }

    expect(existsSync(golden), `no golden; regenerate with UPDATE_GOLDENS=1`).toBe(true);
    expect(actual.join('\n')).toBe(readFileSync(golden, 'utf8').trimEnd());
  });

  it('emits a stream the core accepts', async () => {
    // The extractor defines the protocol locally (`protocol.ts`) rather than
    // importing the core's types, exactly as the Java extractor does. This is
    // what keeps the two halves honest: every line goes through the real
    // validator, which throws on the first malformed one.
    const parsed = facts(await extract('tiny-angular'));
    expect(parsed[0]).toMatchObject({ type: 'meta', extractor: 'typescript' });
    expect(parsed.length).toBeGreaterThan(50);
  });
});

describe('the TypeScript extractor refuses to guess', () => {
  let parsed: Fact[];

  async function load(): Promise<Fact[]> {
    parsed ??= facts(await extract('tiny-angular'));
    return parsed;
  }

  const nodes = (all: Fact[]): NodeFact[] => all.filter((f): f is NodeFact => f.type === 'node');
  const edges = (all: Fact[]): EdgeFact[] => all.filter((f): f is EdgeFact => f.type === 'edge');
  const diagnostics = (all: Fact[]): DiagnosticFact[] =>
    all.filter((f): f is DiagnosticFact => f.type === 'diagnostic');

  it('records no injects edge for an injection token, and says why', async () => {
    const all = await load();
    expect(
      edges(all).filter((e) => e.kind === 'injects' && e.dst.fqn.includes('API_BASE')),
    ).toEqual([]);
    expect(
      diagnostics(all).some(
        (d) => d.message.includes('API_BASE') && d.message.includes('injection token'),
      ),
    ).toBe(true);
  });

  it('records no endpoint for a computed URL, and says why', async () => {
    const all = await load();
    const service = nodes(all).find((n) => n.fqn.endsWith('OrderService#findBy()'));
    expect(service?.attrs?.['httpCalls']).toBeUndefined();
    expect(
      diagnostics(all).some((d) => d.message.includes('computed URL')),
    ).toBe(true);
  });

  it('treats a look-alike decorator as a decorator and not as a component', async () => {
    const all = await load();
    const legacy = nodes(all).find((n) => n.name === 'LegacyPageComponent');
    // `@Page({ selector: 'app-legacy' })` carries a selector and is not
    // Angular's. Reading one out of it would be the whole failure mode.
    expect(legacy?.attrs?.['angular']).toBeUndefined();
    expect(legacy?.attrs?.['selector']).toBeUndefined();

    // The decoration itself is still a fact, and it points at the local
    // function rather than minting a second node under an `annotation` kind.
    const annotated = edges(all).find(
      (e) => e.kind === 'annotated_with' && e.src.fqn.endsWith(':LegacyPageComponent'),
    );
    expect(annotated?.dst).toEqual({
      kind: 'method',
      fqn: 'src/app/legacy/legacy-page.component#Page()',
    });
  });

  it('names an uninstalled library by the import that introduced it', async () => {
    const all = await load();
    const injected = edges(all).find(
      (e) => e.kind === 'injects' && e.src.fqn.endsWith(':OrderService'),
    );
    expect(injected?.dst.fqn).toBe('@angular/common/http:HttpClient');
    expect(injected?.attrs?.['resolution']).toBe('import');
  });
});

describe('the TypeScript extractor reads Angular', () => {
  let parsed: Fact[];
  const load = async (): Promise<Fact[]> => (parsed ??= facts(await extract('tiny-angular')));

  it('resolves DI through a tsconfig path alias', async () => {
    const all = await load();
    // `order-list.component.ts` imports `@app/core/order.service`. Without the
    // alias this resolves to nothing and the DI graph loses its only edge.
    const injects = all.filter(
      (f): f is EdgeFact =>
        f.type === 'edge' && f.kind === 'injects' && f.src.fqn.endsWith(':OrderListComponent'),
    );
    expect(injects).toHaveLength(1);
    expect(injects[0]?.dst.fqn).toBe('src/app/core/order.service:OrderService');
    expect(injects[0]?.attrs?.['via']).toBe('constructor');
    expect(injects[0]?.attrs?.['resolution']).toBe('checker');
  });

  it('resolves nested route paths and the lazy boundary', async () => {
    const all = await load();
    const routes = all
      .filter((f): f is NodeFact => f.type === 'node' && f.kind === 'route')
      .map((r) => r.fqn);
    expect(routes).toEqual(['/', '/orders', '/orders/:id']);

    const lazy = all.find(
      (f): f is EdgeFact =>
        f.type === 'edge' && f.kind === 'handles' && f.dst.fqn === '/orders/:id',
    );
    expect(lazy?.src.fqn).toBe('src/app/orders/order-row.component:OrderRowComponent');
    expect(lazy?.attrs?.['lazy']).toBe(true);
  });

  it('matches a template tag to the component that declares the selector', async () => {
    const all = await load();
    const fromTemplate = all.find(
      (f): f is EdgeFact =>
        f.type === 'edge' && f.kind === 'imports' && f.attrs?.['template'] === true,
    );
    expect(fromTemplate?.src.fqn).toBe('src/app/orders/order-list.component:OrderListComponent');
    expect(fromTemplate?.dst.fqn).toBe('src/app/orders/order-row.component:OrderRowComponent');
    expect(fromTemplate?.file).toBe('src/app/orders/order-list.component.html');
    expect(fromTemplate?.attrs?.['selector']).toBe('app-order-row');
  });

  it('records a subscribe site as a line on its member, not as an invented edge', async () => {
    const all = await load();
    const ngOnInit = all.find(
      (f): f is NodeFact => f.type === 'node' && f.fqn.endsWith('OrderListComponent#ngOnInit()'),
    );
    // `guarded` and `retained` are syntax, recorded here because this is the
    // only place the syntax exists; whether the subscription leaks is layer 4's
    // judgement to make from them.
    expect(ngOnInit?.attrs?.['rxjsSubscribes']).toEqual([
      { line: 21, guarded: false, retained: false },
    ]);
    // Nothing claims the receiver is an rxjs Observable, because nothing saw
    // one. The `import { Observable } from 'rxjs'` edge is a different matter —
    // that import is on the page.
    expect(all.some((f) => f.type === 'edge' && f.dst.fqn.endsWith('#subscribe()'))).toBe(false);
  });

  it('records an observed HTTP call without inventing an endpoint', async () => {
    const all = await load();
    const findOne = all.find(
      (f): f is NodeFact => f.type === 'node' && f.fqn.endsWith('OrderService#findOne()'),
    );
    expect(findOne?.attrs?.['httpCalls']).toEqual([
      { method: 'GET', url: '/api/orders/{}', line: 15 },
    ]);
    // The endpoint that serves it is the linker's inference, not a fact here.
    expect(all.some((f) => f.type === 'node' && f.kind === 'endpoint')).toBe(false);
  });
});
