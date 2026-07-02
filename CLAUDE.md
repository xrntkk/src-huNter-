# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`src-agent` — an SRC (Security Response Center) vulnerability-hunting agent. Full-stack TypeScript monorepo orchestrated with **moonrepo + pnpm**. Backend drives an LLM agent loop with tool calling; frontend is a React workspace UI.

Node.js >= 22.12.0, pnpm >= 9.

## Commands

Run from the repo root unless noted. Moon fans these out across workspace projects.

```bash
pnpm install                # install all workspace deps
pnpm dev                    # moon run :dev — starts server (3001) + web (5173) together
pnpm dev:full               # node scripts/dev-with-langfuse.mjs — also boots Langfuse docker stack (falls back to pnpm dev if no Docker)
pnpm build                  # moon run :build — server uses tsup, web uses vite build
pnpm typecheck              # moon run :typecheck — tsc --noEmit per package

# Langfuse trace stack (optional, requires Docker):
pnpm langfuse:up            # docker compose -f docker-compose.langfuse.yml up -d
pnpm langfuse:down
pnpm langfuse:logs

# Per-package equivalents:
cd apps/server && pnpm dev  # tsx watch src/index.ts
cd apps/web    && pnpm dev  # vite dev (proxies /api → http://localhost:3001)

# Helper script (checks pnpm, runs both):
./start.sh                  # macOS/Linux
start.bat                   # Windows
```

Tests run with **vitest**, only in `apps/server` (`*.test.ts` next to the code):

```bash
cd apps/server && pnpm test            # vitest run (all tests)
cd apps/server && pnpm test:watch      # vitest watch
cd apps/server && pnpm vitest run src/agent/agent-loop.test.ts   # single file
```

`apps/server/vitest.config.ts` wires `src/test/setup.ts`, which points `DATABASE_URL` at a throwaway SQLite file **before** any module imports `@src-agent/db` (the db handle is a module-level singleton). There's no test runner in `apps/web` or the packages.

Required setup before first run: `cp config/models.example.json config/models.json` and fill in API key(s). The model router reads `config/models.json` (active model + per-model configs) and prefers it over legacy env vars.

## Repo layout

```
apps/server     Hono API + agent loop (port 3001)
apps/web        React 19 + Vite + react-router v7 (port 5173)
packages/types  Shared TS types (workspace:*)
packages/db     better-sqlite3 + drizzle-orm schema (workspace:*)
packages/skills Markdown skill docs loaded on demand by the agent
packages/knowledge  Vuln-knowledge corpus (workspace:*)
config/mcp.yaml      MCP server registrations (stdio/sse)
config/models.json   Active LLM + per-provider configs (gitignored; copy from models.example.json)
config/agents.json   Sub-agent enable/disable state ({ disabled: string[] })
config/agents/*.yaml User-defined sub-agent roles (override built-ins by name)
config/skills.json   Skill enable/disable state ({ disabled: string[] })
docker-compose.langfuse.yml  Self-hosted Langfuse trace stack (optional)
scripts/             dev-with-langfuse.mjs and helpers
.moon/               moonrepo workspace + toolchain pins
```

Workspaces declared in `pnpm-workspace.yaml`; project list mirrored in `.moon/workspace.yml`.

## Backend architecture (`apps/server/src`)

The agent is **the** core abstraction. Reading these in order is the fastest path to understanding the system:

1. **`agent/src-agent.ts`** — `runSRCAgent(sessionId, threadId, request)` is the entry point called by `routes/chat.ts`. State is keyed **per thread**, not per session. Each thread has a `Timeline`, `AbortController`, and a `busy` lock; a new request on a busy thread aborts the in-flight loop (`acquireRun`).

2. **`agent/agent-loop.ts`** — `runAgentLoop()` is an `AsyncGenerator<AgentStep>`. It drives the Vercel AI SDK **`streamText`** (the SDK auto-executes tools and runs up to ~24 internal model calls per pass via `stepCountIs`); an outer reconnect loop retries only when `streamText` fails before producing progress. Steps are emitted as the stream advances. `agentLoopToDataStreamResponse` pipes these into a `createUIMessageStreamResponse` UI-message stream; `REASONING` / `PLAN_UPDATE` / `ASK_USER` / `TOOL_APPROVAL` events ride as embedded markers the frontend parses. Helpers: `micro-compact.ts` (in-place tool-I/O trimming when context is tight), `post-compact-reattach.ts` (`buildReattachMessage` re-orients the model after a compaction), `result-spillover.ts` (oversized tool outputs spilled to disk/observation store).

3. **State stores (replaced the old `Timeline`)** — per-thread state is split across:
   - **`agent/message-store.ts`** — `MessageStore` is the in-memory source of truth. `toModelMessages()` builds LLM context (with tool I/O); there's a UI history view for frontend reload; `serialize()/deserialize()` persist state. Handles compression summaries, interruption markers, and `skill_loaded` records (so loaded skills survive restore). Replaces `Timeline.toModelPrompt()`.
   - **`agent/thread-jsonl-store.ts`** — `ThreadJsonlStore` is the on-disk projection: an append-only JSONL log at `apps/server/data/threads/<threadId>.jsonl` (O(1) append vs full-blob rewrite; crash-resilient). SQLite keeps only metadata + summary, flushed by `src-agent.ts` at iteration boundaries.
   - **`agent/observation-store.ts` + `agent/observer.ts`** — `Observer` is a *proactive, additive* curation layer: every N iterations the fast model compresses recent tool I/O into a rolling "近期进展" board for the prompt. It NEVER mutates/drops timeline items and degrades silently on failure. Distinct from the defensive compaction in `MessageStore`.

4. **`agent/prompt-builder.ts` + `skill-registry.ts`** — **prompt-cache aware** layout. Static prefix (`SRC_SYSTEM_PROMPT` + skill catalog) stays stable; dynamic sections (endpoint context, MCP instructions, observer board, *loaded skill bodies*) come after a `<!-- SRC_AGENT_DYNAMIC_CONTEXT_BOUNDARY -->` marker. **Loaded skill bodies live in the system prompt, not the message store** — so they survive compression and don't consume context budget. The `load_skill` tool adds them; on session restore, `skill_loaded` records are replayed to rehydrate the registry.

5. **`agent/model-router.ts`** — reads `config/models.json` first (active model + per-model `{provider, baseURL, apiKey, modelId}`). Supported providers: `anthropic`, `deepseek`, `openai`, `openrouter`, `kimi`, `claude-cli`. The `claude-cli` provider does **not** call any HTTP endpoint — it returns a `ClaudeAgentLanguageModel` instance from `agent/claude-agent-language-model.ts`, which implements Vercel AI SDK's `LanguageModelV1` directly on top of `@anthropic-ai/claude-agent-sdk`. The SDK reuses `~/.claude/` OAuth credentials, and we pass `disallowedTools: ['*'] + maxTurns: 1` so src-agent's own agent loop stays in control of tool calling. `GET /api/system/info` reports detection state so the web UI can offer a one-click setup. Falls back to legacy env vars (`ANTHROPIC_BASE_URL`, `DEEPSEEK_API_KEY`, etc.) if no `models.json`. `getModel(requestedModelId?)` selects the model purely from user config (requested → `activeModelId` → `OVERRIDE_MODEL` → fallback) — there is **no** keyword-based task-type guessing or silent model swapping; the user picks the model and the model decides how to approach the task.

6. **`agent/permissions.ts`** — fail-closed `PermissionChecker`. Core tools are pre-allowed; `file_system` denies `delete/rm/rmdir`. MCP tools are NOT auto-allowed — `runSRCAgent` calls `addMcpAllowlist(Object.keys(mcpTools))` to whitelist whatever the MCP manager discovered.

7. **`mcp/manager.ts`** — singleton `mcpManager`. Connects to stdio/sse servers from `config/mcp.yaml` at bootstrap, lists their tools, and wraps each as a Vercel AI SDK `tool()`. Tool names are prefixed `serverName__toolName`. JSON Schema → Zod conversion is handled by `buildZodSchema/jsonSchemaToZod`. `mcpManager.reload()` is exposed via the settings route. **`config/mcp.yaml` ships with `mcpServers: {}` — MCP is opt-in; commented `playwright`/`fofa` examples sit at the top of the file.**

### Routes (`apps/server/src/routes/`)

`chat.ts` (agent SSE stream) · `threads.ts` (per-thread state) · `sessions.ts` · `endpoints.ts` · `reports.ts` · `workspace.ts` · `settings.ts` (LLM / MCP / skills / knowledge / agents config — also exposes `mcpManager.reload()`) · `system.ts` (host diagnostics — `GET /system/info` returns whether the local `claude` CLI is installed; cached at bootstrap) · `telemetry.ts` (per-step timing/token/cost events, served under `/api/telemetry`).

### Supporting modules under `agent/`

- `model-output-normalizer.ts` / `message-validator.ts` — reconcile provider-specific tool-call shapes before the loop sees them.
- `tool-formatters.ts` — renders tool I/O for both store persistence and SSE display.
- `context-builder.ts` — assembles endpoint / target-memory / MCP dynamic context appended after the cache boundary.
- `telemetry.ts` + `cost-calculator.ts` — per-step timing, token counters, cost.
- `langfuse-trace.ts` + `../instrumentation.ts` — OpenTelemetry → self-hosted Langfuse. Opt-in: only active when `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set; `instrumentation.ts` must be imported before any AI SDK code path.
- `hierarchical-abort.ts` — `HierarchicalAbortController` cascades aborts from a thread to its sub-agents.
- `interruption.ts` — mid-run user-message interruption markers, restored on reload.
- `memory-extractor.ts` / `session-memory.ts` / `tools/memory.ts` — auto-extracted `target_memory` plus the agent's own long-term `memories`/`memory_edges` graph (custom, multi-provider — not Anthropic's `memory_*` tool).
- `agent-loader.ts` + `agent-types.ts` + `subagent-registry.ts` — built-in sub-agent roles merged with user YAML in `config/agents/*.yaml` (enable/disable via `config/agents.json`).
- `slash-commands.ts` — backend-owned prompt injection. Frontend sees only `name`/`label`/`description` (via `GET /api/slash-commands`); `/recon`, `/verify`, `/idor`, `/sqli` expand to full prompts server-side.
- `error-diagnostics.ts` / `retry-policy.ts` — classify provider errors and drive reconnect/retry.

### Agent loop quirks worth knowing

- **Empty-stop nudges**: DeepSeek (and similar) often emits a prose "next I'll do X" then `finishReason=stop` with zero tool calls. The loop nudges up to 3 times before honoring the stop. It only honors a self-declared "task complete" if at least one tool actually ran successfully — otherwise the model is dodging work.
- **Stagnation detector** (`stagnation-detector.ts`): 15 consecutive 404s, or 15 rounds with no new endpoint discovered, emits a `system_nudge`. Resets on meaningful results.
- **Plan notes** (`plan-notes.ts`): the `write_plan` tool lets the model record its own freeform exploration plan (markdown text, overwritten each call). This replaced the old structured `create_plan`/`ExecutionPlan` engine — there's no backend status machine; the model owns its plan. Snapshots stream as `plan_update` markers.
- **Spawn-agent tools**: `spawn-agent` forks a sub-agent (same system prompt + tools, its own message store). Sub-agents can be async — `query-subagent`, `continue-subagent`, `abort-subagent` manage in-flight ones; results persist in `subagent_tasks`/`subagent_stores`.

## Database

SQLite via `better-sqlite3` + `drizzle-orm`. Path defaults to `apps/server/data/src-agent.db` (relative to server CWD; `.gitignore`'d). Per-thread message logs live alongside as JSONL under `apps/server/data/threads/`.

**Schema is defined in two places** that must stay in sync — keep this in mind when changing tables:
- `apps/server/src/index.ts` — raw `CREATE TABLE IF NOT EXISTS` at bootstrap.
- `packages/db/src/index.ts` — same DDL plus drizzle schema in `packages/db/src/schema/`.

Tables include `sessions`, `endpoints`, `findings`, `request_logs`, `action_logs`, `threads`, `thread_timelines`, `target_memory`, `subagent_tasks`, `subagent_stores`, `telemetry_events`, `facts`, `memories`, `memory_edges` (and legacy `session_timelines`). `migrateColumns()` does idempotent `ALTER TABLE ADD COLUMN` for fields added later — extend that helper rather than dropping/recreating tables. There's a drizzle-kit config at `packages/db/drizzle.config.ts` but the codebase relies on the bootstrap DDL + `migrateColumns` rather than generated migrations.

`thread_timelines` (current model — per-thread metadata/summary, with the full log in JSONL) has a fallback read from legacy `session_timelines` for backward compat.

## Frontend (`apps/web/src`)

- React 19 + Vite + Tailwind v4 (via `@tailwindcss/vite`) + react-router v7 (lazy routes in `routes.ts`).
- Vite dev server proxies `/api` → `http://localhost:3001` — frontend code hits relative `/api/...` paths.
- State: `zustand` stores in `stores/` (`session-store`, `agent-store`); `@tanstack/react-query` for server state.
- Endpoint graph: `@xyflow/react` (formerly ReactFlow) + `elkjs` for layout (`lib/elk-layout.ts`).
- Monaco editor wrapped in `components/ui/monaco-editor.tsx`.
- Routes: `/` (home), `/session/:sessionId`, `/settings` (index = LLM) with children `/settings/{mcp,skills,agents}`.

## TS / build conventions

- Workspace-internal imports go through `@src-agent/*` (declared in each package's `package.json` as `workspace:*`, mapped via `tsconfig` paths + `vite-tsconfig-paths`).
- All `.ts` source uses **explicit `.js` import specifiers** (NodeNext/ESM rule) — keep this when adding files.
- `tsconfig.base.json`: strict, ES2022 target, `lib: ["ESNext"]` (covers `Array.fromAsync` etc.), `moduleResolution: bundler`, `noUnusedLocals/Parameters: true`, `exactOptionalPropertyTypes: false`.
- Server bundles with `tsup` to ESM. No CJS output.

## Skills (`packages/skills`)

Each subdirectory is one skill (3 of them: `src-recon`, `src-web-vuln`, `payloads-everything`). `src-web-vuln` is an orchestrator that slices endpoints into vulnerability-family buckets and sync-spawns parallel sub-agents; sub-agents test by their own security knowledge (no per-vuln skills needed). The agent receives only a **catalog** at startup (built by `skill-loader.ts:buildSkillCatalog`) and calls the `load_skill` tool to pull a full skill body into its system prompt on demand. `config/skills.json` (`{ disabled: string[] }`) toggles which skills appear in the catalog. `skill-loader.ts` resolves `packages/skills` via `process.cwd() + ../../packages/skills` — the server is expected to be run from `apps/server/`. Same goes for `model-router.ts` reading `../../config/models.json` and `agent-loader.ts` reading `../../config/agents*`. Don't break this CWD assumption.

Frontmatter at the top of each `SKILL.md` (`name:`, `description:`, `when_to_use:`) drives the catalog — preserve those keys when editing.

## Adding things

- **New tool** → add file in `apps/server/src/agent/tools/`, register it in `runSRCAgent` (`src-agent.ts` imports + tool map), allow it in `permissions.ts` `DEFAULT_RULES`, document in `prompts/system.ts`. Existing core tools: `add-endpoint`, `add-endpoints-batch`, `import-endpoints`, `export-endpoints`, `list-endpoints`, `update-endpoint-status`, `add-finding`, `delete-finding`, `http-request`, `web-search`, `bash`, `python` (+ `file_system`), `playwright`, `query-knowledge`, `memory`, `load-skill`, `write-plan`, `ask-user`, `send-message`, `spawn-agent`, `query-subagent`, `continue-subagent`, `abort-subagent`.
- **New sub-agent role** → add a YAML file in `config/agents/` (or extend `BUILT_IN_AGENTS` in `agent-types.ts`); `agent-loader.ts` merges them and `config/agents.json` toggles enable/disable.
- **New MCP server** → edit `config/mcp.yaml`; the manager auto-discovers and the permission allowlist auto-extends on next bootstrap or via `mcpManager.reload()`.
- **New table / column** → update both the bootstrap DDL in `apps/server/src/index.ts` and the drizzle schema under `packages/db/src/schema/`. For new columns on existing tables, also extend `migrateColumns()` in `packages/db/src/index.ts`.
- **New LLM provider** → extend the `switch` in `model-router.ts:buildModelFromConfig` (cases: `anthropic`, `deepseek`, `openai`, `openrouter`, `kimi`, `claude-cli`); mirror the URL-normalization helpers if the provider has quirks (see `normalizeDeepSeekBaseURL`).
