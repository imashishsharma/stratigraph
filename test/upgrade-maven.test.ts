import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMaven } from '../src/upgrade/maven.js';

describe.skipIf(process.platform === 'win32')('createMaven', () => {
  it('runs a wrapper committed without its executable bit through sh (unseen-corpus repos)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'stratigraph-mvnw-'));
    mkdirSync(join(repo, '.mvn', 'wrapper'), { recursive: true });
    writeFileSync(join(repo, 'mvnw'), '#!/bin/sh\necho "[INFO] BUILD SUCCESS"\necho "args: $*"\n');
    chmodSync(join(repo, 'mvnw'), 0o644);
    const logDir = mkdtempSync(join(tmpdir(), 'stratigraph-mvnw-log-'));
    const maven = createMaven({ repoPath: repo, javaHome: '/nonexistent-jdk', logDir, extraArgs: ['-Dx=1'], timeoutMs: 30000 });
    const result = await maven(['verify'], 'probe');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.logPath, 'utf8')).toContain('args: -B -e verify -Dx=1');
  });
});
