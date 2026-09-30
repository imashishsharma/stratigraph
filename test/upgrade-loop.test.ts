import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { setQuiet } from '../src/log.js';
import type { Fixer } from '../src/upgrade/fixer.js';
import { runUpgrade, UpgradeError } from '../src/upgrade/loop.js';
import type { Maven } from '../src/upgrade/maven.js';
import { TARGETS } from '../src/upgrade/targets.js';

setQuiet(true);

function gitIn(repo: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
}

const POM = (boot: string, extra = '') => `<project>
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>${boot}</version>
    </parent>
    <artifactId>demo</artifactId>
    <properties>
        <java.version>17</java.version>${extra}
    </properties>
    <dependencies>
    </dependencies>
</project>
`;

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'stratigraph-upgrade-'));
  gitIn(repo, ['init', '-q', '-b', 'main']);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-q', '-m', 'initial']);
  return repo;
}

type Outcome = { build: 'ok' | string; tests: Record<string, 'passed' | string> };

/**
 * A scripted Maven: `verify` asks `world` what the repository's current state
 * builds to, and writes Surefire reports accordingly; the recipe goal applies
 * `recipe`. Every invocation is recorded.
 */
function fakeMaven(repo: string, world: (read: (path: string) => string) => Outcome, recipe: () => void, calls: string[]): Maven {
  const read = (path: string) => (existsSync(join(repo, path)) ? readFileSync(join(repo, path), 'utf8') : '');
  return async (args, label) => {
    calls.push(label);
    const logPath = join(repo, '..', `${label}.log`);
    if (args.some((arg) => arg.includes('rewrite-maven-plugin'))) {
      recipe();
      return { exitCode: 0, timedOut: false, logPath, log: '[INFO] BUILD SUCCESS\n', seconds: 1 };
    }
    rmSync(join(repo, 'target'), { recursive: true, force: true });
    const outcome = world(read);
    if (outcome.build !== 'ok') {
      const log = `[ERROR] ${outcome.build}\n[INFO] BUILD FAILURE\n`;
      return { exitCode: 1, timedOut: false, logPath, log, seconds: 1 };
    }
    mkdirSync(join(repo, 'target', 'surefire-reports'), { recursive: true });
    const cases = Object.entries(outcome.tests)
      .map(([name, result]) =>
        result === 'passed'
          ? `<testcase name="${name}" classname="demo.AppTest"/>`
          : `<testcase name="${name}" classname="demo.AppTest"><error message="${result.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}" type="java.lang.IllegalStateException"/></testcase>`,
      )
      .join('\n');
    writeFileSync(join(repo, 'target', 'surefire-reports', 'TEST-demo.AppTest.xml'), `<testsuite>${cases}</testsuite>`);
    return { exitCode: 0, timedOut: false, logPath, log: '[INFO] BUILD SUCCESS\n', seconds: 1 };
  };
}

function options(repo: string, maven: Maven, fixer: Fixer | null = null) {
  return {
    repoPath: repo,
    target: TARGETS['3.5']!,
    baselineMaven: () => maven,
    targetMaven: () => maven,
    targetJavaHome: '/jdk',
    mavenArgs: [],
    fixer,
    maxBuilds: 12,
    maxMinutes: 60,
    attemptsPerCategory: 2,
  };
}

const PARAMETERS =
  "Name for argument of type [java.lang.String] not specified, and parameter name information not available via reflection. Ensure that the compiler uses the '-parameters' flag.";

describe('upgrade run', () => {
  it('baseline, recipe, a known fix, parity — each layer its own commit, the user\'s files untouched', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.7.1'), 'src/main/java/demo/App.java': 'class App {}' });
    writeFileSync(join(repo, 'notes.txt'), 'mine, untracked');
    const calls: string[] = [];
    const maven = fakeMaven(
      repo,
      (read) => ({
        build: 'ok',
        tests: {
          boots: 'passed',
          // Red at baseline and after: not the upgrade's to fix.
          needsDocker: 'Could not find a valid Docker environment',
          binds: read('pom.xml').includes('2.7.1') || read('pom.xml').includes('maven.compiler.parameters') ? 'passed' : PARAMETERS,
        },
      }),
      () => writeFileSync(join(repo, 'pom.xml'), POM('3.5.6')),
      calls,
    );

    const report = await runUpgrade(options(repo, maven));

    expect(report.status).toBe('parity');
    expect(report.commits.map((commit) => commit.layer)).toEqual(['recipe', 'known-fix', 'report']);
    expect(report.commits[1]?.subject).toBe('compile with -parameters (Spring 6.1 no longer reads debug info)');
    expect(report.final?.regressed).toEqual([]);
    expect(report.final?.stillFailing).toEqual(['demo.AppTest#needsDocker']);
    expect(calls).toEqual(['baseline', 'recipe', 'build-1', 'build-3']);

    expect(gitIn(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('stratigraph/upgrade-spring-boot-3.5');
    expect(gitIn(repo, ['log', '--format=%s', 'main']).trim()).toBe('initial');
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('mine, untracked');
    expect(gitIn(repo, ['ls-files', 'notes.txt']).trim()).toBe('');
    const md = readFileSync(join(repo, 'upgrade-report.md'), 'utf8');
    expect(md).toContain('Every test that passed before the upgrade passes after it.');
    expect(md).toContain('Failed before and still fail');
  });

  it('stops on a decision, with evidence and options, and attempts nothing', async () => {
    const repo = repoWith({ 'pom.xml': POM('3.2.1') });
    const fixerCalls: string[] = [];
    const fixer: Fixer = {
      name: 'fake',
      attempt: async (request) => {
        fixerCalls.push(request.target[0]!.category.id);
        return { summary: '', costUsd: 0, error: 'should not be called' };
      },
    };
    const maven = fakeMaven(
      repo,
      (read) => ({
        build: 'ok',
        tests: {
          secured: read('pom.xml').includes('3.2.1')
            ? 'passed'
            : 'Failed to load ApplicationContext: UnreachableFilterChainException: A filter chain that matches any request has already been configured',
        },
      }),
      () => writeFileSync(join(repo, 'pom.xml'), POM('3.5.6')),
      [],
    );

    const report = await runUpgrade(options(repo, maven, fixer));

    expect(report.status).toBe('needs-decision');
    expect(fixerCalls).toEqual([]);
    expect(report.remaining).toHaveLength(1);
    expect(report.remaining[0]).toMatchObject({ category: 'security-filter-chain-conflict', disposition: 'decision' });
    expect(report.remaining[0]?.options?.length).toBeGreaterThanOrEqual(2);
    expect(report.remaining[0]?.evidence[0]?.test).toBe('demo.AppTest#secured');
    const md = readFileSync(join(repo, 'upgrade-report.md'), 'utf8');
    expect(md).toContain('## Needs your decision');
    expect(md).toContain('**Options:**');
  });

  it('keeps an AI fix that helps, and rejects one that disables a test, resetting its files', async () => {
    const repo = repoWith({
      'pom.xml': POM('2.7.1'),
      'src/main/java/demo/Docs.java': 'import springfox.documentation.Docket;\nclass Docs {}\n',
      'src/test/java/demo/AppTest.java': 'class AppTest {\n    @Test\n    void boots() {}\n}\n',
    });
    const maven = fakeMaven(
      repo,
      (read) =>
        read('src/main/java/demo/Docs.java').includes('springfox') && !read('pom.xml').includes('2.7.1')
          ? { build: '/r/src/main/java/demo/Docs.java:[1,34] package springfox.documentation does not exist', tests: {} }
          : { build: 'ok', tests: { boots: 'passed' } },
      () => writeFileSync(join(repo, 'pom.xml'), POM('3.5.6')),
      [],
    );
    let turn = 0;
    const fixer: Fixer = {
      name: 'fake',
      attempt: async (request) => {
        turn += 1;
        if (turn === 1) {
          // Cheats: disables the test and adds a scratch file.
          writeFileSync(join(request.repoPath, 'src/test/java/demo/AppTest.java'), 'class AppTest {\n    @Disabled\n    @Test\n    void boots() {}\n}\n');
          writeFileSync(join(request.repoPath, 'scratch.txt'), 'x');
          return { summary: 'disabled the test', costUsd: 0.1, error: null };
        }
        writeFileSync(join(request.repoPath, 'src/main/java/demo/Docs.java'), 'import org.springdoc.core.models.GroupedOpenApi;\nclass Docs {}\n');
        return { summary: 'Replaced the springfox Docket with a springdoc GroupedOpenApi bean in Docs.java.', costUsd: 0.2, error: null };
      },
    };

    const report = await runUpgrade(options(repo, maven, fixer));

    expect(report.status).toBe('parity');
    expect(report.attempts.map((attempt) => [attempt.by, attempt.accepted])).toEqual([
      ['ai', false],
      ['ai', true],
    ]);
    expect(report.attempts[0]?.reason).toMatch(/broke a rule: src\/test\/java\/demo\/AppTest\.java adds @Disabled/);
    expect(existsSync(join(repo, 'scratch.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'src/test/java/demo/AppTest.java'), 'utf8')).not.toContain('@Disabled');
    expect(report.commits.map((commit) => commit.layer)).toEqual(['recipe', 'ai', 'report']);
    const aiCommit = gitIn(repo, ['log', '-1', '--format=%B', report.commits[1]!.sha]);
    expect(aiCommit).toContain('Written by an AI fixer (fake)');
    expect(aiCommit).toContain('springdoc GroupedOpenApi');
    expect(report.costUsd).toBeCloseTo(0.3);
  });

  it('rejects a change that turns a baseline-green test red, even if it fixes another', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.7.1') });
    const maven = fakeMaven(
      repo,
      (read) => {
        const upgraded = !read('pom.xml').includes('2.7.1');
        const touched = read('pom.xml').includes('maven.compiler.parameters');
        return {
          build: 'ok',
          tests: {
            binds: upgraded && !touched ? PARAMETERS : 'passed',
            other: upgraded && touched ? 'java.lang.AssertionError: broken by the fix' : 'passed',
          },
        };
      },
      () => writeFileSync(join(repo, 'pom.xml'), POM('3.5.6')),
      [],
    );

    const report = await runUpgrade(options(repo, maven));

    expect(report.status).toBe('stuck');
    expect(report.attempts).toEqual([
      expect.objectContaining({ by: 'known-fix', id: 'compiler-parameters', accepted: false, reason: expect.stringMatching(/turned 1 baseline-green test\(s\) red \(demo\.AppTest#other\)/) }),
    ]);
    expect(readFileSync(join(repo, 'pom.xml'), 'utf8')).not.toContain('maven.compiler.parameters');
  });

  it('refuses a dirty work tree, and a project already on the target', async () => {
    const dirty = repoWith({ 'pom.xml': POM('2.7.1') });
    writeFileSync(join(dirty, 'pom.xml'), POM('2.7.2'));
    await expect(runUpgrade(options(dirty, fakeMaven(dirty, () => ({ build: 'ok', tests: {} }), () => undefined, [])))).rejects.toThrow(UpgradeError);
    const current = repoWith({ 'pom.xml': POM('3.5.6') });
    await expect(runUpgrade(options(current, fakeMaven(current, () => ({ build: 'ok', tests: {} }), () => undefined, [])))).rejects.toThrow(/already on Spring Boot 3\.5\.6/);
  });

  it('does not start when the baseline does not build', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.7.1') });
    const maven = fakeMaven(repo, () => ({ build: '/r/src/main/java/A.java:[1,1] cannot find symbol', tests: {} }), () => undefined, []);
    const report = await runUpgrade(options(repo, maven));
    expect(report.status).toBe('baseline-broken');
    expect(report.commits.map((commit) => commit.layer)).toEqual(['report']);
  });
});
