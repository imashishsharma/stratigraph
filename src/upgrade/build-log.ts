/**
 * What a Maven build said went wrong, read from its log — ADR-0047.
 *
 * Transcription only: every failure carries the log lines it came from, and a
 * compiler error its file and line. Test failures are not read here; they come
 * from the Surefire/Failsafe reports, which say which test, not just how many.
 */

import { isAbsolute, relative } from 'node:path';

export type BuildFailureKind = 'pom' | 'compile' | 'plugin' | 'dependency';

export interface BuildFailure {
  kind: BuildFailureKind;
  /** The error text, e.g. "package javax.validation does not exist". */
  message: string;
  /** Repo-relative, forward slashes; null when the error names no file. */
  file: string | null;
  line: number | null;
  /** For "cannot find symbol": what the compiler could not find. */
  symbol: string | null;
  /** The log lines this failure was read from, as evidence. */
  excerpt: string[];
}

export interface BuildLog {
  /** Maven reported BUILD SUCCESS. */
  success: boolean;
  failures: BuildFailure[];
  /**
   * Plugin goals Maven started ("--- plugin:version:goal"): how far through
   * the lifecycle a failing build got. A fix that lets `clean` run and fails
   * at `compile` instead has made progress, though both fail once.
   */
  goals: number;
}

const ERROR = /^\[ERROR\] ?(.*)$/;
const COMPILE = /^(.+\.(?:java|kt)):\[(\d+),(\d+)\] (.+)$/;
const COMPILE_BARE = /^error: (.+)$/;
const POM_PROBLEMS = 'Some problems were encountered while processing the POMs';

export function parseBuildLog(text: string, repoPath: string): BuildLog {
  const lines = text.split(/\r?\n/);
  const failures: BuildFailure[] = [];
  const seen = new Map<string, BuildFailure>();
  // Maven prints compiler errors twice (the COMPILATION ERROR block and the
  // goal summary), with the symbol detail on only one of them sometimes.
  const push = (failure: BuildFailure) => {
    const key = `${failure.kind}\0${failure.file}\0${failure.line}\0${failure.message}`;
    const previous = seen.get(key);
    if (previous) {
      if (previous.symbol === null && failure.symbol !== null) {
        previous.symbol = failure.symbol;
        previous.excerpt = failure.excerpt;
      }
      return;
    }
    seen.set(key, failure);
    failures.push(failure);
  };

  let inPomProblems = false;
  for (let i = 0; i < lines.length; i += 1) {
    const match = ERROR.exec(lines[i] as string);
    if (!match) {
      inPomProblems = false;
      continue;
    }
    const body = (match[1] as string).replace(/^\[ERROR\] ?/, '').trimEnd();

    if (body.includes(POM_PROBLEMS)) {
      inPomProblems = true;
      continue;
    }

    const compile = COMPILE.exec(body);
    if (compile) {
      // The compiler prints "symbol:" and "location:" on the lines after.
      const excerpt = [lines[i] as string];
      let symbol: string | null = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
        const raw = lines[j] as string;
        const next = (ERROR.exec(raw)?.[1] ?? raw).trim();
        const detail = /^(symbol|location):\s+(.+)$/.exec(next);
        if (!detail) break;
        excerpt.push(lines[j] as string);
        if (detail[1] === 'symbol') symbol = (detail[2] as string).trim();
      }
      push({
        kind: 'compile',
        message: (compile[4] as string).trim(),
        file: repoRelative(compile[1] as string, repoPath),
        line: Number(compile[2]),
        symbol,
        excerpt,
      });
      continue;
    }

    const bare = COMPILE_BARE.exec(body);
    if (bare) {
      push({ kind: 'compile', message: (bare[1] as string).trim(), file: null, line: null, symbol: null, excerpt: [lines[i] as string] });
      continue;
    }

    if (inPomProblems || /^Non-resolvable (?:import|parent) POM/.test(body) || /^'[\w.]+' for [\w.:-]+ is missing/.test(body)) {
      const trimmed = body.trim();
      if (/^The (?:project|build could not read)/.test(trimmed) || trimmed === '') continue;
      push({
        kind: /Non-resolvable|could not be resolved/.test(trimmed) ? 'dependency' : 'pom',
        message: trimmed.replace(/ @ line \d+, column \d+$/, '').replace(/ @ \S+$/, ''),
        file: 'pom.xml',
        line: pomLine(trimmed),
        symbol: null,
        excerpt: [lines[i] as string],
      });
      continue;
    }

    const goal = /^Failed to execute goal ([\w.-]+:[\w.-]+):[\w.-]+:([\w-]+)(?: \([^)]*\))? on project [\w.-]+: (.+)$/.exec(body);
    if (goal) {
      const [, plugin, goalName, rest] = goal as unknown as [string, string, string, string];
      // The compiler plugin's summary repeats the errors already read above.
      if (plugin.endsWith('maven-compiler-plugin') && /Compilation failure/.test(rest)) continue;
      if (/There are test failures|There were test failures/.test(rest)) continue;
      const excerpt = [lines[i] as string];
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
        const next = ERROR.exec(lines[j] as string)?.[1] ?? '';
        if (next.trim() === '' || /^-> \[Help|^To see the full|^Re-run Maven|^\[Help/.test(next.trim())) break;
        excerpt.push(lines[j] as string);
      }
      push({
        kind: /Could not resolve dependencies|could not be resolved/.test(rest) ? 'dependency' : 'plugin',
        message: `${plugin}:${goalName}: ${rest.trim()}`,
        file: null,
        line: null,
        symbol: null,
        excerpt,
      });
    }
  }

  const goals = (text.match(/^\[INFO\] --- [\w.-]+:[\w.-]+:[\w.-]+/gm) ?? []).length;
  return { success: /^\[INFO\] BUILD SUCCESS\s*$/m.test(text), failures, goals };
}

function pomLine(message: string): number | null {
  const at = / @ line (\d+), column \d+$/.exec(message);
  return at ? Number(at[1]) : null;
}

function repoRelative(path: string, repoPath: string): string {
  const cleaned = path.trim();
  const rel = isAbsolute(cleaned) ? relative(repoPath, cleaned) : cleaned;
  return rel.split('\\').join('/');
}
