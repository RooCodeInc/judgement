import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { check } from '../src/index.js';
const exec = promisify(execFile);
const cwd = await mkdtemp(join(tmpdir(), 'judgement-bench-'));
const git = (...args) => exec('git', args, { cwd });
try {
  await git('init', '-q');
  await git('config', 'user.name', 'Benchmark');
  await git('config', 'user.email', 'benchmark@example.com');
  await mkdir(join(cwd, '.judgement'));
  await writeFile(
    join(cwd, '.judgement/rules.json'),
    JSON.stringify({ criteria: [{ rule: 'Use sentence case.' }] }),
  );
  await writeFile(join(cwd, 'file.js'), 'before\n');
  await git('add', '.');
  await git('commit', '-qm', 'initial');
  await writeFile(join(cwd, 'file.js'), 'after\n');
  await git('add', '.');
  const timings = [];
  for (let i = 0; i < 21; i++) {
    const report = await check({
      cwd,
      cacheIdentity: 'benchmark-fake:v1',
      evaluate: async () => ({ outcome: 'pass', confidence: 0.99 }),
    });
    if (i > 0) timings.push(report.elapsedMs);
  }
  timings.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      benchmark:
        'warm staged snapshot; cached fake-model answer; no API latency',
      runs: timings.length,
      p50ms: timings[10],
      p95ms: timings[18],
    }),
  );
  const startup = [];
  await git('commit', '-qm', 'changed');
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    await exec(
      process.execPath,
      [
        new URL('../src/cli.js', import.meta.url).pathname,
        'check',
        '--staged',
        '--hook',
      ],
      { cwd },
    );
    startup.push(Math.round(performance.now() - start));
  }
  startup.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      benchmark: 'CLI cold process; no changes; no API latency',
      runs: startup.length,
      p50ms: startup[5],
      p95ms: startup[9],
    }),
  );
} finally {
  await rm(cwd, { recursive: true, force: true });
}
