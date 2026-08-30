/**
 * Minimal structured logger.
 *
 * One JSON object per line so CloudWatch Logs Insights can query fields directly
 * (`fields @timestamp, msg, contactId | filter level = "ERROR"`), with the
 * request correlation ids stamped on every line.
 *
 * PRODUCTION NOTE: I would replace this with AWS Lambda Powertools for
 * TypeScript (@aws-lambda-powertools/logger + tracer + metrics). It gives the
 * same JSON shape plus X-Ray trace correlation, sampled debug logging, and EMF
 * custom metrics essentially for free. I wrote this by hand here only to keep
 * the dependency surface of the exercise small and the bundle honest.
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase();
  return raw in LEVEL_ORDER ? (raw as LogLevel) : 'INFO';
}

export interface LogContext {
  readonly [key: string]: unknown;
}

export class Logger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  /** Returns a new logger with extra fields stamped on every line. */
  child(extra: LogContext): Logger {
    return new Logger({ ...this.context, ...extra });
  }

  /** Mutates this logger's context. Used once per invocation to add the request id. */
  addContext(extra: LogContext): void {
    this.context = { ...this.context, ...extra };
  }

  debug(msg: string, fields?: LogContext): void {
    this.write('DEBUG', msg, fields);
  }
  info(msg: string, fields?: LogContext): void {
    this.write('INFO', msg, fields);
  }
  warn(msg: string, fields?: LogContext): void {
    this.write('WARN', msg, fields);
  }

  error(msg: string, error?: unknown, fields?: LogContext): void {
    this.write('ERROR', msg, { ...fields, ...serialiseError(error) });
  }

  private write(level: LogLevel, msg: string, fields?: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;
    const line = {
      level,
      msg,
      timestamp: new Date().toISOString(),
      ...this.context,
      ...fields,
    };
    // Deliberately console.* : Lambda routes stdout/stderr to CloudWatch, and
    // going through the console keeps the runtime's request-id decoration.
    const sink = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    sink(JSON.stringify(line));
  }
}

function serialiseError(error: unknown): LogContext {
  if (error === undefined || error === null) return {};
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      // Stacks are large; they are the reason you opened the log, so keep them.
      stack: error.stack,
    };
  }
  return { errorMessage: String(error) };
}

/** Shared root logger. Handlers call `addContext` per invocation. */
export const logger = new Logger({ service: process.env.SERVICE_NAME ?? 'vanity-connect' });
