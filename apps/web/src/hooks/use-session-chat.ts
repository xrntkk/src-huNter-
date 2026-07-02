import { useChat } from '@ai-sdk/react'
import type { UIMessage } from '@ai-sdk/react'
import { DefaultChatTransport, APICallError, LoadAPIKeyError, UIMessageStreamError } from 'ai'
import { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import { toast } from 'react-hot-toast'
import type { GraphUpdateEvent } from '@src-agent/types'

/** One ordered history entry from GET /messages (mirror of server HistoryPart). */
type HistoryPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; state: string; toolCallId: string; toolName: string; args: unknown; result: unknown }


/** Concatenate all text parts of a UIMessage into a single string. */
function messageText(msg: UIMessage): string {
  if (!msg.parts) return ''
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('')
}

/** Map server history parts (text / tool, chronological) into v6 UIMessages. */
function mapHistoryToUIMessages(
  msgs: Array<{ id?: string; role: 'user' | 'assistant'; parts: HistoryPart[] }>,
  sessionId: string,
): UIMessage[] {
  return msgs.map((m, i) => {
    const parts: UIMessage['parts'] = []
    for (const hp of m.parts ?? []) {
      if (hp.type === 'text') {
        if (hp.text) parts.push({ type: 'text', text: hp.text })
      } else {
        parts.push({
          type: `tool-${hp.toolName}`,
          toolCallId: hp.toolCallId,
          state: hp.state === 'result' || hp.state === 'output-available' ? 'output-available' : 'input-available',
          input: hp.args,
          ...(hp.result !== undefined ? { output: hp.result } : {}),
        } as UIMessage['parts'][number])
      }
    }
    return {
      id: m.id ?? `hist_${sessionId}_${i}`,
      role: m.role,
      parts,
    } as UIMessage
  })
}

export interface PlanState {
  notes: string
}

interface UseSessionChatOptions {
  sessionId: string
  threadId?: string
  selectedEndpointIds: string[]
  modelId?: string
  selectedSkills?: string[]
  selectedMcpServers?: string[]
  onGraphUpdate?: (event: GraphUpdateEvent) => void
}

const PLAN_NOTES_REGEX = /<!--PLAN_NOTES:([\s\S]*?)-->/g

export function useSessionChat({
  sessionId,
  threadId,
  selectedEndpointIds,
  modelId,
  selectedSkills,
  selectedMcpServers,
  onGraphUpdate,
}: UseSessionChatOptions) {
  const onGraphUpdateRef = useRef(onGraphUpdate)
  onGraphUpdateRef.current = onGraphUpdate

  const [planState, setPlanState] = useState<PlanState | null>(null)
  const planStateRef = useRef<PlanState | null>(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [agentRunning, setAgentRunning] = useState(false)
  // Track messages snapshot before stop() to prevent content loss
  // (@ai-sdk/react useChat().stop() may roll back assistant message content)
  const messagesBeforeStopRef = useRef<UIMessage[] | null>(null)
  const stopPendingRef = useRef(false)

  const chatId = threadId ? `${sessionId}:${threadId}` : sessionId

  // v6: per-request `api`/`body` moved onto a transport. `body` is resolved on
  // every send, so reading the latest selectedEndpointIds/modelId/threadId via
  // refs keeps the payload current without re-creating the transport.
  const bodyRef = useRef({ selectedEndpointIds, modelId, threadId, selectedSkills, selectedMcpServers })
  bodyRef.current = { selectedEndpointIds, modelId, threadId, selectedSkills, selectedMcpServers }

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/api/sessions/${sessionId}/chat`,
        body: () => bodyRef.current,
        // The server is authoritative: it rebuilds the conversation from its
        // own persisted Timeline and only reads the latest user message off the
        // request. So we ship just the final message instead of the full
        // history — big bandwidth win on long threads, zero behaviour change.
        prepareSendMessagesRequest: ({ messages, body, api }) => ({
          api,
          body: { ...body, messages: messages.slice(-1) },
        }),
      }),
    [sessionId],
  )

  const chat = useChat({
    id: chatId,
    transport,
    // Batch streamed UI updates to ~one per 50ms instead of one per token.
    // Without this, every token triggers a React state update + re-render,
    // saturating the main thread on long messages and making the UI visibly
    // lag behind the backend. 50ms keeps typing fluid while cutting render
    // count by an order of magnitude.
    experimental_throttle: 50,
    onError: err => {
      console.error('[Chat] Error:', err)
      // The live stream broke, but the agent runs independently server-side and
      // may still be reconnecting (internal ECONNRESET retry). Engage the
      // recovery poll: it checks /status and, once the agent actually finishes,
      // refetches the persisted transcript — so partial output isn't lost and
      // the typing indicator clears at the right time instead of getting stuck.
      setAgentRunning(true)
      // Map v6 structured errors to actionable user feedback.
      if (APICallError.isInstance(err)) {
        if (err.statusCode === 401) toast.error('API Key 无效或已过期，请在设置中检查')
        else if (err.statusCode === 429) toast.error('请求过于频繁，请稍后重试')
        else if (err.statusCode != null && err.statusCode >= 500) toast.error('模型服务暂时不可用，请稍后重试')
        else toast.error(`请求失败: ${err.message}`)
      } else if (LoadAPIKeyError.isInstance(err)) {
        toast.error('未配置 API Key，请在设置中配置')
      } else if (UIMessageStreamError.isInstance(err)) {
        toast.error('消息流中断，正在尝试恢复…')
      } else {
        toast.error('发生未知错误，请稍后重试')
      }
    },
    onData: (dataPart: { type: string; data: unknown }) => {
      if (dataPart.type === 'data-plan-notes') {
        const d = dataPart.data as { notes: string }
        const state: PlanState = { notes: d.notes }
        planStateRef.current = state
        setPlanState(state)
      }
    },
  })

  // v6 exposes a `status` enum instead of a boolean `isLoading`.
  const isChatLoading = chat.status === 'submitted' || chat.status === 'streaming'

  // Keep a stable ref to chat so the history-loading effect
  // does NOT re-fire when useChat returns a new object literal.
  const chatRef = useRef(chat)
  chatRef.current = chat

  // Load conversation history on mount / sessionId / threadId change
  useEffect(() => {
    if (!sessionId) return
    setHistoryLoaded(false)
    // Reset chat + plan state immediately so the UI shows the new thread
    // (or its emptiness) without lingering messages from the previous one.
    // Also guards against late-returning fetches from a prior thread by tagging
    // each effect run with a sequence id and ignoring stale resolutions.
    chatRef.current.setMessages([])
    planStateRef.current = null
    setPlanState(null)

    let cancelled = false
    const threadParam = threadId ? `?threadId=${threadId}` : ''
    fetch(`/api/sessions/${sessionId}/messages${threadParam}`)
      .then(res => res.json())
      .then((data: { messages: Array<{ id?: string; role: 'user' | 'assistant'; parts: HistoryPart[] }> }) => {
        if (cancelled) return
        const msgs = data.messages || []
        // History arrives as ordered native parts (text / tool interleaved in
        // chronological order). Map each into a v6 UIMessage part — text parts
        // pass through, tool parts become `tool-${name}` parts — so tool cards
        // and their ordering survive a refresh without position markers.
        const historyMessages = mapHistoryToUIMessages(msgs, sessionId)
        chatRef.current.setMessages(historyMessages)

        // Parse plan notes from historical messages
        for (const msg of historyMessages) {
          if (msg.role !== 'assistant') continue
          const content = messageText(msg)
          const matches = [...content.matchAll(PLAN_NOTES_REGEX)]
          for (const match of matches) {
            try {
              const payload = JSON.parse(match[1])
              if (payload.notes) {
                const newState: PlanState = { notes: payload.notes }
                planStateRef.current = newState
                setPlanState(newState)
              }
            } catch {
              // Skip malformed plan notes
            }
          }
        }
        setHistoryLoaded(true)

        // Check if agent is still running (e.g. page was refreshed mid-task)
        fetch(`/api/sessions/${sessionId}/status${threadParam}`)
          .then(r => r.json())
          .then((s: { running: boolean }) => { if (!cancelled) setAgentRunning(s.running) })
          .catch(() => {})
      })
      .catch(err => {
        if (cancelled) return
        console.error('[Chat] Failed to load history:', err)
        setHistoryLoaded(true)
      })

    return () => { cancelled = true }
  }, [sessionId, threadId])

  // Recover from a dropped browser↔server stream. The agent runs independently
  // of the HTTP connection, so when the live stream breaks (network blip, tab
  // refresh, silent hang) the agent keeps going server-side. This poll:
  //   1. Checks /status — when the agent finishes, refetches the final transcript.
  //   2. While the agent is running AND the live stream is not active (broke /
  //      page refresh), periodically refetches persisted messages to show
  //      progress — so the user isn't staring at stale records for minutes.
  //   3. Detects "stuck streaming" (agent done but chat.status still
  //      'streaming') — after 9s, force-stops the stale stream and refetches.
  //
  // Uses chatRef.current.status inside the interval (not the closure-captured
  // isChatLoading) so it always sees the latest state without needing
  // isChatLoading in the dependency array.
  useEffect(() => {
    if (!sessionId || !agentRunning) return

    let cancelled = false
    let stuckCount = 0
    const threadParam = threadId ? `?threadId=${threadId}` : ''

    const poll = setInterval(async () => {
      try {
        const s = await fetch(`/api/sessions/${sessionId}/status${threadParam}`).then(r => r.json()) as { running: boolean }
        if (cancelled) return

        const isStreamActive = () => {
          const st = chatRef.current.status
          return st === 'submitted' || st === 'streaming'
        }

        if (!s.running) {
          // Agent finished server-side
          if (isStreamActive()) {
            // Stream still "loading" — either normal completion in transit, or
            // the stream is stuck. Give it 3 poll cycles (9s) to resolve
            // naturally; after that, force-stop and refetch.
            stuckCount++
            if (stuckCount >= 3) {
              chatRef.current.stop()
              // Brief delay for stop() to take effect before refetching
              await new Promise(r => setTimeout(r, 200))
              if (cancelled) return
              const data = await fetch(`/api/sessions/${sessionId}/messages${threadParam}`).then(r => r.json()) as
                { messages: Array<{ id?: string; role: 'user' | 'assistant'; parts: HistoryPart[] }> }
              if (cancelled) return
              chatRef.current.setMessages(mapHistoryToUIMessages(data.messages || [], sessionId))
              setAgentRunning(false)
            }
          } else {
            // Stream done or broke — safe to refetch final transcript
            setAgentRunning(false)
            const data = await fetch(`/api/sessions/${sessionId}/messages${threadParam}`).then(r => r.json()) as
              { messages: Array<{ id?: string; role: 'user' | 'assistant'; parts: HistoryPart[] }> }
            if (cancelled) return
            chatRef.current.setMessages(mapHistoryToUIMessages(data.messages || [], sessionId))
          }
        } else if (!isStreamActive()) {
          // Agent still running but live stream is not active (broke / page
          // refresh). Refetch persisted messages to show progress — the agent
          // persists state on every tool_result/tool_error/finish step.
          const data = await fetch(`/api/sessions/${sessionId}/messages${threadParam}`).then(r => r.json()) as
            { messages: Array<{ id?: string; role: 'user' | 'assistant'; parts: HistoryPart[] }> }
          if (cancelled) return
          chatRef.current.setMessages(mapHistoryToUIMessages(data.messages || [], sessionId))
        }
        // else: agent running + stream active = normal streaming, don't interfere
      } catch { /* transient — keep polling */ }
    }, 3000)

    return () => { cancelled = true; clearInterval(poll) }
  }, [sessionId, threadId, agentRunning])

  // Strip plan update annotations from message parts for display. v6 messages
  // carry text only in `parts` (no top-level `content`), so we clean the text
  // parts in place. This is only needed for historical messages that used the
  // old text marker format — new messages use SDK data parts (transient).
  const processedMessages = useMemo(() => {
    return chat.messages.map(msg => {
      if (msg.role !== 'assistant' || !msg.parts) return msg

      let partsChanged = false
      const cleanedParts = msg.parts.map(part => {
        if (part.type === 'text' && part.text) {
          const cleaned = part.text.replace(PLAN_NOTES_REGEX, '')
          if (cleaned !== part.text) {
            partsChanged = true
            return { ...part, text: cleaned }
          }
        }
        return part
      })

      if (!partsChanged) return msg
      return { ...msg, parts: cleanedParts }
    })
  }, [chat.messages])

  // Listen for graph_update events via separate SSE stream
  //
  // RECONNECT: Exponential backoff on connection drop (1s → 2s → 4s → ... max 30s).
  // The retry counter resets after a successful connection period (>10s stable).
  useEffect(() => {
    if (!sessionId) return

    let evtSource: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoffMs = 1000 // start at 1s
    const MAX_BACKOFF = 30_000
    let stableTimer: ReturnType<typeof setTimeout> | null = null
    let isUnmounted = false

    function connect() {
      if (isUnmounted) return

      evtSource?.close()
      // Append ?token= when the user has configured an SSE access token in
      // settings (stored in localStorage). If absent (local dev, no
      // SRC_AGENT_TOKEN on the server), the URL is left bare — matching the
      // server's skip-auth-when-env-unset behavior.
      const sseToken = localStorage.getItem('src_agent_token')
      const sseUrl = sseToken
        ? `/api/sessions/${sessionId}/events?token=${encodeURIComponent(sseToken)}`
        : `/api/sessions/${sessionId}/events`
      evtSource = new EventSource(sseUrl)

      evtSource.addEventListener('graph_update', e => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as GraphUpdateEvent
          onGraphUpdateRef.current?.(data)
        } catch { /* ignore */ }
      })

      evtSource.onopen = () => {
        // Connection stable — reset backoff after 10 seconds of stability
        backoffMs = 1000
        if (stableTimer) clearTimeout(stableTimer)
        stableTimer = setTimeout(() => {
          backoffMs = 1000
        }, 10_000)
      }

      evtSource.onerror = () => {
        evtSource?.close()
        if (isUnmounted) return

        console.warn(`[SSE] Connection lost, reconnecting in ${backoffMs}ms...`)
        reconnectTimer = setTimeout(() => {
          connect()
        }, backoffMs)

        // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (capped)
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF)
      }
    }

    connect()

    return () => {
      isUnmounted = true
      evtSource?.close()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (stableTimer) clearTimeout(stableTimer)
    }
  }, [sessionId, threadId])

  // Restore assistant content that was rolled back by chat.stop().
  // AI SDK's stop() may clear the last assistant message parts or remove
  // it entirely — this effect detects the rollback and restores the snapshot.
  useEffect(() => {
    if (!stopPendingRef.current || isChatLoading) return

    stopPendingRef.current = false
    const snapshot = messagesBeforeStopRef.current
    messagesBeforeStopRef.current = null
    if (!snapshot) return

    const current = chat.messages
    let needsRestore = false
    const restored = [...current]

    for (let i = 0; i < snapshot.length; i++) {
      const snap = snapshot[i]
      if (snap.role !== 'assistant') continue
      const curr = restored[i]
      if (!curr || curr.role !== 'assistant') {
        // Message was entirely removed — re-insert it
        restored.splice(i, 0, snap)
        needsRestore = true
      } else if (messageText(snap) && !messageText(curr)) {
        // Parts were cleared — restore from snapshot
        restored[i] = { ...curr, parts: snap.parts }
        needsRestore = true
      }
    }

    if (needsRestore) {
      chatRef.current.setMessages(restored)
    }
  }, [chat.messages, isChatLoading])

  // sendMessage / approve / stop call through chatRef (not `chat` directly) so
  // their identity stays stable across renders. useChat returns a fresh `chat`
  // object every render; depending on it would break React.memo on the message
  // components downstream (they'd re-render every token during streaming).
  const sendMessage = useCallback(
    (text: string) => {
      // Clear any pending stop restore — new message supersedes it
      messagesBeforeStopRef.current = null
      stopPendingRef.current = false
      // Arm recovery logic from the start — if the live stream later breaks
      // silently (hangs without firing onError), the recovery poll is already
      // running and will detect when the agent finishes.
      setAgentRunning(true)
      chatRef.current.sendMessage({ text })
    },
    [],
  )

  // Resume a loop paused for tool approval. The decisions ride in the request
  // body; the backend joins them with the calls it paused on and replays them
  // (the message text is a control signal, ignored as conversation input).
  const approve = useCallback(
    (decisions: Array<{ toolCallId: string; approved: boolean }>) => {
      messagesBeforeStopRef.current = null
      stopPendingRef.current = false
      setAgentRunning(true)
      chatRef.current.sendMessage({ text: '[tool-approval]' }, { body: { approvals: decisions } })
    },
    [],
  )

  // Override stop to also notify the backend, since the agent now runs
  // independently of the HTTP connection.
  const stop = useCallback(() => {
    // Snapshot messages before stopping — AI SDK's stop() may roll back
    // the last assistant message parts (clear them or remove the message).
    messagesBeforeStopRef.current = chatRef.current.messages.map(m => ({
      ...m,
      parts: m.parts ? m.parts.map(p => ({ ...p })) : [],
    }))
    stopPendingRef.current = true

    chatRef.current.stop()
    setAgentRunning(false)
    fetch(`/api/sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId }),
    }).catch(() => {})
  }, [sessionId, threadId])

  return {
    ...chat,
    messages: processedMessages,
    planState,
    sendMessage,
    approve,
    stop,
    isLoading: isChatLoading || agentRunning,
    isHistoryLoaded: historyLoaded,
  }
}
