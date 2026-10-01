/**
 * The AI fixer: the Claude Code CLI, run headless in the repository — ADR-0047.
 *
 * Only with `--ai claude-code`, only for mechanical and judgment failures, and
 * never trusted: every attempt is rebuilt and kept only if the failures shrank
 * without a baseline-green test turning red (loop.ts). The guardrails that do
 * not depend on the model's good behaviour live here too: an attempt that
 * disables or deletes tests is rejected whatever the build says.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { Classified } from './known-fixes.js';

export interface FixerRequest {
  repoPath: string;
  from: string;
  to: string;
  /** The failures this attempt is about: one category, possibly several files. */
  target: Classified[];
  /** Everything still failing, for context. */
  others: Classified[];
  attempt: number;
  logDir: string;
  javaHome: string;
  mavenArgs: string[];
}

export interface FixerResult {
  /** The fixer's own account of its change, recorded as authored by a model. */
  summary: string;
  costUsd: number | null;
  error: string | null;
  /**
   * The fixer could not run at all (no credit, not logged in, the API down):
   * not a failed fix, and no reason to try the next one.
   */
  unavailable?: boolean;
}

export interface Fixer {
  name: string;
  attempt: (request: FixerRequest) => Promise<FixerResult>;
}

export interface ClaudeCodeOptions {
  /** The CLI to run; default `claude`. */
  command?: string | undefined;
  model?: string | undefined;
  /** Per attempt. */
  maxBudgetUsd: number;
  timeoutMs: number;
  /**
   * Keep ANTHROPIC_API_KEY in the CLI's environment. Off by default: the
   * Claude Code CLI prefers that key over the user's login, and a key left in
   * a shell for something else should not silently pay for (or fail) an upgrade.
   */
  useApiKey?: boolean | undefined;
}

export function claudeCodeFixer(options: ClaudeCodeOptions): Fixer {
  return {
    name: 'claude-code',
    attempt: (request) =>
      new Promise((resolvePromise) => {
        const prompt = fixPrompt(request);
        writeFileSync(join(request.logDir, `ai-${request.attempt}-prompt.md`), prompt);
        const args = [
          '-p',
          prompt,
          '--output-format',
          'json',
          '--permission-mode',
          'acceptEdits',
          '--allowedTools',
          'Read',
          'Edit',
          'Write',
          'Glob',
          'Grep',
          'Bash(mvn:*)',
          'Bash(./mvnw:*)',
          '--disallowedTools',
          'Bash(git:*)',
          'Bash(curl:*)',
          'Bash(wget:*)',
          'Bash(rm:*)',
          'WebFetch',
          'WebSearch',
          '--max-budget-usd',
          String(options.maxBudgetUsd),
          '--no-session-persistence',
          ...(options.model ? ['--model', options.model] : []),
        ];
        const child = spawn(options.command ?? 'claude', args, {
          cwd: request.repoPath,
          env: {
            ...withoutApiKey(process.env, options.useApiKey === true),
            JAVA_HOME: request.javaHome,
            PATH: `${join(request.javaHome, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
        const finish = (error: string | null) => {
          clearTimeout(timer);
          writeFileSync(join(request.logDir, `ai-${request.attempt}-output.json`), stdout || stderr);
          let summary = '';
          let costUsd: number | null = null;
          let unavailable = false;
          try {
            const parsed = JSON.parse(stdout) as {
              result?: string;
              total_cost_usd?: number;
              is_error?: boolean;
              api_error_status?: number;
              terminal_reason?: string;
            };
            summary = (parsed.result ?? '').trim();
            costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
            if (parsed.is_error) {
              error = summary || error || 'the fixer reported an error';
              unavailable =
                parsed.terminal_reason === 'api_error' ||
                typeof parsed.api_error_status === 'number' ||
                UNAVAILABLE.test(summary);
              // An error message is not the model's account of a change.
              summary = '';
            }
          } catch {
            if (error === null) error = (stderr || stdout).trim().slice(0, 500) || 'no output';
            unavailable = UNAVAILABLE.test(stderr) || /could not start/.test(error ?? '');
          }
          resolvePromise({ summary, costUsd, error, unavailable });
        };
        child.on('error', (err) => finish(`could not start ${options.command ?? 'claude'}: ${err.message}`));
        child.on('close', (code) => finish(code === 0 ? null : `exited with status ${code}`));
      }),
  };
}

const UNAVAILABLE = /credit balance|not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|rate limit|overloaded/i;

function withoutApiKey(env: NodeJS.ProcessEnv, keep: boolean): NodeJS.ProcessEnv {
  if (keep) return env;
  const { ANTHROPIC_API_KEY: _dropped, ...rest } = env;
  return rest;
}

export function fixPrompt(request: FixerRequest): string {
  const category = request.target[0]?.category;
  const evidence = request.target
    .slice(0, 12)
    .map((failure) => {
      if (failure.test) return `- test ${failure.test.id}: ${failure.test.message ?? '(no message)'}${failure.test.cause ? ` (cause: ${failure.test.cause})` : ''}`;
      if (!failure.build) return `- ${failure.text.split('\n').slice(1).join(' ')}`;
      const where = failure.build?.file ? `${failure.build.file}${failure.build.line ? `:${failure.build.line}` : ''}` : '(no file)';
      return `- ${where}: ${failure.build?.message ?? failure.text.split('\n')[0]}${failure.build?.symbol ? ` (symbol: ${failure.build.symbol})` : ''}`;
    })
    .join('\n');
  const rest = request.others
    .filter((other) => !request.target.includes(other))
    .slice(0, 8)
    .map((other) => `- [${other.category.id}] ${other.text.split('\n')[0]?.slice(0, 160)}`)
    .join('\n');
  const build = `mvn -B clean verify -Dmaven.test.failure.ignore=true ${request.mavenArgs.join(' ')}`.trim();

  return `You are finishing a Spring Boot ${request.from} → ${request.to} upgrade of this Maven project.
OpenRewrite's upgrade recipe has already run and its output is committed. Known mechanical fixes have been applied.
Fix the failures below, and only those.

## Failures: ${category?.title ?? 'unrecognised'} (${category?.id ?? 'uncategorised'})
${evidence}

## What usually causes this
${category?.guidance ?? 'Read the failure and its cause.'}

## Rules (a change that breaks one is rejected automatically)
- Do not delete, disable (@Disabled, @Ignore) or skip tests, and do not change what a test asserts.
- Do not weaken security: keep every permitAll/authenticated/role rule and its order.
- Never edit files under target/ or other generated output; fix the generator or its input instead.
- Make the smallest change that restores the behaviour the project had before the upgrade.
- Do not run git. Do not download anything by hand; Maven may resolve dependencies.
- If the right fix changes behaviour (an API contract, an authorisation rule, data semantics), do not make it:
  say so in your summary and stop.

You may verify with a narrower build than the full one (e.g. \`mvn -q -o compile\` or \`-Dtest=...\`).
The full build that will judge your change is:
  ${build}

${rest ? `## Other failures still open (not yours to fix now)\n${rest}\n` : ''}
End with a short summary: what you changed, in which files, and why. If you made no change, say why.`;
}

export interface GuardrailViolation {
  file: string;
  reason: string;
}

/**
 * Changes an attempt is not allowed to make, read from its diff: disabling a
 * test, or removing more @Test methods than it adds.
 */
export function guardrailViolations(diff: string): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  let file = '';
  let removedTests = 0;
  let addedTests = 0;
  const flush = () => {
    if (file !== '' && removedTests > addedTests) {
      violations.push({ file, reason: `removes ${removedTests - addedTests} @Test method(s)` });
    }
    removedTests = 0;
    addedTests = 0;
  };
  for (const line of diff.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      flush();
      file = header[1] as string;
      continue;
    }
    if (/^\+\s*@(Disabled|Ignore)\b/.test(line)) violations.push({ file, reason: `adds @${/@(\w+)/.exec(line)?.[1]}` });
    if (/^-\s*@Test\b/.test(line)) removedTests += 1;
    if (/^\+\s*@Test\b/.test(line)) addedTests += 1;
    if (/^\+.*<skipTests>true<\/skipTests>|^\+.*maven\.test\.skip/.test(line)) violations.push({ file, reason: 'skips tests in the build' });
  }
  flush();
  // A deleted test file shows as "+++ /dev/null".
  for (const match of diff.matchAll(/^--- a\/(\S*src\/test\/\S+)\n\+\+\+ \/dev\/null/gm)) {
    violations.push({ file: match[1] as string, reason: 'deletes a test file' });
  }
  return violations;
}
