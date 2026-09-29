import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { git } from './git.js';

const HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** Install wrappers in Git metadata, preserving the original hooks at their original paths. */
export async function installGitHook({ cwd, command, signal }) {
  if (
    !command?.length ||
    command.some(
      (part) =>
        typeof part !== 'string' || part.includes('\0') || part.includes('\n'),
    )
  )
    throw new Error('Invalid hook command.');
  const root = resolve(cwd);
  const worktree = await git(
    root,
    ['config', '--bool', 'extensions.worktreeConfig'],
    signal,
  ).catch(() => 'false');
  const scope = worktree === 'true' ? '--worktree' : '--local';
  const gitDir = await git(
    root,
    [
      'rev-parse',
      worktree === 'true' ? '--absolute-git-dir' : '--git-common-dir',
    ],
    signal,
  );
  const wrapperDir = resolve(root, gitDir, 'judgement-hooks');
  const metadataPath = join(wrapperDir, 'original.json');
  const configured = await git(
    root,
    ['config', '--get', 'core.hooksPath'],
    signal,
  ).catch(() => null);
  let previous;
  if (configured && resolve(root, configured) === wrapperDir) {
    previous = JSON.parse(await readFile(metadataPath, 'utf8'));
  } else {
    previous = {
      configured,
      path:
        configured ??
        resolve(
          root,
          await git(root, ['rev-parse', '--git-path', 'hooks'], signal),
        ),
    };
  }
  if (
    typeof previous.path !== 'string' ||
    resolve(root, previous.path) === wrapperDir
  )
    throw new Error('Cannot chain recursive Git hooks.');
  await mkdir(wrapperDir, { recursive: true, mode: 0o700 });
  await writeFile(metadataPath, JSON.stringify(previous), { mode: 0o600 });
  for (const hook of HOOKS) {
    const original = isAbsolute(previous.path)
      ? quote(join(previous.path, hook))
      : `"$(git rev-parse --show-toplevel)"/${quote(join(previous.path, hook))}`;
    const invoke =
      hook === 'pre-commit'
        ? `if [ -x "$original" ]; then\n  "$original" "$@" || exit $?\nfi\nexec ${command.map(quote).join(' ')}\n`
        : `if [ -x "$original" ]; then exec "$original" "$@"; fi\nexit 0\n`;
    await writeFile(
      join(wrapperDir, hook),
      `#!/bin/sh\n# Managed by Judgement. Original hooks remain untouched.\noriginal=${original}\n${invoke}`,
      { mode: 0o755 },
    );
  }
  await git(root, ['config', scope, 'core.hooksPath', wrapperDir], signal);
  return { directory: wrapperDir, previousHooksPath: previous.configured };
}
