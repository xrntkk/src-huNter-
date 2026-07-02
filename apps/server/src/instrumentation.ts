/**
 * OpenTelemetry instrumentation — wires Vercel AI SDK telemetry to a Langfuse
 * self-hosted instance. Must be imported BEFORE any AI SDK code path.
 *
 * Activation: requires LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY in env. If
 * either is missing the bootstrap is skipped silently — Langfuse stays opt-in.
 */

import { NodeSDK } from '@opentelemetry/sdk-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { logger, errObj } from './logger/index.js'

let started = false
let processor: LangfuseSpanProcessor | null = null
let sdk: NodeSDK | null = null

export function bootstrapLangfuse(): boolean {
  if (started) return true
  const pub = process.env.LANGFUSE_PUBLIC_KEY
  const sec = process.env.LANGFUSE_SECRET_KEY
  if (!pub || !sec) {
    logger.info('skipped — set LANGFUSE_PUBLIC_KEY/SECRET_KEY to enable')
    return false
  }
  try {
    processor = new LangfuseSpanProcessor()
    sdk = new NodeSDK({
      spanProcessors: [processor],
    })
    sdk.start()
    started = true
    const baseURL = process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com'
    logger.info({ baseURL }, 'OTel started')

    // Periodic flush — short-lived agent turns batch spans; without an explicit
    // flush they sit in memory until process shutdown, so the dashboard sees no
    // traces while you're actively using the app. 5s feels live, costs nothing.
    setInterval(() => {
      processor?.forceFlush().catch(err => {
        logger.warn({ err: errObj(err) }, 'flush failed')
      })
    }, 5_000).unref()

    // Best-effort flush on shutdown
    const shutdown = async () => {
      try { await processor?.forceFlush() } catch { /* ignore */ }
      try { await sdk?.shutdown() } catch { /* ignore */ }
    }
    process.once('SIGINT', () => { void shutdown() })
    process.once('SIGTERM', () => { void shutdown() })
    process.once('beforeExit', () => { void shutdown() })

    return true
  } catch (err) {
    logger.warn({ err: errObj(err) }, 'init failed')
    return false
  }
}

/** Trigger an immediate flush (e.g. at end of an agent run). */
export async function flushLangfuse(): Promise<void> {
  if (!processor) return
  try { await processor.forceFlush() } catch { /* ignore */ }
}
