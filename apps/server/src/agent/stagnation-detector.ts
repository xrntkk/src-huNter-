/**
 * StagnationDetector — detects when the agent loop is making no progress
 * and injects nudges to break out of unproductive cycles.
 *
 * Detection heuristics:
 *   - Rounds without new facts (endpoints/findings)
 *   - Repeated identical tool calls (same tool + same args hash)
 *   - Consecutive 404 responses from HTTP requests
 *   - Empty stops (model stops without executing any tool)
 *
 * Nudge escalation:
 *   - Same nudge type fires at most 3 times
 *   - After 3 nudges of the same type, escalate to forced wrap-up
 */

import { createHash } from 'node:crypto'

export interface NudgeResult {
  message: string
  type: NudgeType
  escalated: boolean
}

type NudgeType = 'no_progress' | 'repeated_call' | 'consecutive_404' | 'empty_stop'

const MAX_NUDGE_PER_TYPE = 3
const NO_PROGRESS_THRESHOLD = 12
const REPEATED_CALL_THRESHOLD = 3
const CONSECUTIVE_404_THRESHOLD = 15

export class StagnationDetector {
  private recentCalls: Array<{ tool: string; hash: string }> = []
  private consecutive404s = 0
  private roundsWithoutProgress = 0
  private nudgeCounts: Record<NudgeType, number> = {
    no_progress: 0,
    repeated_call: 0,
    consecutive_404: 0,
    empty_stop: 0,
  }
  private toolsExecutedThisRound = 0

  /** Call at the start of each iteration to reset per-round counters. */
  startRound(): void {
    this.toolsExecutedThisRound = 0
  }

  /** Record a tool call being made this round. */
  recordToolCall(tool: string, args: unknown): void {
    const hash = hashArgs(args)
    this.recentCalls.push({ tool, hash })
    // Keep a sliding window of 30 recent calls
    if (this.recentCalls.length > 30) {
      this.recentCalls.shift()
    }
  }

  /** Record a tool result (success or error). */
  recordToolResult(tool: string, isError: boolean, statusCode?: number): void {
    if (!isError) {
      this.toolsExecutedThisRound++
    }

    // Track consecutive 404s for http_request
    if (tool === 'http_request') {
      if (statusCode === 404) {
        this.consecutive404s++
      } else {
        this.consecutive404s = 0
      }
    }
  }

  /** Record that meaningful progress occurred (new endpoint, finding, etc). */
  recordProgress(): void {
    this.roundsWithoutProgress = 0
  }

  /**
   * Check for stagnation at the end of a round. Returns a nudge if intervention
   * is needed, or null if the loop is making healthy progress.
   */
  check(hasProgress: boolean): NudgeResult | null {
    if (hasProgress) {
      this.roundsWithoutProgress = 0
    } else {
      this.roundsWithoutProgress++
    }

    // Priority 1: Consecutive 404s
    if (this.consecutive404s >= CONSECUTIVE_404_THRESHOLD) {
      const nudge = this.buildNudge('consecutive_404')
      if (nudge) {
        this.consecutive404s = 0
        return nudge
      }
    }

    // Priority 2: Repeated identical tool calls
    const repeated = this.detectRepeatedCalls()
    if (repeated) {
      const nudge = this.buildNudge('repeated_call', repeated)
      if (nudge) return nudge
    }

    // Priority 3: No progress for N rounds
    if (this.roundsWithoutProgress >= NO_PROGRESS_THRESHOLD) {
      const nudge = this.buildNudge('no_progress')
      if (nudge) return nudge
    }

    return null
  }

  /**
   * Check for empty stop: model returned finishReason=stop but no tool
   * executed successfully this round.
   */
  checkEmptyStop(): NudgeResult | null {
    if (this.toolsExecutedThisRound === 0) {
      return this.buildNudge('empty_stop')
    }
    return null
  }

  /** Reset all state (e.g., when a new user message arrives). */
  reset(): void {
    this.recentCalls = []
    this.consecutive404s = 0
    this.roundsWithoutProgress = 0
    this.toolsExecutedThisRound = 0
  }

  private detectRepeatedCalls(): string | null {
    if (this.recentCalls.length < REPEATED_CALL_THRESHOLD) return null

    // Check the last N calls for repetition
    const last = this.recentCalls[this.recentCalls.length - 1]
    let count = 0
    for (let i = this.recentCalls.length - 1; i >= 0 && count < REPEATED_CALL_THRESHOLD; i--) {
      const c = this.recentCalls[i]
      if (c.tool === last.tool && c.hash === last.hash) {
        count++
      } else {
        break
      }
    }

    if (count >= REPEATED_CALL_THRESHOLD) {
      return last.tool
    }
    return null
  }

  private buildNudge(type: NudgeType, detail?: string): NudgeResult | null {
    if (this.nudgeCounts[type] >= MAX_NUDGE_PER_TYPE) {
      // Escalation: force wrap-up
      return {
        message: ESCALATION_MESSAGES[type],
        type,
        escalated: true,
      }
    }

    this.nudgeCounts[type]++
    return {
      message: detail ? NUDGE_MESSAGES[type].replace('{detail}', detail) : NUDGE_MESSAGES[type],
      type,
      escalated: false,
    }
  }
}

const NUDGE_MESSAGES: Record<NudgeType, string> = {
  no_progress:
    '[系统提示] 已连续多轮未发现新接口或漏洞线索。建议：1) 换一个不同的路径或子域尝试；2) 回顾已知信息寻找遗漏；3) 如果认为当前目标已充分覆盖，请总结发现并收尾。',
  repeated_call:
    '[系统提示] 检测到对 {detail} 工具的重复调用（相同参数）。这表明当前策略可能无效，请尝试不同的参数、路径或工具。',
  consecutive_404:
    '[系统提示] 连续 15 次 HTTP 请求返回 404。当前探测路径可能不存在，建议：1) 换用目录枚举或爬虫获取有效路径；2) 尝试其他子域或端口；3) 重新审视目标信息。',
  empty_stop:
    '[系统提示] 你在未执行任何工具的情况下停止了。如果缺少目标信息，请调用 ask_user 向用户询问。如果任务未完成，请继续使用工具推进工作。如果确实已完成，请调用 add_finding 记录发现并输出最终总结。',
}

const ESCALATION_MESSAGES: Record<NudgeType, string> = {
  no_progress:
    '[系统强制指令] 多次提醒后仍无进展。请立即总结当前所有发现，输出最终报告并结束本轮工作。不要再尝试新的探测。',
  repeated_call:
    '[系统强制指令] 重复调用问题持续存在。请停止当前策略，总结已有发现并收尾。',
  consecutive_404:
    '[系统强制指令] 404 问题未解决。请放弃当前路径探测，总结已有发现并收尾。',
  empty_stop:
    '[系统强制指令] 你已多次在未执行工具的情况下尝试停止。请立即总结当前发现并给出最终报告。',
}

function hashArgs(args: unknown): string {
  const str = JSON.stringify(args ?? {}, Object.keys(args as object ?? {}).sort())
  return createHash('md5').update(str).digest('hex').slice(0, 12)
}
