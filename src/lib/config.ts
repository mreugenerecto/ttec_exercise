/**
 * Environment configuration, read once and validated loudly.
 *
 * Reading env vars at module scope means a misconfigured deployment fails on the
 * very first cold start with a clear message, instead of throwing a confusing
 * `undefined` deep inside the DynamoDB SDK on some unlucky call an hour later.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intWithDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

export interface AppConfig {
  readonly tableName: string;
  readonly recentIndexName: string;
  /**
   * Number of partitions for the "recent calls" GSI. See repository.ts for why
   * this exists. 1 is correct for the traffic this exercise will ever see.
   */
  readonly recentShardCount: number;
  /** How many vanity numbers to persist per call. The brief says 5. */
  readonly resultsToStore: number;
  /** How many to read aloud in the IVR. The brief says 3. */
  readonly resultsToSpeak: number;
  /** Retention for call records, in days. Enforced by DynamoDB TTL. */
  readonly retentionDays: number;
}

/**
 * Build config from the environment. Called lazily so that unit tests can set
 * env vars before the first read, and so importing a handler for a type does not
 * blow up in a context with no environment.
 */
export function loadConfig(): AppConfig {
  return {
    tableName: required('TABLE_NAME'),
    recentIndexName: process.env.RECENT_INDEX_NAME ?? 'recent-calls-index',
    recentShardCount: intWithDefault('RECENT_SHARD_COUNT', 1),
    resultsToStore: intWithDefault('RESULTS_TO_STORE', 5),
    resultsToSpeak: intWithDefault('RESULTS_TO_SPEAK', 3),
    retentionDays: intWithDefault('RETENTION_DAYS', 90),
  };
}

let cached: AppConfig | null = null;

/** Memoised config for the life of the execution environment. */
export function config(): AppConfig {
  if (cached === null) cached = loadConfig();
  return cached;
}

/** Test seam: drop the memoised config so env changes take effect. */
export function __resetConfigForTests(): void {
  cached = null;
}
