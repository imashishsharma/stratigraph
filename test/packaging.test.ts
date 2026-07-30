import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
 * Windows has no extensionless executables. Both `npm` and the installed
 * `stratigraph` are `.cmd` shims there, and since the fix for CVE-2024-27980
 * (Node 18.20.2, 20.12.2) Node refuses to run a `.cmd` at all without a shell —
 * which is why this suite was the one thing failing on every Windows runner.
 *
 * So on Windows we go through the shell and quote the arguments ourselves,
 * because `shell: true` hands the argv to cmd.exe as one string. On POSIX we
 * exec directly, which is what exercises the bin *symlink* this suite exists
 * for.
 */
const WINDOWS = process.platform === 'win32';
const NPM = WINDOWS ? 'npm.cmd' : 'npm';

function quoted(args: string[]): string[] {
  return WINDOWS ? args.map((arg) => `"${arg}"`) : args;
}

function npm(args: string[], cwd: string): void {
  execFileSync(NPM, quoted(args), {
    cwd,
    shell: WINDOWS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

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
  const result = spawnSync(WINDOWS ? `"${bin}"` : bin, quoted(args), {
    cwd,
    encoding: 'utf8',
    shell: WINDOWS,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status ?? 1, out: `${stdout}${stderr}`, stdout, stderr };
}

beforeAll(() => {
  const packDir = mkdtempSync(join(tmpdir(), 'stratigraph-pack-'));
  npm(['pack', '--pack-destination', packDir], REPO_ROOT);
  const tarball = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  expect(tarball, 'npm pack produced no tarball').toBeDefined();

  installDir = mkdtempSync(join(tmpdir(), 'stratigraph-install-'));
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  npm(['install', '--no-audit', '--no-fund', join(packDir, tarball as string)], installDir);

  // npm writes three shims on Windows — an extensionless sh script for Git
  // Bash, plus `.cmd` and `.ps1`. Only the `.cmd` is what a Windows shell
  // actually runs, so that is the one worth driving.
  bin = join(installDir, 'node_modules', '.bin', WINDOWS ? 'stratigraph.cmd' : 'stratigraph');
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

  /**
   * The MCP server is the one command whose product is a protocol rather than
   * text, so "it starts" proves nothing. This drives a real `initialize` and
   * `tools/list` over the installed binary's stdio, which is exactly what an
   * MCP client does — and it is the only test that would catch the SDK being
   * missing from the published tarball's dependencies.
   */
  it('serves MCP over stdio from the installed binary', async () => {
    const facts = join(installDir, 'facts.ndjson');
    writeFileSync(
      facts,
      [
        JSON.stringify({ v: 1, type: 'meta', extractor: 'test', extractorVersion: '0.0.0' }),
        JSON.stringify({ v: 1, type: 'node', kind: 'package', fqn: 'shop.web', name: 'shop.web' }),
      ].join('\n'),
    );
    expect(run(['ingest', '--repo', FIXTURE, '--from', facts]).status).toBe(0);

    const child = spawn(WINDOWS ? `"${bin}"` : bin, quoted(['mcp', '--repo', FIXTURE]), {
      cwd: installDir,
      shell: WINDOWS,
    });

    try {
      const initialize = await request(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'packaging-test', version: '0.0.0' },
        },
      });
      expect(initialize.result?.serverInfo?.name).toBe('stratigraph');

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const tools = await request(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(tools.result?.tools?.map((tool) => tool.name)).toContain('describe_run');
    } finally {
      child.stdin.end();
      child.kill();
    }
  }, 60_000);
});

interface RpcResponse {
  id?: number;
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
  };
}

/** One newline-delimited JSON-RPC round trip, which is all stdio transport is. */
function request(
  child: ReturnType<typeof spawn>,
  message: { id?: number; [key: string]: unknown },
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      for (const line of buffered.split('\n').slice(0, -1)) {
        if (line.trim() === '') continue;
        const parsed = JSON.parse(line) as RpcResponse;
        if (parsed.id === message.id) {
          child.stdout?.off('data', onData);
          clearTimeout(timer);
          resolve(parsed);
          return;
        }
      }
      buffered = buffered.slice(buffered.lastIndexOf('\n') + 1);
    };

    const timer = setTimeout(() => {
      child.stdout?.off('data', onData);
      reject(new Error(`no response to ${String(message['method'])} within 20s`));
    }, 20_000);

    child.stdout?.on('data', onData);
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  });
}
