import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installGitHook } from '../src/index.js';
const exec = promisify(execFile);

test('chains custom hooks before Judgement, preserves other hooks, and reinstalls without recursion', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'judgement-hooks-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => exec('git', args, { cwd });
  await git('init', '-q');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await mkdir(join(cwd, '.hooks'));
  await writeFile(
    join(cwd, '.hooks', 'pre-commit'),
    '#!/bin/sh\necho original >> order\nprintf formatted > file\ngit add file\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(cwd, '.hooks', 'commit-msg'),
    '#!/bin/sh\necho message >> order\n',
    { mode: 0o755 },
  );
  await git('config', 'core.hooksPath', '.hooks');
  const check = join(cwd, 'checker.mjs');
  await writeFile(
    check,
    'import { appendFileSync } from "node:fs"; import { execFileSync } from "node:child_process"; if (execFileSync("git", ["show", ":file"], {encoding:"utf8"}) !== "formatted") process.exit(1); appendFileSync("order", "judge\\n");',
  );
  await installGitHook({ cwd, command: [process.execPath, check] });
  await installGitHook({ cwd, command: [process.execPath, check] });
  await writeFile(join(cwd, 'file'), 'unformatted');
  await git('add', 'file');
  await git('commit', '-qm', 'commit');
  assert.equal(
    await readFile(join(cwd, 'order'), 'utf8'),
    'original\njudge\nmessage\n',
  );
  assert.match(
    await readFile(join(cwd, '.hooks', 'pre-commit'), 'utf8'),
    /echo original/,
  );
});

test('the real pre-commit wrapper blocks a nonzero checker and preserves HEAD', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'judgement-block-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => exec('git', args, { cwd });
  await git('init', '-q');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await installGitHook({
    cwd,
    command: [process.execPath, '-e', 'process.exit(1)'],
  });
  await writeFile(join(cwd, 'file'), 'test');
  await git('add', 'file');
  await assert.rejects(git('commit', '-qm', 'blocked'));
  await assert.rejects(git('rev-parse', '--verify', 'HEAD'));
});
