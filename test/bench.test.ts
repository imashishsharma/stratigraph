import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { looksNonSource, normaliseEndpoint, normaliseTypeId } from '../src/bench/score.js';
import { BenchInputError, loadCorpus, loadTruth } from '../src/bench/truth.js';
import { runBench } from '../src/commands/bench.js';
import { setQuiet } from '../src/log.js';

setQuiet(true);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'stratigraph-bench-'));
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe('normaliseEndpoint', () => {
  it.each([
    ['GET /owners/{ownerId}', 'GET /owners/{}'],
    ['get /owners/:id/', 'GET /owners/{}'],
    ['POST owners//new', 'POST /owners/new'],
    ['GET /', 'GET /'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseEndpoint(input)).toBe(expected);
  });
});

describe('looksNonSource', () => {
  it.each([
    ['package-lock.json', true],
    ['web/yarn.lock', true],
    ['pom.xml', true],
    ['src/test/java/a/FooTest.java', true],
    ['src/app/foo.component.spec.ts', true],
    ['src/main/resources/i18n/en.json', true],
    ['src/main/java/a/Foo.java', false],
    ['src/app/foo.component.ts', false],
    ['src/app/foo.component.html', false],
  ])('%s → %s', (path, expected) => {
    expect(looksNonSource(path)).toBe(expected);
  });
});

describe('corpus and truth files', () => {
  it('rejects a short sha, a duplicate name and an unknown truth key', () => {
    const dir = scratch();
    write(dir, 'short.yaml', 'repos:\n  - { name: a, url: x, sha: abc }\n');
    expect(() => loadCorpus(join(dir, 'short.yaml'))).toThrow(/full 40-character commit/);

    const sha = 'a'.repeat(40);
    write(dir, 'dup.yaml', `repos:\n  - { name: a, url: x, sha: ${sha} }\n  - { name: a, url: y, sha: ${sha} }\n`);
    expect(() => loadCorpus(join(dir, 'dup.yaml'))).toThrow(/duplicate name "a"/);

    // A typo must not silently become "section not labelled".
    write(dir, 'truth.yaml', `name: a\nsha: ${sha}\nendpoint:\n  - GET /\n`);
    expect(() => loadTruth(join(dir, 'truth.yaml'))).toThrow(BenchInputError);
    expect(() => loadTruth(join(dir, 'truth.yaml'))).toThrow(/unknown key "endpoint"/);
  });
});

describe('runBench', () => {
  /** A small Angular-shaped repository with a lockfile, a spec and history. */
  function origin(): { dir: string; sha: string } {
    const dir = scratch();
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ada',
          GIT_AUTHOR_EMAIL: 'ada@example.invalid',
          GIT_COMMITTER_NAME: 'Ada',
          GIT_COMMITTER_EMAIL: 'ada@example.invalid',
        },
      }).trim();
    git('init', '-q');
    write(dir, 'package-lock.json', '{"lockfileVersion": 3}\n');
    write(
      dir,
      'src/app/order.service.ts',
      "import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class OrderService {\n  load() {\n    if (true) {\n      return 1;\n    }\n  }\n}\n",
    );
    write(
      dir,
      'src/app/order.component.ts',
      "import { Component } from '@angular/core';\nimport { OrderService } from './order.service';\n@Component({ selector: 'app-order', template: '' })\nexport class OrderComponent {\n  constructor(private readonly orders: OrderService) {}\n}\n",
    );
    write(dir, 'src/app/order.component.spec.ts', "describe('x', () => {});\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    for (let n = 0; n < 3; n += 1) {
      write(dir, 'src/app/order.service.ts', readFileSync(join(dir, 'src/app/order.service.ts'), 'utf8') + `// ${n}\n`);
      write(dir, 'package-lock.json', `{"lockfileVersion": 3, "n": ${n}}\n`);
      git('commit', '-q', '-am', `change ${n}`);
    }
    return { dir, sha: git('rev-parse', 'HEAD') };
  }

  it('clones, pins, runs the pipeline and scores it against the truth', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { dir: repo, sha } = origin();
    const home = scratch();
    write(
      home,
      'bench/corpus.yaml',
      `repos:\n  - name: tiny-ng\n    url: ${repo}\n    sha: ${sha}\n    why: test\n    stacks: [angular]\n`,
    );
    write(
      home,
      'bench/truth/tiny-ng.yaml',
      [
        'name: tiny-ng',
        `sha: ${sha}`,
        'labelledBy: written by hand for this test',
        'roles:',
        '  - { path: package-lock.json, role: lockfile }',
        '  - { path: src/app/order.component.spec.ts, role: test }',
        '  - { path: src/app/order.service.ts, role: source }',
        'riskyFiles:',
        '  - src/app/order.service.ts',
        'injections:',
        '  - { from: src/app/order.component.ts#OrderComponent, to: src/app/order.service.ts#OrderService }',
        '',
      ].join('\n'),
    );

    const card = await runBench({
      cwd: home,
      cache: join(home, 'cache'),
      fetch: true,
    });
    vi.restoreAllMocks();

    const [result] = card.repos;
    expect(result?.error).toBeNull();
    expect(result?.metrics?.nonSourceInHotspotTop20.count).toBe(0);
    expect(result?.metrics?.roleAccuracy).toEqual({ hit: 3, of: 3, missed: [] });
    expect(result?.metrics?.hotspotOverlapTop10).toMatchObject({ hit: 1, of: 1 });
    expect(result?.metrics?.viewsWithoutCoverage).toEqual([]);
    expect(card.targets.find((row) => row.metric.startsWith('Repositories'))).toMatchObject({
      value: '1/1',
      pass: true,
    });
    expect(existsSync(join(home, '.stratigraph', 'bench', 'scorecard.md'))).toBe(true);
  }, 60_000);

  it('refuses a truth file labelled at a different commit than the corpus pins', async () => {
    const home = scratch();
    const pinned = 'a'.repeat(40);
    write(home, 'bench/corpus.yaml', `repos:\n  - { name: x, url: /nowhere, sha: ${pinned} }\n`);
    write(home, 'bench/truth/x.yaml', `name: x\nsha: ${'b'.repeat(40)}\n`);
    await expect(runBench({ cwd: home })).rejects.toThrow(/relabel it or move the pin back/);
  });
});

describe('normaliseTypeId', () => {
  it('reads a labelled TypeScript class the way the extractor names it', () => {
    expect(normaliseTypeId('src/app/x.service.ts#XService')).toBe('src/app/x.service:XService');
    expect(normaliseTypeId('com.acme.OrderService')).toBe('com.acme.OrderService');
  });
});
