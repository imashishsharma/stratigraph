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

// The upgrade commits with whatever identity git has; CI runners have none.
for (const [key, value] of Object.entries({
  GIT_AUTHOR_NAME: 'Upgrade Test',
  GIT_AUTHOR_EMAIL: 'upgrade@example.invalid',
  GIT_COMMITTER_NAME: 'Upgrade Test',
  GIT_COMMITTER_EMAIL: 'upgrade@example.invalid',
})) {
  process.env[key] ??= value;
}

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
      expect.objectContaining({ by: 'known-fix', id: 'compiler-parameters', accepted: false, reason: expect.stringMatching(/turned 1 passing test\(s\) red \(demo\.AppTest#other\)/) }),
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

  it('stops asking an AI fixer that cannot run, and says so once', async () => {
    const repo = repoWith({
      'pom.xml': POM('2.7.1'),
      'src/main/java/demo/Docs.java': 'import springfox.documentation.Docket;\nclass Docs {}\n',
    });
    const maven = fakeMaven(
      repo,
      (read) =>
        read('pom.xml').includes('2.7.1')
          ? { build: 'ok', tests: { boots: 'passed' } }
          : { build: '/r/src/main/java/demo/Docs.java:[1,34] package springfox.documentation does not exist', tests: {} },
      () => writeFileSync(join(repo, 'pom.xml'), POM('3.5.6')),
      [],
    );
    let calls = 0;
    const fixer: Fixer = {
      name: 'fake',
      attempt: async () => {
        calls += 1;
        return { summary: '', costUsd: 0, error: 'Credit balance is too low', unavailable: true };
      },
    };
    const report = await runUpgrade(options(repo, maven, fixer));
    expect(calls).toBe(1);
    expect(report.status).toBe('stuck');
    expect(report.attempts).toEqual([]);
    expect(report.notes).toContain('The AI fixer could not run (Credit balance is too low); no AI attempts were made. Fix that and run again.');
  });

  it('files an unrecognised compiler error under the category of its file\'s other errors', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.7.1') });
    const maven = fakeMaven(
      repo,
      (read) =>
        read('pom.xml').includes('2.7.1')
          ? { build: 'ok', tests: {} }
          : {
              build:
                '/r/src/main/java/c/WebSecurityConfig.java:[10,72] cannot find symbol\n  symbol:   class WebSecurityConfigurerAdapter\n' +
                '[ERROR] /r/src/main/java/c/WebSecurityConfig.java:[54,4] method does not override or implement a method from a supertype',
              tests: {},
            },
      () => writeFileSync(join(repo, 'pom.xml'), POM('3.5.6')),
      [],
    );
    const report = await runUpgrade(options(repo, maven));
    expect(report.remaining.map((handoff) => handoff.category)).toEqual(['spring-security-config']);
    expect(report.remaining[0]?.evidence).toHaveLength(2);
  });

  it('never reads the previous build\'s test reports as the current build\'s', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.7.1') });
    // A Maven whose upgraded builds fail in `clean`, leaving target/ exactly as
    // the baseline left it — the kafdrop case.
    const maven: Maven = async (args, label) => {
      const logPath = join(repo, '..', `${label}.log`);
      if (args.some((arg) => arg.includes('rewrite-maven-plugin'))) {
        writeFileSync(join(repo, 'pom.xml'), POM('3.5.6'));
        return { exitCode: 0, timedOut: false, logPath, log: '[INFO] BUILD SUCCESS\n', seconds: 1 };
      }
      if (label === 'baseline') {
        mkdirSync(join(repo, 'target', 'surefire-reports'), { recursive: true });
        writeFileSync(join(repo, 'target', 'surefire-reports', 'TEST-demo.AppTest.xml'), '<testsuite><testcase name="boots" classname="demo.AppTest"/></testsuite>');
        return { exitCode: 0, timedOut: false, logPath, log: '[INFO] BUILD SUCCESS\n', seconds: 1 };
      }
      const log = '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-clean-plugin:3.4.1:clean (default-clean) on project demo: The plugin org.apache.maven.plugins:maven-clean-plugin:3.4.1 requires Maven version 3.6.3 -> [Help 1]\n[INFO] BUILD FAILURE\n';
      return { exitCode: 1, timedOut: false, logPath, log, seconds: 1 };
    };
    const report = await runUpgrade(options(repo, maven));
    expect(report.final?.built).toBe(false);
    expect(report.final?.tests).toBe(0);
    expect(report.final?.missing).toBe(1);
    expect(report.remaining.map((handoff) => handoff.category)).toEqual(['maven-too-old']);
  });

  it('treats a green build that ran fewer of the baseline\'s tests as a failure (WebGoat\'s integration tests)', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.7.1') });
    const maven = fakeMaven(
      repo,
      (read) => ({
        build: 'ok',
        tests: read('pom.xml').includes('2.7.1') ? { unit: 'passed', integration: 'passed' } : { unit: 'passed' },
      }),
      () => writeFileSync(join(repo, 'pom.xml'), POM('3.5.6')),
      [],
    );
    const report = await runUpgrade(options(repo, maven));
    expect(report.status).toBe('stuck');
    expect(report.remaining).toEqual([
      expect.objectContaining({
        category: 'tests-not-run',
        evidence: [expect.objectContaining({ message: expect.stringContaining('demo.AppTest#integration') })],
      }),
    ]);
    expect(readFileSync(join(repo, 'upgrade-report.md'), 'utf8')).toContain('the build succeeded, but these tests were not run');
  });

  it('counts getting past dependency resolution as progress, though the compiler then reports more errors (blog-app)', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.7.4', '\n        <selenium.version>4.3.0</selenium.version>') });
    const maven = fakeMaven(
      repo,
      (read) => {
        const pom = read('pom.xml');
        if (pom.includes('2.7.4')) return { build: 'ok', tests: { boots: 'passed' } };
        if (pom.includes('selenium.version')) {
          return {
            build: '[ERROR] Some problems were encountered while processing the POMs:\n[ERROR] Non-resolvable import POM: Could not find artifact org.seleniumhq.selenium:selenium-bom:pom:4.3.0 in central @ line 9, column 25',
            tests: {},
          };
        }
        return {
          build:
            '/r/src/main/java/a/A.java:[1,1] cannot find symbol\n[ERROR] /r/src/main/java/a/B.java:[2,1] cannot find symbol\n[ERROR] /r/src/main/java/a/C.java:[3,1] cannot find symbol',
          tests: {},
        };
      },
      () => writeFileSync(join(repo, 'pom.xml'), read(repo).replace('2.7.4', '3.5.6')),
      [],
    );
    const report = await runUpgrade(options(repo, maven));
    expect(report.attempts[0]).toMatchObject({ id: 'stale-bom-override', accepted: true });
    expect(report.commits.map((commit) => commit.layer)).toContain('known-fix');
  });

  it('finds test reports in a configured reportsDirectory (JHipster: target/test-results)', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.7.1') });
    const maven: Maven = async (args, label) => {
      const logPath = join(repo, '..', `${label}.log`);
      if (args.some((arg) => arg.includes('rewrite-maven-plugin'))) {
        writeFileSync(join(repo, 'pom.xml'), POM('3.5.6'));
        return { exitCode: 0, timedOut: false, logPath, log: '[INFO] BUILD SUCCESS\n', seconds: 1 };
      }
      mkdirSync(join(repo, 'target', 'test-results', 'test'), { recursive: true });
      writeFileSync(join(repo, 'target', 'test-results', 'test', 'TEST-a.ATest.xml'), '<testsuite><testcase name="t" classname="a.ATest"/></testsuite>');
      return { exitCode: 0, timedOut: false, logPath, log: '[INFO] BUILD SUCCESS\n', seconds: 1 };
    };
    const report = await runUpgrade(options(repo, maven));
    expect(report.baseline?.tests).toBe(1);
    expect(report.status).toBe('parity');
  });

  it('does not work on a coverage gate while the tests it measures are red, and lets the decision set the status (petclinic-rest)', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.6.2') });
    const calls: string[] = [];
    const fixer: Fixer = {
      name: 'fake',
      attempt: async (request) => {
        calls.push(request.target[0]!.category.id);
        return { summary: '', costUsd: 0, error: null };
      },
    };
    const maven: Maven = async (args, label) => {
      const logPath = join(repo, '..', `${label}.log`);
      if (args.some((arg) => arg.includes('rewrite-maven-plugin'))) {
        writeFileSync(join(repo, 'pom.xml'), POM('3.5.6'));
        return { exitCode: 0, timedOut: false, logPath, log: '[INFO] BUILD SUCCESS\n', seconds: 1 };
      }
      const upgraded = !read(repo).includes('2.6.2');
      mkdirSync(join(repo, 'target', 'surefire-reports'), { recursive: true });
      writeFileSync(
        join(repo, 'target', 'surefire-reports', 'TEST-r.OwnerTest.xml'),
        upgraded
          ? '<testsuite><testcase name="list" classname="r.OwnerTest"><failure message="Status expected:&lt;200&gt; but was:&lt;404&gt;"/></testcase></testsuite>'
          : '<testsuite><testcase name="list" classname="r.OwnerTest"/></testsuite>',
      );
      const log = upgraded
        ? '[ERROR] Failed to execute goal org.jacoco:jacoco-maven-plugin:0.8.13:check (check) on project petclinic: Coverage checks have not been met. See log for details.\n[INFO] BUILD FAILURE\n'
        : '[INFO] BUILD SUCCESS\n';
      return { exitCode: upgraded ? 1 : 0, timedOut: false, logPath, log, seconds: 1 };
    };
    const report = await runUpgrade(options(repo, maven, fixer));
    expect(calls).toEqual([]);
    expect(report.status).toBe('needs-decision');
    expect(report.remaining.map((handoff) => [handoff.category, handoff.consequence ?? false])).toEqual([
      ['coverage-gate', true],
      ['http-contract-change', false],
    ]);
    expect(readFileSync(join(repo, 'upgrade-report.md'), 'utf8')).toContain('## Expected to clear with the above');
  });

  it('says plainly when parity rests on no tests at all (mall-tiny)', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.7.5') });
    const maven = fakeMaven(repo, () => ({ build: 'ok', tests: {} }), () => writeFileSync(join(repo, 'pom.xml'), POM('3.5.6')), []);
    const report = await runUpgrade(options(repo, maven));
    expect(report.status).toBe('parity');
    expect(report.notes[0]).toMatch(/No tests ran before the upgrade/);
    expect(readFileSync(join(repo, 'upgrade-report.md'), 'utf8')).toContain('nothing about its behaviour was verified');
  });

  it('keeps a fix that gets the build further, though it fails just once again (kafdrop: clean, then compile)', async () => {
    const repo = repoWith({
      'pom.xml': POM('2.7.5'),
      '.mvn/wrapper/maven-wrapper.properties': 'distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.6.1/apache-maven-3.6.1-bin.zip\n',
    });
    const wrapper = () => readFileSync(join(repo, '.mvn/wrapper/maven-wrapper.properties'), 'utf8');
    const maven: Maven = async (args, label) => {
      const logPath = join(repo, '..', `${label}.log`);
      const ok = (text = '') => ({ exitCode: 0, timedOut: false, logPath, log: `${text}[INFO] BUILD SUCCESS\n`, seconds: 1 });
      if (args.some((arg) => arg.includes('rewrite-maven-plugin'))) {
        writeFileSync(join(repo, 'pom.xml'), POM('3.5.6'));
        return ok();
      }
      if (read(repo).includes('2.7.5')) return ok();
      if (wrapper().includes('3.6.1')) {
        return { exitCode: 1, timedOut: false, logPath, seconds: 1, log: '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-clean-plugin:3.4.1:clean (default-clean) on project k: The plugin org.apache.maven.plugins:maven-clean-plugin:3.4.1 requires Maven version 3.6.3 -> [Help 1]\n[INFO] BUILD FAILURE\n' };
      }
      return {
        exitCode: 1,
        timedOut: false,
        logPath,
        seconds: 1,
        log: '[INFO] --- maven-clean-plugin:3.4.1:clean (default-clean) @ k ---\n[INFO] --- maven-compiler-plugin:3.14.0:compile (default-compile) @ k ---\n[ERROR] COMPILATION ERROR : \n[ERROR] error: exporting a package from system module jdk.management.agent is not allowed with --release\n[INFO] BUILD FAILURE\n',
      };
    };
    const report = await runUpgrade(options(repo, maven));
    expect(report.attempts[0]).toMatchObject({ id: 'maven-wrapper-version', accepted: true });
    expect(report.remaining.map((handoff) => handoff.category)).toEqual(['compiler-release-conflict']);
  });

  it('counts getting skipped tests to run as progress, even when some of them fail (WebGoat\'s integration tests)', async () => {
    const repo = repoWith({ 'pom.xml': POM('2.7.1') });
    let turn = 0;
    const fixer: Fixer = {
      name: 'fake',
      attempt: async (request) => {
        turn += 1;
        writeFileSync(join(request.repoPath, 'it.txt'), 'restored the integration test setup');
        return { summary: 'Restored the process the integration tests start.', costUsd: 0, error: null };
      },
    };
    const its = ['a', 'b', 'c', 'd'];
    const maven = fakeMaven(
      repo,
      (readFile) => {
        if (readFile('pom.xml').includes('2.7.1')) return { build: 'ok', tests: Object.fromEntries([['unit', 'passed'], ...its.map((id) => [id, 'passed'])]) };
        if (!readFile('it.txt')) return { build: 'ok', tests: { unit: 'passed' } };
        return { build: 'ok', tests: { unit: 'passed', a: 'passed', b: 'passed', c: 'passed', d: 'java.lang.AssertionError: 403' } };
      },
      () => writeFileSync(join(repo, 'pom.xml'), POM('3.5.6')),
      [],
    );
    const report = await runUpgrade(options(repo, maven, fixer));
    expect(report.attempts[0]).toMatchObject({ by: 'ai', accepted: true });
    expect(report.final?.regressed).toEqual(['demo.AppTest#d']);
    expect(report.final?.missing).toBe(0);
    expect(turn).toBeGreaterThanOrEqual(1);
  });

  it('reads the line a compiler error points at to categorise it (blog-app: the recipe\'s @Type(uuid-char.class))', async () => {
    const repo = repoWith({
      'pom.xml': POM('2.7.4'),
      'src/main/java/a/ReceivedFile.java': 'package a;\nclass ReceivedFile {\n    @Type(type = "uuid-char")\n    Object id;\n}\n',
    });
    const maven = fakeMaven(
      repo,
      (readFile) =>
        readFile('pom.xml').includes('2.7.4')
          ? { build: 'ok', tests: {} }
          : { build: `${repo}/src/main/java/a/ReceivedFile.java:[3,11] cannot find symbol\n  symbol:   variable uuid`, tests: {} },
      () => {
        writeFileSync(join(repo, 'pom.xml'), POM('3.5.6'));
        writeFileSync(join(repo, 'src/main/java/a/ReceivedFile.java'), 'package a;\nclass ReceivedFile {\n    @Type(uuid-char.class)\n    Object id;\n}\n');
      },
      [],
    );
    const report = await runUpgrade(options(repo, maven));
    expect(report.remaining.map((handoff) => handoff.category)).toEqual(['hibernate-6']);
  });

  it('counts a compiler that starts as progress over one that refuses its options (kafdrop: --add-exports, then springfox)', async () => {
    const pom = POM('2.7.5').replace(
      '<dependencies>',
      '<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><compilerArgs>\n<arg>--add-exports</arg>\n<arg>jdk.management.agent/jdk.internal.agent=ALL-UNNAMED</arg>\n</compilerArgs></configuration></plugin></plugins></build>\n    <dependencies>',
    );
    const repo = repoWith({ 'pom.xml': pom, 'src/main/java/k/Swagger.java': 'class Swagger {}' });
    const maven = fakeMaven(
      repo,
      (readFile) => {
        const text = readFile('pom.xml');
        if (text.includes('2.7.5')) return { build: 'ok', tests: {} };
        if (text.includes('--add-exports')) return { build: 'error: exporting a package from system module jdk.management.agent is not allowed with --release', tests: {} };
        return {
          build: `${repo}/src/main/java/k/Swagger.java:[3,1] package springfox.documentation does not exist\n[ERROR] ${repo}/src/main/java/k/Swagger.java:[4,1] package springfox.documentation.spi does not exist`,
          tests: {},
        };
      },
      () => writeFileSync(join(repo, 'pom.xml'), read(repo).replace('2.7.5', '3.5.6')),
      [],
    );
    const report = await runUpgrade(options(repo, maven));
    expect(report.attempts[0]).toMatchObject({ id: 'drop-unused-add-exports', accepted: true });
    expect(report.remaining.map((handoff) => handoff.category)).toEqual(['springfox']);
  });

  it('counts parsing as progress over syntax errors, even at javac\'s error cap (petclinic-reactjs)', async () => {
    const repo = repoWith({ 'pom.xml': POM('3.2.1'), 'src/main/resources/openapi.yml': 'example: "allowed: [\\"string\\"]"\n' });
    const fixer: Fixer = {
      name: 'fake',
      attempt: async (request) => {
        writeFileSync(join(request.repoPath, 'src/main/resources/openapi.yml'), "example: \"allowed: ['string']\"\n");
        return { summary: 'Avoided the generator escaping bug in one example.', costUsd: 0, error: null };
      },
    };
    const errors = (make: (i: number) => string) => Array.from({ length: 100 }, (_, i) => make(i)).join('\n[ERROR] ');
    const maven = fakeMaven(
      repo,
      (readFile) => {
        if (readFile('pom.xml').includes('3.2.1')) return { build: 'ok', tests: {} };
        return readFile('src/main/resources/openapi.yml').includes('\\"')
          ? { build: errors((i) => `${repo}/target/generated-sources/openapi/Api${i}.java:[83,304] ';' expected`), tests: {} }
          : { build: errors((i) => `${repo}/target/generated-sources/openapi/Api${i}.java:[29,24] package javax.validation does not exist`), tests: {} };
      },
      () => writeFileSync(join(repo, 'pom.xml'), POM('4.0.8')),
      [],
    );
    const report = await runUpgrade(options(repo, maven, fixer));
    expect(report.attempts.find((attempt) => attempt.by === 'ai')).toMatchObject({ accepted: true });
  });
});

function read(repo: string): string {
  return readFileSync(join(repo, 'pom.xml'), 'utf8');
}
