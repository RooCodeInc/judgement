import { writeFile } from 'node:fs/promises';
import { snapshot, inventory, streamGit, git, policyBlob } from './git.js';
import {
  parsePolicy,
  readPolicy,
  ConfigurationError,
  matches,
} from './policy.js';
import { examplesFrom, safePath } from './calibrate.js';

/** Capture index/commit objects, never unstaged working-tree content. No inference. */
export async function captureExample(options = {}) {
  const { ruleId, path, name, expected } = options;
  if (
    !ruleId ||
    !safePath(path) ||
    !name?.trim() ||
    !['pass', 'violation'].includes(expected)
  )
    throw new ConfigurationError(
      'Capture requires --rule, a safe --path, --name, and --expected pass|violation.',
    );
  const snap = await snapshot(options, options.signal);
  const text = await policyBlob(snap, snap.base, options.signal);
  const policy =
    text === null ? await readPolicy(snap.root) : parsePolicy(text);
  const rule = policy.criteria.find((item) => item.id === ruleId);
  if (!rule)
    throw new ConfigurationError(
      'The selected rule does not exist in the base policy.',
    );
  const change = snap.changes.find((item) => item.path === path);
  if (!change)
    throw new ConfigurationError(
      'The selected path has no change in this snapshot.',
    );
  let remaining = 256_000;
  const read = async (path, oid, mode) => {
    if (mode === '000000') return null;
    if (!['100644', '100755'].includes(mode))
      throw new ConfigurationError('Capture supports regular text files only.');
    const size = Number(
      await git(snap.root, ['cat-file', '-s', oid], options.signal, snap.env),
    );
    if (!Number.isFinite(size) || size > remaining)
      throw new ConfigurationError(
        'Capture exceeds 256 KB. Reduce the example before saving it.',
      );
    remaining -= size;
    const chunks = [];
    for await (const chunk of streamGit(
      snap.root,
      ['cat-file', 'blob', oid],
      options.signal,
      snap.env,
    ))
      chunks.push(chunk);
    const content = Buffer.concat(chunks);
    if (content.includes(0))
      throw new ConfigurationError('Capture does not support binary files.');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        content,
      );
    } catch {
      throw new ConfigurationError('Capture supports UTF-8 text only.');
    }
  };
  const before = await read(path, change.oldOid, change.oldMode);
  const after = await read(path, change.oid, change.mode);
  const files = await inventory(snap, options.signal);
  const contexts = new Set(options.context ?? []);
  for (const pattern of rule.context ?? []) {
    const found = [...files.keys()].filter((file) => matches(file, [pattern]));
    if (!found.length)
      throw new ConfigurationError(`Required context has no match: ${pattern}`);
    for (const file of found) contexts.add(file);
  }
  const context = {};
  for (const file of contexts) {
    if (file === path) continue;
    if (!safePath(file) || !files.has(file))
      throw new ConfigurationError(
        'Context must name an existing safe repository path.',
      );
    if (snap.changes.some((item) => item.path === file))
      throw new ConfigurationError(
        'Supporting context changed too. Reduce this to a single-file example with unchanged context.',
      );
    const entry = files.get(file);
    context[file] = await read(file, entry.oid, entry.mode);
  }
  const fixture = {
    ruleId,
    examples: [
      {
        name,
        path,
        before,
        after,
        expected,
        ...(contexts.size ? { context } : {}),
      },
    ],
  };
  examplesFrom(fixture, rule);
  return fixture;
}

/** Save only to a new file; callers preview/redact first. Never stage or overwrite. */
export async function saveCapturedExample(fixture, output) {
  await writeFile(output, JSON.stringify(fixture, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
