export type Outcome =
  | 'pass'
  | 'violation'
  | 'unclear'
  | 'not_applicable'
  | 'local'
  | 'global';
export type Answer = { outcome: Outcome; confidence: number };
export type Evidence = {
  path: string;
  kind: 'patch' | 'before' | 'after' | 'context';
  line: number;
  text: string;
  oid?: string;
};
export type JudgeRequest =
  | { kind: 'strategy'; rule: string }
  | {
      kind: 'judge';
      rule: string;
      evidence: Evidence[];
      focusPaths: string[];
      complete: boolean;
      unresolved: string[];
    };
export type Criterion = {
  id: string;
  rule: string;
  files?: string[];
  context?: string[];
  threshold: number;
};
export type RuleResult = {
  id: string;
  rule: string;
  status: 'pass' | 'violation' | 'not_applicable' | 'incomplete';
  findings: {
    paths: string[];
    confidence: number;
    sources: Pick<Evidence, 'path' | 'kind' | 'line'>[];
  }[];
  unresolved: string[];
};
export type Report = {
  status: 'pass' | 'violation' | 'incomplete' | 'invalid';
  rules: RuleResult[];
  coverage: {
    files: number;
    packets: number;
    judged: number;
    cached: number;
    unsupported: string[];
  };
  messages: string[];
  elapsedMs: number;
  snapshot?: { base: string; tree: string };
  policySource?: 'base' | 'proposed' | 'absent';
};
export type Evaluator = (
  request: JudgeRequest,
  signal: AbortSignal,
) => Promise<Answer>;
export type BackendOptions = {
  apiKey?: string;
  endpoint?: string;
  model?: string;
};
export type CheckOptions = BackendOptions & {
  cwd?: string;
  base?: string;
  head?: string;
  hook?: boolean;
  deadlineMs?: number;
  signal?: AbortSignal;
  concurrency?: number;
  dryRun?: boolean;
  cache?: boolean;
  cacheIdentity?: string;
  evaluate?: Evaluator;
  env?: Record<string, string | undefined>;
  onProgress?: (event: { id: string; status: RuleResult['status'] }) => void;
};
export function check(options?: CheckOptions): Promise<Report>;
export function exitCode(
  report: Report,
  options?: { hook?: boolean; advisory?: boolean },
): number;
export function formatReport(report: Report): string;
export function createJevEvaluator(options?: BackendOptions): Evaluator;
export function question(request: JudgeRequest): {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};
export function validateAnswer(answer: unknown, request: JudgeRequest): Answer;
export function parsePolicy(text: string): { criteria: Criterion[] };
export function matches(path: string, patterns?: string[]): boolean;
export class ConfigurationError extends Error {}
export const MODEL: string;
export const MAX_REQUEST_BYTES: number;
export const MAX_EVIDENCE_BYTES: number;
export const PROTOCOL_VERSION: number;
export function installGitHook(options: {
  cwd: string;
  command: string[];
  signal?: AbortSignal;
}): Promise<{ directory: string; previousHooksPath: string | null }>;
