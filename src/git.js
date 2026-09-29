import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Preserve Git's temporary index/worktree context, but not API keys or other task secrets.
export function gitEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        value !== undefined &&
        ([
          'PATH',
          'HOME',
          'USERPROFILE',
          'SystemRoot',
          'TMPDIR',
          'TMP',
          'TEMP',
          'LANG',
          'LC_ALL',
        ].includes(key) ||
          [
            'GIT_INDEX_FILE',
            'GIT_DIR',
            'GIT_WORK_TREE',
            'GIT_COMMON_DIR',
            'GIT_OBJECT_DIRECTORY',
            'GIT_ALTERNATE_OBJECT_DIRECTORIES',
            'GIT_PREFIX',
          ].includes(key)),
    ),
  );
}

export async function* streamGit(root, args, signal, env) {
  signal?.throwIfAborted();
  const child = spawn(
    'git',
    [
      '--no-pager',
      '--literal-pathspecs',
      '-c',
      'core.quotePath=false',
      ...args,
    ],
    {
      cwd: root,
      env: gitEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    },
  );
  // Observe rejection immediately: an abort may arrive while the consumer awaits the model.
  const completion = new Promise((resolve) => {
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  child.stderr.resume();
  try {
    for await (const bytes of child.stdout) {
      signal?.throwIfAborted();
      yield bytes;
    }
    if (!(await completion))
      throw new Error('Unable to read the Git snapshot.');
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

export async function git(root, args, signal, env) {
  const chunks = [];
  for await (const chunk of streamGit(root, args, signal, env))
    chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trimEnd();
}

export async function head(root, signal, env) {
  // --quiet differentiates an unborn HEAD from a missing requested base.
  try {
    return await git(
      root,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      signal,
      env,
    );
  } catch (error) {
    signal?.throwIfAborted();
    const branch = await git(root, ['symbolic-ref', 'HEAD'], signal, env);
    const refs = await git(
      root,
      ['show-ref', '--verify', branch],
      signal,
      env,
    ).catch(() => '');
    if (refs) throw error;
    return null;
  }
}

export async function snapshot(options, signal) {
  const root = resolve(options.cwd ?? process.cwd());
  const originalHead = await head(root, signal, options.env);
  let base, tree;
  if (options.base !== undefined) {
    base = await git(
      root,
      ['rev-parse', '--verify', `${options.base}^{commit}`],
      signal,
      options.env,
    );
    tree = await git(
      root,
      ['rev-parse', '--verify', `${options.head ?? 'HEAD'}^{tree}`],
      signal,
      options.env,
    );
  } else {
    base = originalHead;
    tree = await git(root, ['write-tree'], signal, options.env);
  }
  // An empty tree is a Git object, independent of the repository's hash algorithm.
  if (!base) {
    // mktree accepts an empty stdin; streamGit supplies /dev/null.
    base = await git(root, ['mktree'], signal, options.env);
  }
  const raw = await git(
    root,
    [
      'diff-tree',
      '--no-commit-id',
      '--raw',
      '-r',
      '-z',
      '--no-renames',
      base,
      tree,
    ],
    signal,
    options.env,
  );
  const records = raw.split('\0');
  const changes = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const parts = records[i].split(' ');
    if (parts.length !== 5 || !records[i + 1])
      throw new Error('Malformed Git change inventory.');
    changes.push({
      path: records[i + 1],
      oldMode: parts[0].slice(1),
      mode: parts[1],
      oldOid: parts[2],
      oid: parts[3],
      status: parts[4],
    });
  }
  return { root, base, tree, originalHead, changes, env: options.env };
}

export async function inventory(snap, signal) {
  const raw = await git(
    snap.root,
    ['ls-tree', '-r', '-z', snap.tree],
    signal,
    snap.env,
  );
  return new Map(
    raw
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const tab = record.indexOf('\t');
        const [mode, type, oid] = record.slice(0, tab).split(' ');
        return [record.slice(tab + 1), { mode, type, oid }];
      }),
  );
}

export async function policyBlob(snap, tree, signal) {
  const record = await git(
    snap.root,
    ['ls-tree', tree, '--', 'JUDGE.json'],
    signal,
    snap.env,
  );
  if (!record) return null;
  const [mode, type, oid] = record.split(/[ \t]/);
  if (!['100644', '100755'].includes(mode) || type !== 'blob')
    throw new Error('JUDGE.json must be a regular file.');
  return git(snap.root, ['cat-file', 'blob', oid], signal, snap.env);
}

// Every byte is visited. Oversized content is split, never replaced with first/last excerpts.
export async function* textChunks(snap, args, signal, maxBytes = 12_000) {
  let pending = Buffer.alloc(0),
    line = 1;
  for await (const chunk of streamGit(snap.root, args, signal, snap.env)) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length > maxBytes) {
      let end = pending.lastIndexOf(10, maxBytes);
      if (end < maxBytes / 2) {
        end = maxBytes;
        while (end > 0 && (pending[end] & 0xc0) === 0x80) end--;
      } else end++;
      const bytes = pending.subarray(0, end);
      const text = bytes.toString('utf8');
      yield { text, line, binary: bytes.includes(0) };
      line += text.split('\n').length - 1;
      pending = pending.subarray(end);
    }
  }
  if (pending.length)
    yield { text: pending.toString('utf8'), line, binary: pending.includes(0) };
}

export async function blobParts(snap, path, oid, kind, signal) {
  const result = [];
  for await (const chunk of textChunks(
    snap,
    ['cat-file', 'blob', oid],
    signal,
  )) {
    if (chunk.binary) return null;
    result.push({ path, oid, kind, line: chunk.line, text: chunk.text });
  }
  return result;
}
