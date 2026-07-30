import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

import {
  describeSource,
  loadConfig,
  LOCAL_CONFIG_FILENAME,
  userConfigPath,
  type ConfigOverrides,
  type StratigraphConfig,
} from '../config.js';
import { currentVersion, openDatabase } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/migrations/index.js';
import { countCommits, gitToplevel, isShallowClone } from '../history/git-log.js';
import { findExtractorJar, JAR_ENV_VAR } from '../toolchain/extractor-jar.js';
import { resolveCredential, type Credential } from '../interpret/client.js';
import { discoverJavaRuntimes, findJava, MIN_JAVA_MAJOR } from '../toolchain/java.js';
import { TOOL_VERSION } from '../version.js';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'missing';
  detail: string;
}

/**
 * What this machine can and cannot do. The published package supports a range
 * of Node versions and does not require any particular JDK to be installed —
 * a missing JVM only disables the Java extractor, so it is a warning, never an
 * error.
 */
export function runDoctor(overrides: ConfigOverrides): Check[] {
  const checks: Check[] = [];

  checks.push({
    name: 'stratigraph',
    status: 'ok',
    detail: `v${TOOL_VERSION}, fact-store schema v${SCHEMA_VERSION}`,
  });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node',
    status: nodeMajor >= 18 ? 'ok' : 'warn',
    detail:
      nodeMajor >= 18
        ? `v${process.versions.node} on ${process.platform}-${process.arch}`
        : `v${process.versions.node} is below the supported minimum (18.18)`,
  });

  checks.push(probe('git', ['--version'], 'history mining is unavailable without git'));

  const java = findJava({ home: overrides.javaHome });
  if (!java) {
    checks.push({
      name: 'java',
      status: 'warn',
      detail: `not found — the Java extractor needs a JDK ${MIN_JAVA_MAJOR}+ (set java.home or JAVA_HOME); every other extractor still runs`,
    });
  } else if (!java.meetsMinimum) {
    const alternatives = discoverJavaRuntimes({ home: overrides.javaHome });
    const hint =
      alternatives.length > 0
        ? ` (found ${alternatives.map((r) => r.version).join(', ')} installed, none new enough)`
        : '';
    checks.push({
      name: 'java',
      status: 'warn',
      detail: `${java.version} from ${java.source} is below JDK ${MIN_JAVA_MAJOR}${hint}; the Java extractor will not run — this limits the analyser, not the code it can analyse`,
    });
  } else {
    checks.push({
      name: 'java',
      status: 'ok',
      detail: `${java.version} from ${java.source}${java.home ? ` (${java.home})` : ''}`,
    });
  }

  // A missing jar disables the Java extractor, exactly as a missing JDK does.
  // Reported separately from `java` because the two fail for different reasons
  // and have different fixes.
  const jar = findExtractorJar({ jar: overrides.extractorJar });
  checks.push(
    jar
      ? {
          name: 'extractor',
          status: 'ok',
          // The build date is here because `mvn test` does not repackage, so a
          // developer can easily be running a jar older than their last change
          // and see stale facts with nothing to explain them.
          detail: `${jar.path} (${jar.source}, built ${builtAt(jar.path)})`,
        }
      : {
          name: 'extractor',
          status: 'warn',
          detail: `Java extractor jar not found — build it with \`cd extractors/java && ./mvnw package\`, or set java.jar / ${JAR_ENV_VAR}`,
        },
  );

  try {
    const config = loadConfig(overrides);
    checks.push({ name: 'config', status: 'ok', detail: describeSource(config) });
    checks.push(modelCheck(config, overrides.env ?? process.env));
    checks.push(historyCheck(config.repoPath));
    if (existsSync(config.dbPath)) {
      const db = openDatabase(config.dbPath, { mustExist: true, readonly: true });
      const version = currentVersion(db);
      db.close();
      checks.push({
        name: 'database',
        status: version === SCHEMA_VERSION ? 'ok' : 'warn',
        detail:
          version === SCHEMA_VERSION
            ? `${config.dbPath} (schema v${version})`
            : `${config.dbPath} is at schema v${version}, tool expects v${SCHEMA_VERSION} — run \`stratigraph init\``,
      });
    } else {
      checks.push({
        name: 'database',
        status: 'missing',
        detail: `${config.dbPath} does not exist yet — run \`stratigraph init\``,
      });
    }
  } catch (err) {
    checks.push({ name: 'config', status: 'warn', detail: (err as Error).message });
  }

  return checks;
}

/**
 * Whether the interpretation layer can run, and on what.
 *
 * Reports *where* the credential came from and never the credential itself —
 * `doctor` output is the first thing anyone pastes into an issue. A missing one
 * is a warning, not an error: the structural report is the larger half of what
 * this tool does and needs no model at all.
 */
function modelCheck(config: StratigraphConfig, env: NodeJS.ProcessEnv): Check {
  if (!config.llm.enabled) {
    return {
      name: 'model',
      status: 'missing',
      detail: 'interpretation disabled (llm.enabled = false) — structural output only',
    };
  }

  let credential: Credential | null;
  try {
    credential = resolveCredential(config.llm, env);
  } catch (err) {
    return { name: 'model', status: 'warn', detail: (err as Error).message };
  }

  return credential === null
    ? {
        name: 'model',
        status: 'warn',
        // Names the exact file to create rather than the idea of one: this
        // line is where someone finds out they need to do something.
        detail:
          `${config.llm.model}, but no credential found. Any one of: ` +
          `create ${userConfigPath()} with {"llm":{"apiKey":"sk-ant-..."}}; ` +
          `put the same in ${LOCAL_CONFIG_FILENAME} beside your project config; ` +
          `export ${config.llm.apiKeyEnv}; or run \`ant auth login\`. ` +
          `Structural output is unaffected.`,
      }
    : {
        name: 'model',
        status: 'ok',
        detail: `${config.llm.model}, credential from ${credential.describe}`,
      };
}

/**
 * How much history there is to mine.
 *
 * A shallow clone is the trap worth naming: `git log` succeeds, mining
 * succeeds, and every number comes out a fraction of the truth with nothing to
 * explain it.
 */
function historyCheck(repoPath: string): Check {
  const toplevel = gitToplevel(repoPath);
  if (toplevel === null) {
    return {
      name: 'history',
      status: 'missing',
      detail: `${repoPath} is not inside a git repository — churn, coupling and ownership are unavailable`,
    };
  }
  if (isShallowClone(repoPath)) {
    return {
      name: 'history',
      status: 'warn',
      detail: `shallow clone — most commits are absent, so every history metric will be understated; run \`git fetch --unshallow\``,
    };
  }
  const commits = countCommits(repoPath);
  return {
    name: 'history',
    status: 'ok',
    detail:
      commits === null
        ? `${toplevel} (no commits yet)`
        : `${commits} commits in ${toplevel}${repoPath === toplevel ? '' : ` (analysing ${repoPath})`}`,
  };
}

function builtAt(path: string): string {
  try {
    return statSync(path).mtime.toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return 'unknown';
  }
}

function probe(bin: string, args: string[], missingHint: string): Check {
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { name: bin, status: 'ok', detail: out.split('\n')[0] ?? out };
  } catch {
    return { name: bin, status: 'warn', detail: `not found — ${missingHint}` };
  }
}
