/**
 * Hierarchical AbortController — parent-child abort propagation with
 * independent child cancellation.
 *
 * Use cases:
 * - Per-tool timeout: cancel one slow tool without killing the agent loop
 * - Thread → agent loop → per-tool cascade
 * - Independent subagent signals (not linked to parent request)
 */

export class HierarchicalAbortController {
  private controller: AbortController
  private children = new Set<AbortController>()

  constructor(parent?: AbortSignal) {
    this.controller = new AbortController()
    if (parent) {
      if (parent.aborted) {
        this.controller.abort(parent.reason)
      } else {
        parent.addEventListener('abort', () => this.abort(parent.reason), { once: true })
      }
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Create a child controller linked to this one. Aborting parent cascades to child. */
  createChild(): AbortController {
    const child = new AbortController()
    this.children.add(child)

    // Parent abort cascades to child
    if (this.controller.signal.aborted) {
      child.abort(this.controller.signal.reason)
    } else {
      this.controller.signal.addEventListener('abort', () => {
        child.abort(this.controller.signal.reason)
        this.children.delete(child)
      }, { once: true })
    }

    // Clean up reference when child aborts independently
    child.signal.addEventListener('abort', () => {
      this.children.delete(child)
    }, { once: true })

    return child
  }

  /** Create an independent controller NOT linked to this parent. */
  createIndependent(): AbortController {
    return new AbortController()
  }

  /** Abort this controller and cascade to all children. */
  abort(reason?: unknown): void {
    for (const child of this.children) {
      child.abort(reason)
    }
    this.children.clear()
    this.controller.abort(reason)
  }

  get aborted(): boolean {
    return this.controller.signal.aborted
  }
}

/**
 * Create a child AbortSignal that aborts either when the parent aborts
 * OR after a timeout (whichever comes first). Useful for per-tool timeouts.
 */
export function withTimeout(parentSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController()

  const timer = setTimeout(() => {
    controller.abort(new Error(`Timeout after ${timeoutMs}ms`))
  }, timeoutMs)

  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })

  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timer)
      controller.abort(parentSignal.reason)
    } else {
      parentSignal.addEventListener('abort', () => {
        clearTimeout(timer)
        controller.abort(parentSignal.reason)
      }, { once: true })
    }
  }

  return controller.signal
}
