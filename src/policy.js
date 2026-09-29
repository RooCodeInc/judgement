import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import picomatch from 'picomatch';

const matchesGlob = (path, pattern) =>
  picomatch.isMatch(path, pattern, { dot: true });

export const POLICY_PATH = '.judgement/rules.json';

export const isConfigurationPath = (path) =>
  path === POLICY_PATH || path.startsWith('.judgement/examples/');

export async function readPolicy(cwd) {
  let stat;
  try {
    stat = await lstat(join(cwd, POLICY_PATH));
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new ConfigurationError(`No ${POLICY_PATH} policy found.`);
    throw error;
  }
  if (!stat.isFile())
    throw new ConfigurationError(`${POLICY_PATH} must be a regular file.`);
  return parsePolicy(await readFile(join(cwd, POLICY_PATH), 'utf8'));
}

export class ConfigurationError extends Error {}
const keys = (value, allowed) =>
  Object.keys(value).every((key) => allowed.includes(key));
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const patterns = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (pattern) =>
      typeof pattern === 'string' &&
      pattern.length > 0 &&
      !pattern.startsWith('!') &&
      !pattern.startsWith('/') &&
      !pattern.includes('\\') &&
      !pattern.split('/').includes('..') &&
      !/^[A-Za-z]:/.test(pattern),
  );

export function parsePolicy(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConfigurationError('Judgement policy is not valid JSON.');
  }
  if (
    !object(value) ||
    !keys(value, ['criteria']) ||
    !Array.isArray(value.criteria) ||
    !value.criteria.length
  )
    throw new ConfigurationError(
      'Judgement policy must contain a non-empty criteria array.',
    );
  const ids = new Set();
  return {
    criteria: value.criteria.map((criterion, index) => {
      if (
        !object(criterion) ||
        !keys(criterion, ['id', 'rule', 'files', 'context', 'threshold']) ||
        typeof criterion.rule !== 'string' ||
        !criterion.rule.trim() ||
        (criterion.id !== undefined &&
          (typeof criterion.id !== 'string' || !criterion.id.trim())) ||
        (criterion.files !== undefined && !patterns(criterion.files)) ||
        (criterion.context !== undefined && !patterns(criterion.context)) ||
        (criterion.threshold !== undefined &&
          (!Number.isFinite(criterion.threshold) ||
            criterion.threshold < 0 ||
            criterion.threshold > 1))
      )
        throw new ConfigurationError(
          `Invalid criterion ${index + 1}. Expected rule, optional id, relative files/context globs, and threshold between 0 and 1.`,
        );
      const id = criterion.id ?? `criterion_${index + 1}`;
      if (ids.has(id))
        throw new ConfigurationError(`Duplicate criterion id: ${id}`);
      ids.add(id);
      return {
        ...criterion,
        id,
        rule: criterion.rule.trim(),
        threshold: criterion.threshold ?? 0.85,
      };
    }),
  };
}

export function matches(path, patterns) {
  if (!patterns) return true;
  return patterns.some((pattern) => {
    const glob = pattern.endsWith('/') ? `${pattern}**` : pattern;
    // Root-relative paths with familiar gitignore-style basename/directory matching.
    return (
      matchesGlob(path, glob) ||
      matchesGlob(path, `${glob}/**`) ||
      (!glob.includes('/') &&
        path.split('/').some((part) => matchesGlob(part, glob)))
    );
  });
}
