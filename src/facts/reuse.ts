/**
 * Reusing an extractor's facts when nothing it reads has changed — ADR-0046.
 *
 * An extractor is a function of the files it reads and of itself: the same
 * bytes into the same extractor give the same fact stream. So the stream is
 * kept, compressed, next to the store, keyed by a hash of both; a later run
 * whose key matches replays it through the same writer instead of starting the
 * extractor. Nothing is inferred and nothing is patched — a replayed stream is
 * the stream the extractor would have printed.
 *
 * The key is only as good as its file list, so the list is deliberately wider
 * than what each extractor reads: every file under the repository with an
 * extension that extractor could open, tracked or not (the extractors walk the
 * disk, not git), pruning only the directories every extractor always prunes.
 * Wider costs a needless re-run; narrower would replay stale facts.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { createGunzip, createGzip, constants as zlib } from 'node:zlib';

import type { Language } from '../toolchain/languages.js';

/**
 * The directories all three extractors skip unconditionally — each one's
 * DEFAULT_EXCLUDES, including the Java extractor's OpenAPI walk, which ignores
 * `--exclude`. A directory only some of them skip is walked.
 */
const ALWAYS_PRUNED = new Set(['node_modules', 'target', 'build', 'dist', '.git', '.idea', '.gradle']);

/**
 * Files an extractor could read, by name. A superset of each one's discovery:
 * Java reads sources, build files, Spring config, persistence XML and OpenAPI
 * specs (YAML or JSON); TypeScript reads sources, templates and JSON manifests
 * and tsconfigs (including a tsconfig's relative `extends`, whatever it is
 * named) and Express/Koa routes; migrations read SQL, DDL and changelogs.
 */
const READS: Record<Language, RegExp> = {
  java: /\.(java|kt|kts|gradle|xml|properties|ya?ml|json)$/i,
  typescript: /\.([cm]?[jt]sx?|html|json)$/i,
  migrations: /\.(sql|ddl|xml|ya?ml|json)$/i,
};

/**
 * What the TypeScript compiler resolves imported types from, but is never
 * walked: the installed dependency tree. Package managers record each install
 * in a file inside `node_modules`; that file, and the directory's own mtime,
 * stand in for the tree. A tree changed without either changing is not
 * detected — stated in ADR-0046.
 */
const INSTALL_RECORDS = ['.package-lock.json', '.yarn-integrity', '.modules.yaml', '.yarn-state.yml'];

export interface Fingerprint {
  key: string;
  /** How many files went into the key. */
  files: number;
  /** Each input and its digest, kept so a later check can say what changed. */
  inputs: Record<string, InputRecord>;
}

/** An input's digest, with the size and mtime that let a later check skip re-hashing it. */
export interface InputRecord {
  digest: string;
  size?: number;
  mtimeMs?: number;
}

export function inputFingerprint(repoPath: string, language: Language, identity: string[]): Fingerprint {
  const inputs = scanInputs(repoPath, language, () => null);
  const hash = createHash('sha256');
  hash.update(`stratigraph-reuse/1\0${language}\0`);
  for (const part of identity) hash.update(`${part}\0`);
  let files = 0;
  for (const [label, record] of Object.entries(inputs)) {
    hash.update(`${label}\0${record.digest}\0`);
    if (label.startsWith('file:')) files += 1;
  }
  return { key: hash.digest('hex'), files, inputs };
}

/**
 * Every input `language`'s extractor could read, labelled `file:<path>` or
 * `installed:<node_modules path>`, in a fixed order (sorted at every level, so
 * nothing depends on readdir order). `known` may supply a previous record for
 * a file whose size and mtime are unchanged, to skip hashing it again.
 */
function scanInputs(
  repoPath: string,
  language: Language,
  known: (label: string, size: number, mtimeMs: number) => InputRecord | null,
): Record<string, InputRecord> {
  const inputs: Record<string, InputRecord> = {};
  const pattern = READS[language];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' && language === 'typescript') {
          inputs[`installed:${path}`] = { digest: digest(installedTree(absolute)) };
        }
        if (!ALWAYS_PRUNED.has(entry.name)) walk(absolute, path);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        const label = `file:${path}`;
        try {
          const stat = statSync(absolute);
          const previous = known(label, stat.size, stat.mtimeMs);
          inputs[label] = previous ?? {
            digest: digest(readFileSync(absolute)),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        } catch {
          inputs[label] = { digest: 'unreadable' };
        }
      }
    }
  };
  walk(repoPath, '');
  return inputs;
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface Drift {
  /** Repo-relative paths, sorted; `node_modules` paths mean an install changed. */
  changed: string[];
  added: string[];
  removed: string[];
}

/**
 * What differs between the inputs recorded for a stored stream and the disk
 * now. A file whose size and mtime match the record is taken as unchanged
 * without re-reading it — this answers "is the answer stale?", not "may these
 * facts be reused?", which always re-hashes.
 */
export function inputDrift(repoPath: string, language: Language, recorded: Record<string, InputRecord>): Drift {
  const now = scanInputs(repoPath, language, (label, size, mtimeMs) => {
    const before = recorded[label];
    return before !== undefined && before.size === size && before.mtimeMs === mtimeMs ? before : null;
  });
  const strip = (label: string) => label.slice(label.indexOf(':') + 1);
  const drift: Drift = { changed: [], added: [], removed: [] };
  for (const [label, record] of Object.entries(now)) {
    const before = recorded[label];
    if (before === undefined) drift.added.push(strip(label));
    else if (before.digest !== record.digest) drift.changed.push(strip(label));
  }
  for (const label of Object.keys(recorded)) {
    if (!(label in now)) drift.removed.push(strip(label));
  }
  return drift;
}

function installedTree(dir: string): string {
  const parts: string[] = [];
  try {
    parts.push(`mtime:${statSync(dir).mtimeMs}`);
  } catch {
    parts.push('absent');
  }
  for (const record of INSTALL_RECORDS) {
    try {
      parts.push(`${record}:${createHash('sha256').update(readFileSync(join(dir, record))).digest('hex')}`);
    } catch {
      parts.push(`${record}:none`);
    }
  }
  return parts.join('\n');
}

/**
 * One stored stream per extractor, beside the store it belongs to:
 * `<store>.facts/<language>.ndjson.gz` and its `<language>.key`. The names end
 * in nothing any extractor reads, so storing them cannot change a key.
 */
export class FactCache {
  private readonly dir: string;

  constructor(dbPath: string) {
    this.dir = join(dirname(dbPath), `${basename(dbPath)}.facts`);
  }

  /** The run whose stream matches `key`, or null. */
  lookup(language: Language, key: string): { runId: number; open: () => Readable } | null {
    const manifest = this.manifest(language);
    const stream = this.streamPath(language);
    if (manifest === null || manifest.key !== key || !existsSync(stream)) return null;
    return { runId: manifest.runId, open: () => createReadStream(stream).pipe(createGunzip()) };
  }

  /** Record that `runId` holds this stream's facts, replayed. */
  markUsed(language: Language, runId: number): void {
    const manifest = this.manifest(language);
    if (manifest !== null) this.writeManifest(language, { ...manifest, usedBy: runId });
  }

  /**
   * What the stored stream for `language` was read from, and the latest run
   * that holds it, or null when nothing is stored.
   */
  manifest(language: Language): StoredManifest | null {
    try {
      const parsed = JSON.parse(readFileSync(this.keyPath(language), 'utf8')) as Partial<StoredManifest>;
      return typeof parsed.key === 'string' && typeof parsed.runId === 'number'
        ? {
            key: parsed.key,
            runId: parsed.runId,
            usedBy: typeof parsed.usedBy === 'number' ? parsed.usedBy : parsed.runId,
            inputs: parsed.inputs ?? {},
          }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Start recording a stream. Nothing replaces the stored one until `commit`,
   * so an extractor that fails halfway leaves the previous good stream — and a
   * key that no longer matches it — rather than a truncated one.
   */
  record(language: Language, fingerprint: Fingerprint, runId: number): CacheRecording {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.streamPath(language)}.${process.pid}-${randomUUID()}.tmp`;
    const gzip = createGzip({ level: zlib.Z_BEST_SPEED });
    const out = createWriteStream(tmp);
    gzip.pipe(out);
    return {
      sink: gzip,
      commit: async () => {
        gzip.end();
        await finished(out);
        renameSync(tmp, this.streamPath(language));
        this.writeManifest(language, { key: fingerprint.key, runId, usedBy: runId, inputs: fingerprint.inputs });
      },
      abort: () => {
        // Errors from writes still in flight are expected here and mean nothing.
        gzip.on('error', () => undefined);
        out.on('error', () => undefined);
        gzip.unpipe(out);
        gzip.destroy();
        out.once('close', () => rmSync(tmp, { force: true }));
        out.destroy();
      },
    };
  }

  /** Drop a stored stream, e.g. one that could not be replayed. */
  forget(language: Language): void {
    rmSync(this.keyPath(language), { force: true });
    rmSync(this.streamPath(language), { force: true });
  }

  private writeManifest(language: Language, manifest: StoredManifest): void {
    const tmp = `${this.keyPath(language)}.${process.pid}-${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(manifest) + '\n');
    renameSync(tmp, this.keyPath(language));
  }

  private streamPath(language: Language): string {
    return join(this.dir, `${language}.ndjson.gz`);
  }

  private keyPath(language: Language): string {
    return join(this.dir, `${language}.key`);
  }
}

export interface StoredManifest {
  key: string;
  /** The run whose extractor printed the stream. */
  runId: number;
  /** The latest run whose facts for this extractor are this stream. */
  usedBy: number;
  inputs: Record<string, InputRecord>;
}

export interface CacheRecording {
  /** Everything the extractor prints goes here as well as to the writer. */
  sink: NodeJS.WritableStream;
  commit: () => Promise<void>;
  abort: () => void;
}

function finished(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.closed) return resolve();
    stream.on('close', resolve);
    stream.on('error', reject);
  });
}

/** A digest of every file under `dir` whose name matches, for an extractor's identity. */
export function hashTree(dir: string, pattern: RegExp): string {
  const hash = createHash('sha256');
  const walk = (at: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(join(at, entry.name), path);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        hash.update(`${path}\0`);
        hash.update(readFileSync(join(at, entry.name)));
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

/** A digest of one file's bytes, or a marker saying it could not be read. */
export function hashFile(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return `unreadable:${path}`;
  }
}

export interface RunDrift {
  /** Per extractor that has a record for this run. */
  drift: Array<{ language: Language } & Drift>;
  /** Extractors with no input record for this run: drift unknown. */
  unknown: Language[];
}

/**
 * What changed on disk since `runId`'s facts were read, per extractor. Only an
 * extractor whose stored stream is the one `runId` holds can be compared; a
 * store with a newer run, or one written before ADR-0046, says "unknown".
 */
export function runDrift(dbPath: string, repoPath: string, runId: number, languages: Language[]): RunDrift {
  const cache = new FactCache(dbPath);
  const result: RunDrift = { drift: [], unknown: [] };
  for (const language of languages) {
    const manifest = cache.manifest(language);
    if (manifest === null || manifest.usedBy !== runId) result.unknown.push(language);
    else result.drift.push({ language, ...inputDrift(repoPath, language, manifest.inputs) });
  }
  return result;
}
