export type Outcome = 'pass' | 'violation' | 'unclear' | 'not_applicable';
export type Answer =
  | { violationProbability: number }
  | { outcome: Outcome; confidence: number };
export type Evidence = {
  path: string;
  kind: 'patch' | 'before' | 'after' | 'context';
  line: number;
  text: string;
  oid?: string;
};
export type JudgeRequest = {
  kind: 'judge';
  rule: string;
  evidence: Evidence[];
  focusPaths: string[];
  /** All diff hunks are present; this does not imply whole-file context. */
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
  threshold?: number;
  status: 'pass' | 'violation' | 'not_applicable' | 'incomplete';
  findings: {
    changes?: {
      path: string;
      side: 'before' | 'after';
      line: number | null;
      text: string;
      truncated: boolean;
    }[];
    omitted?: number;
    paths: string[];
    confidence: number;
    violationProbability?: number;
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
  onDiagnostic?: (message: string) => void;
  onStatus?: (event: CheckProgress) => void;
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
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
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

export type CalibrationExample = {
  name: string;
  /** Relative changed-file path, defaults to example.md. */
  path?: string;
  before: string | null;
  after: string | null;
  expected: 'pass' | 'violation';
  /** Unchanged supporting files in both snapshots. */
  context?: Record<string, string>;
};
export type CalibrationExamples = {
  ruleId: string;
  examples: CalibrationExample[];
};
export type CalibrationOptions = BackendOptions & {
  cwd?: string;
  ruleId: string;
  examplesPath?: string;
  repeats?: number;
  thresholds?: number[];
  concurrency?: number;
  /** Per-check deadline, defaults to the hook's 3000 ms. */
  deadlineMs?: number;
  signal?: AbortSignal;
  dryRun?: boolean;
  evaluate?: Evaluator;
  onDiagnostic?: (message: string) => void;
};
export type CalibrationRun = {
  example: string;
  expected: 'pass' | 'violation';
  threshold: number;
  repetition: number;
  status: Report['status'];
  elapsedMs: number;
  judgments: number;
  answers: (Answer & { complete: boolean })[];
  operationalFailure: boolean;
};
export type CalibrationSummary = {
  threshold: number;
  violationRuns: number;
  validRuns: number;
  caughtViolations: number;
  falseBlocks: number;
  incorrectPasses: number;
  validPasses: number;
  incompleteViolations: number;
  incompleteValid: number;
  operationalFailures: number;
  judgments: number;
  meanElapsedMs: number;
};
export type CalibrationReport = {
  fixtureSha256?: string;
  ruleId: string;
  configuredThreshold: number;
  backend: string;
  protocolVersion: number;
  repeats: number;
  deadlineMs: number;
  dryRun: boolean;
  examples: number;
  plannedChecks: number;
  results: CalibrationRun[];
  summaries: CalibrationSummary[];
  recommendation: number | null;
  recommendationReason: string;
};
export function calibrate(
  options: CalibrationOptions,
): Promise<CalibrationReport>;
export function formatCalibrationReport(report: CalibrationReport): string;

export type ExampleSuiteOptions = Omit<CalibrationOptions, 'ruleId'> & {
  ruleId?: string;
  examplesDirectory?: string;
};
export type ExampleSuiteReport = {
  mode: 'test' | 'calibrate';
  status: 'pass' | 'fail' | 'dry-run';
  /** SHA-256 of the normalized policy used for all checks. */
  policySha256: string;
  fixtureSha256: Record<string, string>;
  reports: CalibrationReport[];
};
export function testRules(
  options?: Omit<ExampleSuiteOptions, 'thresholds'>,
): Promise<ExampleSuiteReport>;
export function calibrateRules(
  options?: ExampleSuiteOptions,
): Promise<ExampleSuiteReport>;
export function exampleSuiteExitCode(report: ExampleSuiteReport): number;
export function formatExampleSuite(report: ExampleSuiteReport): string;

export type PreparedExamplesOptions = Pick<
  ExampleSuiteOptions,
  | 'cwd'
  | 'ruleId'
  | 'examplesPath'
  | 'examplesDirectory'
  | 'deadlineMs'
  | 'signal'
>;
export type PreparedExamplePacket = {
  stage: 'initial' | 'expanded' | 'screen';
  state: JudgeRequest;
  questions: { result: ReturnType<typeof question> };
};
export type PreparedExamples = {
  protocolVersion: number;
  policySha256: string;
  fixtureSha256: Record<string, string>;
  examples: {
    ruleId: string;
    rule: string;
    threshold: number;
    name: string;
    expected: 'pass' | 'violation';
    packets: PreparedExamplePacket[];
  }[];
};
export function prepareExamples(
  options?: PreparedExamplesOptions,
): Promise<PreparedExamples>;

export type CheckProgress = {
  files: number;
  rulesTotal: number;
  rulesFinished: number;
  judged: number;
  cached: number;
  elapsedMs: number;
};
export function formatProgress(event: CheckProgress): string;
export function createProgressReporter(options?: {
  write?: (text: string) => void;
  delayMs?: number;
  intervalMs?: number;
}): { update(event: CheckProgress): void; stop(): void };
export type CaptureOptions = Pick<
  CheckOptions,
  'cwd' | 'base' | 'head' | 'env' | 'signal'
> & {
  ruleId: string;
  path: string;
  name: string;
  expected: 'pass' | 'violation';
  context?: string[];
};
export function captureExample(
  options: CaptureOptions,
): Promise<CalibrationExamples>;
export function saveCapturedExample(
  fixture: CalibrationExamples,
  output: string,
): Promise<void>;
export type ComparisonCounts = {
  expected: 'pass' | 'violation';
  total: number;
  correct: number;
  violations: number;
  incomplete: number;
  failures: number;
  probabilityMin: number | null;
  probabilityMax: number | null;
};
export type ComparisonReport = {
  status: 'pass' | 'regression';
  improvements: number;
  regressions: number;
  unchanged: number;
  examples: {
    ruleId: string;
    name: string;
    expected: 'pass' | 'violation';
    change: 'improvement' | 'regression' | 'unchanged';
    beforeThreshold: number;
    afterThreshold: number;
    before: ComparisonCounts;
    after: ComparisonCounts;
  }[];
};
export function compareReports(
  before: CalibrationReport | ExampleSuiteReport,
  after: CalibrationReport | ExampleSuiteReport,
  options?: { beforeThreshold?: number; afterThreshold?: number },
): ComparisonReport;
export function formatComparison(report: ComparisonReport): string;
export function runCli(
  args?: string[],
  options?: {
    cwd?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    evaluate?: Evaluator;
    check?: typeof check;
  },
): Promise<number>;
