import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'fixtures', 'tiny-java');

/**
 * Install the package the way a user does — `npm pack`, then install the
 * tarball — and drive the installed `stratigraph` binary.
 *
 * Every other test runs the CLI as `node dist/cli.js` or through tsx, where
 * `process.argv[1]` is the module's real path. npm installs the bin as a
 * symlink, which is a different path, and 1.0.0 shipped a CLI that silently did
 * nothing through that symlink while every test stayed green. Exercising the
 * real install is the only thing that catches a whole class of packaging bugs:
 * a missing file in `files`, a bad bin path, a broken shebang.
 */
let installDir: string;
let bin: string;

/**
 * spawnSync rather than execFileSync: the latter returns only stdout on
 * success, so a command whose output goes to stderr looks like it printed
 * nothing. `out` is both streams; `stdout` is asserted separately where the
 * distinction matters.
 */
function run(
  args: string[],
  cwd = installDir,
): { status: number; out: string; stdout: string; stderr: string } {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status ?? 1, out: `${stdout}${stderr}`, stdout, stderr };
}

beforeAll(() => {
  const packDir = mkdtempSync(join(tmpdir(), 'stratigraph-pack-'));
  execFileSync('npm', ['pack', '--pack-destination', packDir], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tarball = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  expect(tarball, 'npm pack produced no tarball').toBeDefined();

  installDir = mkdtempSync(join(tmpdir(), 'stratigraph-install-'));
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', join(packDir, tarball as string)], {
    cwd: installDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  bin = join(installDir, 'node_modules', '.bin', 'stratigraph');
}, 300_000);

describe('the installed package', () => {
  it('installs a stratigraph binary', () => {
    expect(existsSync(bin)).toBe(true);
  });

  it('prints its version through the bin symlink', () => {
    const { status, out } = run(['--version']);
    expect(status).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints help rather than exiting silently', () => {
    const { status, out } = run(['--help']);
    expect(status).toBe(0);
    expect(out).toMatch(/stratigraph/);
    expect(out).toMatch(/init/);
  });

  it('runs doctor and reports on the toolchain', () => {
    const { status, stdout } = run(['doctor', '--repo', FIXTURE]);
    expect(status).toBe(0);
    // The report is the command's product, so it must be on stdout — otherwise
    // `stratigraph doctor > report.txt` captures an empty file.
    expect(stdout).toMatch(/stratigraph/);
    expect(stdout).toMatch(/node/);
    expect(stdout).toMatch(/java/);
  });

  it('creates a fact store with the full schema', () => {
    const { status, out } = run(['init', '--repo', FIXTURE]);
    expect(status).toBe(0);
    expect(out).toMatch(/schema\s+v\d+/);
    expect(existsSync(join(installDir, '.stratigraph', 'tiny-java.db'))).toBe(true);
  });

  it('exits non-zero on a bad repo path', () => {
    const { status, out } = run(['init', '--repo', join(installDir, 'nope')]);
    expect(status).toBe(2);
    expect(out).toMatch(/repository path does not exist/);
  });
});
