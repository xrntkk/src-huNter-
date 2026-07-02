/**
 * Structured logging module built on pino.
 *
 * Features:
 * - JSON-structured logs for production, pretty-printed for development
 * - Log level control via LOG_LEVEL env var (trace/debug/info/warn/error/fatal)
 * - Optional file output via LOG_FILE env var
 * - Child loggers with component context for easy filtering
 * - Global error-attachment helper
 *
 * Usage:
 *   import { logger } from './logger/index.js'
 *   const log = logger.child({ component: 'AgentLoop' })
 *   log.info({ sessionId, iteration: 5 }, 'Starting iteration')
 *   log.error({ err, toolCallId }, 'Tool execution failed')
 */

import pino, { type Logger } from 'pino'

// --------------- configuration ---------------

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
const NODE_ENV = process.env.NODE_ENV ?? 'development'

// Generate date-based log file path: ./logs/YYYY-MM-DD.log
function getLogFilePath(): string {
  if (process.env.LOG_FILE) return process.env.LOG_FILE
  const now = new Date()
  const dateStr = now.toISOString().split('T')[0] // YYYY-MM-DD
  return `./logs/${dateStr}.log`
}
const LOG_FILE = getLogFilePath()

/** Absolute path to the current log file — exported for user-facing error hints. */
export const LOG_FILE_PATH = LOG_FILE

const level = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(LOG_LEVEL)
  ? LOG_LEVEL
  : 'info'

// --------------- transports ---------------

const targets: pino.TransportTargetOptions[] = []

if (NODE_ENV === 'development' || process.env.FORCE_PRETTY === '1') {
  // Pretty-print for human readability in dev
  targets.push({
    target: 'pino-pretty',
    level,
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
      messageFormat: '[{component}] {msg}',
    },
  })
} else {
  // JSON structured output for production
  targets.push({
    target: 'pino/file',
    level,
    options: { destination: 1 }, // stdout
  })
}

// Optional file output (JSON format, all levels)
if (LOG_FILE) {
  targets.push({
    target: 'pino/file',
    level: 'trace',
    options: { destination: LOG_FILE, mkdir: true },
  })
}

// --------------- base logger ---------------

export const logger: Logger = pino({
  level,
  transport: { targets },
  serializers: {
    // Standard pino serializers for error objects
    err: pino.stdSerializers.err,
    // Serialize unknown values safely
  },
  // Merge base context into every log line
  base: {
    pid: process.pid,
    hostname: undefined, // omit hostname to reduce noise
  },
  // Redact sensitive fields from logged objects
  redact: {
    paths: [
      'apiKey',
      'api_key',
      'API_KEY',
      'authorization',
      'Authorization',
      'token',
      'secret',
      'password',
      'headers.authorization',
      'headers.Authorization',
    ],
    censor: '***REDACTED***',
  },
})

// Log logger initialization
logger.info({ level, logFile: LOG_FILE || '(stdout only)', env: NODE_ENV }, 'Logger initialized')

// --------------- helpers ---------------

/**
 * Extract a compact error object suitable for structured logging.
 * Avoids logging full stacks unless at debug/trace level.
 */
export function errObj(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    const base: Record<string, unknown> = {
      message: e.message,
      name: e.name,
    }
    if (level === 'debug' || level === 'trace') {
      base.stack = e.stack
    }
    // Carry through known AI SDK error properties
    if ('statusCode' in e) base.statusCode = (e as any).statusCode
    if ('cause' in e && (e as any).cause) {
      const cause = (e as any).cause
      base.cause = typeof cause === 'string' ? cause.slice(0, 500) : JSON.stringify(cause).slice(0, 500)
    }
    return base
  }
  return { message: String(e) }
}
