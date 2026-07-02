import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, desc } from 'drizzle-orm'
import { runSRCAgent, clearTimeline, initTimeline, stopAgent, isAgentRunning } from '../agent/src-agent.js'
import { listSlashCommands } from '../agent/slash-commands.js'
import { registerEmitter } from '../agent/tools/add-endpoint.js'
import { getDb, actionLogs } from '@src-agent/db'
import type { ChatRequest } from '@src-agent/types'
import { logger } from '../logger/index.js'

export const chatRouter = new Hono()

// Slash-command catalog for the input autocomplete. Exposes name/label/
// description only — the real prompts stay server-side in slash-commands.ts.
chatRouter.get('/slash-commands', c => {
  return c.json({
    commands: listSlashCommands().map(({ name, label, description }) => ({ name, label, description })),
  })
})

// SSE stream: graph updates (endpoint_added, finding_added)
chatRouter.get('/sessions/:sessionId/events', async c => {
  const sessionId = c.req.param('sessionId')

  // Lightweight token auth: when SRC_AGENT_TOKEN env is set, the request's
  // ?token= query param must match. If the env is unset (local dev), auth is
  // skipped entirely — preserving the local-first default.
  // The 401 must be returned before entering streamSSE so the client gets a
  // clean JSON error instead of an SSE stream.
  const expectedToken = process.env.SRC_AGENT_TOKEN
  if (expectedToken) {
    const token = c.req.query('token')
    if (token !== expectedToken) {
      return c.json({ error: 'unauthorized' }, 401)
    }
  }

  return streamSSE(c, async stream => {
    const unregister = registerEmitter(sessionId, async event => {
      await stream.writeSSE({
        event: 'graph_update',
        data: JSON.stringify(event),
      })
    })

    // Keep alive
    const ping = setInterval(() => {
      stream.writeSSE({ event: 'ping', data: 'ok' }).catch(() => {})
    }, 15000)

    await new Promise<void>(resolve => {
      stream.onAbort(() => {
        unregister()
        clearInterval(ping)
        resolve()
      })
    })
  })
})

// Main chat endpoint - returns AI SDK data stream for useChat
//
// v6's DefaultChatTransport posts UIMessages whose text lives in a `parts`
// array (no top-level `content`). We accept the parts shape (and still tolerate
// a legacy `content` string) and flatten text parts into `content` for the
// agent, which works with a plain string transcript.
const uiPartSchema = z
  .object({ type: z.string(), text: z.string().optional() })
  .passthrough()

chatRouter.post(
  '/sessions/:sessionId/chat',
  zValidator(
    'json',
    z.object({
      messages: z.array(
        z.object({
          id: z.string().optional(),
          role: z.enum(['user', 'assistant']),
          content: z.string().optional(),
          parts: z.array(uiPartSchema).optional(),
        }),
      ),
      selectedEndpointIds: z.array(z.string()).default([]),
      modelId: z.string().optional(),
      threadId: z.string().optional(),
      selectedSkills: z.array(z.string()).optional(),
      selectedMcpServers: z.array(z.string()).optional(),
      // Tool-approval decisions when resuming a paused loop (HITL).
      approvals: z
        .array(
          z.object({
            toolCallId: z.string(),
            approved: z.boolean(),
            note: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  async c => {
    const sessionId = c.req.param('sessionId')
    const raw = c.req.valid('json')
    // Use threadId if provided, otherwise fall back to sessionId (legacy/default thread)
    const threadId = raw.threadId || sessionId

    // Flatten v6 parts → content string for the agent.
    const body: ChatRequest & { threadId?: string } = {
      messages: raw.messages.map(m => ({
        id: m.id ?? '',
        role: m.role,
        content:
          m.content ??
          (m.parts ?? [])
            .filter(p => p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text as string)
            .join(''),
      })),
      selectedEndpointIds: raw.selectedEndpointIds,
      modelId: raw.modelId,
      threadId: raw.threadId,
      selectedSkills: raw.selectedSkills,
      selectedMcpServers: raw.selectedMcpServers,
      approvals: raw.approvals,
    }

    try {
      const response = await runSRCAgent(sessionId, threadId, body)
      return response
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[Chat] Agent error:', err)
      return c.json({ error: message }, 500)
    }
  },
)

// Stop a running agent for a thread
chatRouter.post('/sessions/:sessionId/stop', async c => {
  const sessionId = c.req.param('sessionId')
  const body = await c.req.json<{ threadId?: string }>().catch(() => ({}))
  const threadId = (body as { threadId?: string }).threadId || sessionId
  const stopped = stopAgent(threadId)
  return c.json({ ok: stopped, message: stopped ? 'Agent stopped' : 'No running agent found' })
})

// Check if an agent is currently running for this thread
chatRouter.get('/sessions/:sessionId/status', async c => {
  const sessionId = c.req.param('sessionId')
  const threadId = c.req.query('threadId') || sessionId
  return c.json({ running: isAgentRunning(threadId) })
})

// Get conversation history for a thread (compatible with AI SDK useChat)
chatRouter.get('/sessions/:sessionId/messages', async c => {
  const sessionId = c.req.param('sessionId')
  const threadId = c.req.query('threadId') || sessionId
  const timeline = await initTimeline(threadId)

  const rawMessages = timeline.toHistoryMessages()
  const messages = rawMessages.map((m, i) => ({
    id: `msg_${i}`,
    role: m.role,
    parts: m.parts,
  }))

  // Plan two: surface the interruption-state-machine inference so the UI can
  // render a single recovery banner. The agent loop itself injects the
  // recovery prose into the model's view; this payload is just for display.
  const interruption = timeline.getLastInterruption()
  return c.json({ messages, interruption: interruption.kind === 'none' ? null : interruption })
})

// Get action logs for a session
chatRouter.get('/sessions/:sessionId/action-logs', async c => {
  const sessionId = c.req.param('sessionId')
  const db = getDb()
  const logs = await db
    .select()
    .from(actionLogs)
    .where(eq(actionLogs.sessionId, sessionId))
    .orderBy(desc(actionLogs.createdAt))
    .limit(200)
  return c.json({ logs })
})

// Clear timeline for a thread (useful for "new chat" or reset)
chatRouter.post('/sessions/:sessionId/clear', async c => {
  const sessionId = c.req.param('sessionId')
  const body = await c.req.json<{ threadId?: string }>().catch(() => ({}))
  const threadId = (body as { threadId?: string }).threadId || sessionId
  clearTimeline(threadId)
  return c.json({ ok: true })
})
