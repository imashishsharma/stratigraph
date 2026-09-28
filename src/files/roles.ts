/**
 * What each tracked file is — ADR-0030.
 *
 * Every assignment names the rule that made it, so a role is checkable the
 * same way an edge is. Rules run in a fixed order and the first match wins;
 * the order is the ADR's, and the reasons for it are there.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import type { Db } from '../db/database.js';

export type FileRole =
  | 'source'
  | 'test'
  | 'generated'
  | 'vendored'
  | 'lockfile'
  | 'manifest'
  | 'migration'
  | 'config'
  | 'docs'
  | 'asset'
  | 'other';

export interface FileAttributes {
  generated: boolean;
  vendored: boolean;
}

export interface RoleAssignment {
  role: FileRole;
  /** The citation: which rule assigned the role. */
  rule: string;
  /** The line carrying a header marker; null for every other rule. */
  line: number | null;
}

/** Enough of a file to hold a licence banner and a generator's marker. */
const HEADER_BYTES = 1024;

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'gradle.lockfile',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'go.sum',
]);

const MANIFESTS = new Set([
  'pnpm-workspace.yaml',
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.properties',
  'build.xml',
  'mvnw',
  'mvnw.cmd',
  'gradlew',
  'gradlew.bat',
  'angular.json',
  'project.json',
  'nx.json',
  'workspace.json',
  'lerna.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'Gemfile',
]);

/** Directory prefixes, matched at any depth, that hold build tooling. */
const MANIFEST_DIRS = ['.mvn/', 'gradle/wrapper/'];

const VENDORED_DIRS = ['vendor/', 'third_party/', 'third-party/', 'bower_components/'];
const GENERATED_DIRS = ['generated/', 'generated-sources/', 'generated-test-sources/'];
const MIGRATION_DIRS = ['db/changelog/', 'db/migration/', 'db/migrations/', 'liquibase/', 'flyway/'];
const TEST_DIRS = [
  'src/test/',
  'src/testFixtures/',
  'src/integrationTest/',
  'src/it/',
  '__tests__/',
  'test/',
  'tests/',
  'e2e/',
  'cypress/',
];

const TEST_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/\.spec\.[cm]?[jt]sx?$/, 'name:*.spec.*'],
  [/\.test\.[cm]?[jt]sx?$/, 'name:*.test.*'],
  [/Tests?\.(java|kt)$/, 'name:*Test.java'],
  [/IT\.(java|kt)$/, 'name:*IT.java'],
];

const SOURCE_EXTENSIONS = new Set([
  '.java', '.kt', '.scala', '.groovy', '.clj',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.html', '.htm', '.jsp', '.ftl', '.vm', '.mustache', '.hbs',
  '.css', '.scss', '.sass', '.less',
  '.sql', '.py', '.go', '.rb', '.cs', '.php', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.swift', '.m', '.dart', '.sh', '.bash', '.ps1',
  // Interface definitions and JSP tag files are hand-written program text.
  '.proto', '.graphql', '.graphqls', '.gql', '.tag', '.tagx',
]);

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.adoc', '.asciidoc', '.rst', '.txt']);
const DOC_NAMES = new Set([
  'LICENSE', 'LICENCE', 'NOTICE', 'CHANGELOG', 'AUTHORS', 'CONTRIBUTORS', 'COPYING',
  'COPYRIGHT', 'NEWS', 'CHANGES', 'HISTORY',
]);

/** A SQL file whose first kilobyte creates or alters a table is DDL. */
const DDL_HEAD = /\b(?:CREATE|ALTER)\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMPORARY|TEMP|CACHED|MEMORY)\s+)?TABLE\b/i;

/** Formats a Liquibase changelog can be written in. */
const CHANGELOG_EXTENSIONS = new Set(['.xml', '.yaml', '.yml', '.json']);

const CONFIG_EXTENSIONS = new Set([
  '.json', '.json5', '.yml', '.yaml', '.xml', '.properties', '.toml', '.ini', '.conf',
  '.cfg', '.env', '.xsd', '.wsdl', '.config',
]);
const CONFIG_NAMES = new Set([
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.browserslistrc',
  '.dockerignore', '.prettierrc', '.eslintrc', 'Dockerfile', 'Jenkinsfile', 'Makefile',
  'Procfile', 'docker-compose.yml', 'docker-compose.yaml',
]);

const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.tif', '.tiff',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.mp3', '.mp4', '.wav', '.webm', '.mov',
  '.jar', '.war', '.zip', '.gz', '.tgz', '.7z', '.class', '.so', '.dll', '.exe',
]);

/**
 * Generated-code markers, in the order they are reported when one line
 * carries several. Word boundaries keep `@GeneratedValue` — a JPA id strategy
 * on hand-written entities — from matching `@Generated`.
 */
const HEADER_MARKERS: ReadonlyArray<[RegExp, string]> = [
  [/DO NOT EDIT/, 'DO NOT EDIT'],
  [/@generated\b/, '@generated'],
  [/@Generated\b/, '@Generated'],
  [/\bauto-?generated\b/i, 'auto-generated'],
  [/\bCode generated\b/, 'Code generated'],
];

/**
 * Classify one repo-relative path.
 *
 * `readHead` is called only for source candidates, and only once; a lockfile
 * or an image is decided by its name without being opened.
 */
export function classifyPath(
  path: string,
  attrs: FileAttributes,
  readHead: () => string | null,
): RoleAssignment {
  const role = (r: FileRole, rule: string): RoleAssignment => ({ role: r, rule, line: null });
  // Read at most once, however many rules ask.
  let head: string | null | undefined;
  const readOnce = () => (head === undefined ? (head = readHead()) : head);

  if (attrs.generated) return role('generated', 'gitattributes:linguist-generated');
  if (attrs.vendored) return role('vendored', 'gitattributes:linguist-vendored');

  const name = basename(path);
  const dir = `/${path.slice(0, path.length - name.length)}`;
  const ext = extension(name);

  if (LOCKFILES.has(name)) return role('lockfile', `name:${name}`);

  const vendoredDir = underDir(dir, VENDORED_DIRS);
  if (vendoredDir !== null) return role('vendored', `path:${vendoredDir}`);
  if (/\.min\.(js|css)$/.test(name)) return role('vendored', 'name:*.min.*');
  const generatedDir = underDir(dir, GENERATED_DIRS);
  if (generatedDir !== null) return role('generated', `path:${generatedDir}`);

  if (MANIFESTS.has(name)) return role('manifest', `name:${name}`);
  if (/^tsconfig.*\.json$/.test(name)) return role('manifest', 'name:tsconfig*.json');
  const manifestDir = underDir(dir, MANIFEST_DIRS);
  if (manifestDir !== null) return role('manifest', `path:${manifestDir}`);

  const migrationDir = underDir(dir, MIGRATION_DIRS);
  if (migrationDir !== null) return role('migration', `path:${migrationDir}`);
  // Standalone DDL defines the schema as a migration does (ADR-0037).
  if (/^(?:[\w.-]*schema[\w.-]*\.sql|ddl(?:[-_.][\w.-]*)?\.sql|[\w.-]+\.ddl)$/i.test(name) && underDir(dir, TEST_DIRS) === null) {
    return role('migration', 'name:schema*.sql');
  }

  // Under a main source root, a directory named `test` or `tests` is a
  // package, not a test root: `src/main/java/…/gateway/tests/grpc/` is main code.
  const mainRoot = dir.indexOf('/src/main/');
  const testDir = underDir(mainRoot < 0 ? dir : dir.slice(0, mainRoot + 1), TEST_DIRS);
  if (testDir !== null) return role('test', `path:${testDir}`);
  for (const [pattern, rule] of TEST_NAMES) {
    if (pattern.test(name)) return role('test', rule);
  }

  // Migrations recognised by what they are, wherever they sit: a Flyway
  // versioned script by its name, DDL and Liquibase changelogs by their first
  // kilobyte (ADR-0037).
  if (/^V\d+(?:[._]\d+)*__.+\.sql$/.test(name)) return role('migration', 'name:V*__*.sql');
  if (ext === '.sql' && DDL_HEAD.test(readOnce() ?? '')) return role('migration', 'header:DDL');
  if (CHANGELOG_EXTENSIONS.has(ext) && (readOnce() ?? '').includes('databaseChangeLog')) {
    return role('migration', 'header:databaseChangeLog');
  }

  if (SOURCE_EXTENSIONS.has(ext)) {
    const marker = findMarker(readOnce());
    if (marker !== null) return { role: 'generated', rule: `header:${marker.label}`, line: marker.line };
    return role('source', `ext:${ext}`);
  }

  const stem = name.replace(/\.[^.]*$/, '');
  if (DOC_NAMES.has(stem.toUpperCase())) return role('docs', `name:${stem}`);
  if (DOC_EXTENSIONS.has(ext)) return role('docs', `ext:${ext}`);
  if (CONFIG_NAMES.has(name)) return role('config', `name:${name}`);
  if (CONFIG_EXTENSIONS.has(ext)) return role('config', `ext:${ext}`);
  // ADR-0030: dotfiles are configuration, and so is what a jar reads from
  // META-INF (service registrations, spring.factories, AutoConfiguration.imports).
  if (name.startsWith('.')) return role('config', 'name:.*');
  if (dir.includes('/META-INF/')) return role('config', 'path:META-INF/');
  if (ASSET_EXTENSIONS.has(ext)) return role('asset', `ext:${ext}`);
  return role('other', 'none');
}

/**
 * Parse `git check-attr -z` output: `path NUL attribute NUL value NUL` triples.
 *
 * git reports `set` for a bare attribute and `true` for `attr=true`; both mean
 * the repository has said so.
 */
export function parseCheckAttr(out: string): Map<string, FileAttributes> {
  const fields = out.split('\0');
  const result = new Map<string, FileAttributes>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i] as string;
    const attr = fields[i + 1];
    const value = fields[i + 2];
    const entry = result.get(path) ?? { generated: false, vendored: false };
    const on = value === 'set' || value === 'true';
    if (attr === 'linguist-generated') entry.generated = on;
    else if (attr === 'linguist-vendored') entry.vendored = on;
    result.set(path, entry);
  }
  return result;
}

/** Ask git for `linguist-*` attributes, so its own pattern semantics apply. */
export function gitAttributes(repoPath: string, paths: readonly string[]): Map<string, FileAttributes> {
  if (paths.length === 0) return new Map();
  try {
    const out = execFileSync(
      'git',
      ['-C', repoPath, 'check-attr', '-z', '--stdin', 'linguist-generated', 'linguist-vendored'],
      {
        input: paths.join('\0') + '\0',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    return parseCheckAttr(out);
  } catch {
    // Not a git repository, or no git: no attributes were stated, which is
    // exactly what an empty map says.
    return new Map();
  }
}

export type AttributeSource = (repoPath: string, paths: readonly string[]) => Map<string, FileAttributes>;

/**
 * Classify every tracked file into `file_role`, replacing any earlier rows for
 * the run. Returns the count per role, omitting roles with none.
 */
export function assignFileRoles(
  db: Db,
  runId: number,
  repoPath: string,
  trackedFiles: readonly string[],
  attributes: AttributeSource = gitAttributes,
): Partial<Record<FileRole, number>> {
  const attrs = attributes(repoPath, trackedFiles);
  const counts: Partial<Record<FileRole, number>> = {};
  const none: FileAttributes = { generated: false, vendored: false };

  const insert = db.prepare(
    'INSERT INTO file_role (run_id, path, role, rule, line) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    db.prepare('DELETE FROM file_role WHERE run_id = ?').run(runId);
    for (const path of trackedFiles) {
      const got = classifyPath(path, attrs.get(path) ?? none, () =>
        readHeader(join(repoPath, path)),
      );
      insert.run(runId, path, got.role, got.rule, got.line);
      counts[got.role] = (counts[got.role] ?? 0) + 1;
    }
  })();
  return counts;
}

function readHeader(absolutePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(absolutePath, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function findMarker(head: string | null): { label: string; line: number } | null {
  if (head === null) return null;
  const lines = head.split('\n');
  for (const [index, text] of lines.entries()) {
    for (const [pattern, label] of HEADER_MARKERS) {
      if (pattern.test(text)) return { label, line: index + 1 };
    }
  }
  return null;
}

/** The first of `dirs` that appears as a whole-segment run in `dir` (which starts and ends with `/`). */
function underDir(dir: string, dirs: readonly string[]): string | null {
  for (const candidate of dirs) {
    if (dir.includes(`/${candidate}`)) return candidate;
  }
  return null;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}
