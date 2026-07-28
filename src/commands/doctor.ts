import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { loadConfig, type ConfigOverrides } from '../config.js';
import { currentVersion, openDatabase } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/migrations/index.js';
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

  try {
    const config = loadConfig(overrides);
    checks.push({
      name: 'config',
      status: 'ok',
      detail: config.source ?? 'defaults (no stratigraph.config.json found)',
    });
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
