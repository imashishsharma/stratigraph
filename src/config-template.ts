/**
 * The config file `stratigraph init` writes.
 *
 * Held here rather than read from `stratigraph.config.example.json` at runtime,
 * because the published package ships `dist/` and a file at the repository root
 * is not in it. The example file and this template are checked against each
 * other by a test, so the one people read and the one the tool writes cannot
 * drift apart.
 */

import { DEFAULT_API_KEY_ENV, DEFAULT_HISTORY, DEFAULT_INTERPRET, DEFAULT_MODEL } from './config.js';

export interface TemplateOptions {
  /** Written as `repo`, so the file works from the directory it sits in. */
  repo: string;
}

/**
 * A config holding the defaults, spelled out.
 *
 * Every value is what the tool would do anyway, so writing this file changes
 * nothing until it is edited — which is the point. It is a menu of what can be
 * changed, not a set of decisions made on someone's behalf.
 *
 * `llm.apiKey` is deliberately absent: this file is meant to be committed, and
 * `loadConfig` refuses a key in it.
 */
export function configTemplate(options: TemplateOptions): string {
  const template = {
    repo: options.repo,
    exclude: ['node_modules', 'target', 'build', 'dist', '.git', '.idea', '.gradle'],
    java: { home: null, jar: null },
    history: {
      since: DEFAULT_HISTORY.since,
      maxFilesPerCommit: DEFAULT_HISTORY.maxFilesPerCommit,
      minShared: DEFAULT_HISTORY.minShared,
      minCommits: DEFAULT_HISTORY.minCommits,
    },
    interpret: {
      couplingWeight: DEFAULT_INTERPRET.couplingWeight,
      minClusterSize: DEFAULT_INTERPRET.minClusterSize,
      maxClusters: DEFAULT_INTERPRET.maxClusters,
    },
    llm: {
      enabled: true,
      model: DEFAULT_MODEL,
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      sendSource: false,
    },
    report: {
      brand: { name: null, logo: null, accent: null },
    },
  };

  return `${JSON.stringify(template, null, 2)}\n`;
}

/** The file `config set-key` writes when there is nothing there yet. */
export function userConfigTemplate(apiKey: string): string {
  return `${JSON.stringify({ llm: { apiKey } }, null, 2)}\n`;
}
