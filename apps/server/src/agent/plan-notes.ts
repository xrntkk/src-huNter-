/**
 * PlanNotes — lightweight text holder for the model's self-authored plan.
 *
 * The model writes its own exploration plan as freeform text via the
 * `write_plan` tool. This class holds it in memory for injection into
 * the system prompt and post-compression reattach.
 *
 * No persistence — the plan is ephemeral per thread run. After compression,
 * it is re-injected via the reattach message.
 */

export class PlanNotes {
  private text: string | null = null

  set(content: string): void {
    this.text = content
  }

  get(): string | null {
    return this.text
  }

  clear(): void {
    this.text = null
  }
}
