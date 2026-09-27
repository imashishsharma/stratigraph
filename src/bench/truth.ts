/**
 * The benchmark's inputs: the pinned corpus and the hand-labelled ground truth
 * (ADR-0035, format in `bench/README.md`).
 *
 * Both are validated at load. A truth file with a typo in a key would otherwise
 * score as an empty section, and a missing section is deliberately "not
 * scored" — the two must not be confusable.
 */

import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

export interface CorpusEntry {
  name: string;
  url: string;
  sha: string;
  why: string;
  stacks: string[];
  /** Merged into the generated stratigraph.config.json. */
  config: Record<string, unknown>;
  /** Extra JVM arguments for the Java extractor, e.g. ["-Xmx6g"]. */
  javaOpts: string[];
}

export interface Truth {
  name: string;
  sha: string;
  labelledBy: string;
  roles?: Array<{ path: string; role: string }>;
  containers?: Array<{ name: string; kind: string; path: string }>;
  entities?: Array<{ class: string; table: string }>;
  tables?: string[];
  endpoints?: string[];
  injections?: Array<{ from: string; to: string; via?: string }>;
  riskyFiles?: string[];
}

export class BenchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchInputError';
  }
}

export function loadCorpus(path: string): CorpusEntry[] {
  const doc = readYaml(path) as { repos?: unknown };
  if (!Array.isArray(doc?.repos)) throw new BenchInputError(`${path}: expected a "repos" list`);
  const seen = new Set<string>();
  return doc.repos.map((raw, n) => {
    const where = `${path}: repos[${n}]`;
    const entry = object(raw, where);
    const name = string(entry, 'name', where);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new BenchInputError(`${where}: name must be file-safe`);
    if (seen.has(name)) throw new BenchInputError(`${where}: duplicate name "${name}"`);
    seen.add(name);
    const sha = string(entry, 'sha', where);
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new BenchInputError(`${where}: sha must be a full 40-character commit`);
    return {
      name,
      url: string(entry, 'url', where),
      sha,
      why: typeof entry['why'] === 'string' ? entry['why'] : '',
      stacks: Array.isArray(entry['stacks']) ? entry['stacks'].map(String) : [],
      config: entry['config'] === undefined || entry['config'] === null ? {} : object(entry['config'], `${where}.config`),
      javaOpts: Array.isArray(entry['javaOpts']) ? entry['javaOpts'].map(String) : [],
    };
  });
}

const TRUTH_KEYS = new Set([
  'name',
  'sha',
  'labelledBy',
  'roles',
  'containers',
  'entities',
  'tables',
  'endpoints',
  'injections',
  'riskyFiles',
]);

export function loadTruth(path: string): Truth {
  const doc = object(readYaml(path), path);
  for (const key of Object.keys(doc)) {
    if (!TRUTH_KEYS.has(key)) throw new BenchInputError(`${path}: unknown key "${key}"`);
  }
  const truth: Truth = {
    name: string(doc, 'name', path),
    sha: string(doc, 'sha', path),
    labelledBy: typeof doc['labelledBy'] === 'string' ? doc['labelledBy'] : '',
  };
  if (doc['roles'] != null) {
    truth.roles = list(doc['roles'], `${path}: roles`).map((item, n) => {
      const row = object(item, `${path}: roles[${n}]`);
      return { path: string(row, 'path', path), role: string(row, 'role', path) };
    });
  }
  if (doc['containers'] != null) {
    truth.containers = list(doc['containers'], `${path}: containers`).map((item, n) => {
      const row = object(item, `${path}: containers[${n}]`);
      return {
        name: string(row, 'name', path),
        kind: string(row, 'kind', path),
        path: typeof row['path'] === 'string' ? row['path'] : '.',
      };
    });
  }
  if (doc['entities'] != null) {
    truth.entities = list(doc['entities'], `${path}: entities`).map((item, n) => {
      const row = object(item, `${path}: entities[${n}]`);
      return { class: string(row, 'class', path), table: string(row, 'table', path) };
    });
  }
  if (doc['tables'] != null) truth.tables = list(doc['tables'], `${path}: tables`).map(String);
  if (doc['endpoints'] != null) truth.endpoints = list(doc['endpoints'], `${path}: endpoints`).map(String);
  if (doc['injections'] != null) {
    truth.injections = list(doc['injections'], `${path}: injections`).map((item, n) => {
      const row = object(item, `${path}: injections[${n}]`);
      return {
        from: string(row, 'from', path),
        to: string(row, 'to', path),
        ...(typeof row['via'] === 'string' ? { via: row['via'] } : {}),
      };
    });
  }
  if (doc['riskyFiles'] != null) truth.riskyFiles = list(doc['riskyFiles'], `${path}: riskyFiles`).map(String);
  return truth;
}

function readYaml(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new BenchInputError(`${path}: ${(err as Error).message}`);
  }
  try {
    return parse(text);
  } catch (err) {
    throw new BenchInputError(`${path}: not valid YAML: ${(err as Error).message}`);
  }
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BenchInputError(`${where}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new BenchInputError(`${where}: expected a list`);
  return value;
}

function string(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BenchInputError(`${where}: "${key}" must be a non-empty string`);
  }
  return value;
}
