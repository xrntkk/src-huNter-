---
name: src-recon
description: 当用户提供目标域名，需要发现该站点接口时使用。主干给出双阶段并行流水线的总图与契约，详细步骤分散在子文档中，按需 load_skill 渐进式披露。
when_to_use: 接到"发现 X 站点接口/资产"类任务时，主 Agent 用本技能编排子 Agent 并行收集 + 分析。
---

# SRC 接口发现方法论 (双阶段并行版)

## ⛔ 主 Agent 硬性红线（违反即任务失败）

**主 Agent 在整个 src-recon 流程中只允许使用以下工具**：
- `load_skill`（加载子文档）
- `spawn_agent`（mode 必须是 `sync`）
- `list_endpoints`（只在 Phase 3 汇总用）
- `add_endpoints_batch`（只在极少数 Phase 0 主页明示接口时用，Phase 1+ 严禁）
- `file_system`（**仅 read**，仅在 Phase 1 完成后读 pages/js-assets 索引做切片用）
- `query_subagent` / `send_message`（监控子 Agent 用）

**主 Agent 严禁直接调用以下工具**（这些是子 Agent 的工具，主 Agent 用了就是越权）：
- ❌ `browser_navigate` / `browser_get_text` / `browser_evaluate` / `browser_screenshot` / `browser_click` / `browser_fill`
- ❌ `python_exec` / `bash`
- ❌ `http_request`
- ❌ `file_system` 的 write / list / create_directory（只允许 read）

如果你（主 Agent）发现自己想发上面 ❌ 的工具调用，**立即停止并改为 spawn_agent 让子 Agent 干**。

**唯一例外**：Phase 0 主 Agent 可以用 browser/python/http_request 做"摸底"，**仅限 1~3 次最小化探测**确定 entryGroups，然后立刻进入 Phase 1 spawn 子 Agent。Phase 0 的边界详见 `phase-0-homepage` 子文档。

## 核心思想

两个阶段都用并行的阻塞式子 Agent——同一轮里同时发出 N 个 sync 子任务，全部返回后再进入下一阶段。比 async + 通知监听更简单可控。

## 角色

- **主 Agent (orchestrator)**：编排整条流水线，做切片、并发 spawn、阶段守门。**不要自己爬页面或读 JS。** 上面的工具黑名单是硬约束。
- **子 Agent (page-crawler / endpoint-prober / js-analyzer)**：执行某一切片，产出标准化文件 + 批量入库。

子 Agent 的系统提示只写角色边界与产物契约；具体的提取规则、文件格式、拦截器代码都在本技能的子文档里。**子 Agent 也可以 `load_skill('src-recon', subPath='agent-...')` 拿到自己那份实操指南**——主 Agent 在子 Agent 的 prompt 里写明 subPath 即可。

## 开始前自检（每次接到任务都过一遍）

1. 我是主 Agent 吗？是 → 我不能爬页面、不能跑 python、不能发 http
2. 我是不是想直接 browser_navigate / file_system write 自己干活？是 → **错了，回头 spawn_agent**
3. 我现在该 spawn 几个子 Agent？默认 K=2~4 个 page-crawler，全部 sync 同批发出
4. spawn_agent 同批里我有没有混入其他工具？有 → **错了，删掉混入项**

## 三类子 Agent

| agentType | 阶段 | 模式 | 数量 | 职责 |
|-----------|------|------|------|------|
| `page-crawler` | 收集 | sync 并行 ×K | K=2~4 | 各负责一个站点子域/路径区段，遍历 + 下载 JS，写带编号的索引文件 |
| `endpoint-prober` | 分析 | sync 并行 ×N | N | 读分配到的 pages 切片，浏览器交互抓 XHR，batch 入库 |
| `js-analyzer` | 分析 | sync 并行 ×M | M | 读分配到的 jsAssets 切片，**分段 LLM 精读还原混淆代码**，batch 入库；python 仅作兜底 |

每个分析子 Agent 都用 `add_endpoints_batch` 批量入库。

## 共享数据通道

所有同 session 子 Agent 共享 `workspace/{sessionId}/`：

| 路径 | 写入方 | 读取方 |
|------|--------|--------|
| `recon/seed.json` | 主 Agent (Phase 0) | 所有子 Agent |
| `recon/pages-<i>.json` | page-crawler #i | 主 Agent / endpoint-prober |
| `recon/js-assets-<i>.json` | page-crawler #i | 主 Agent / js-analyzer |
| `recon/js/<crawlerIdx>-<jsIdx>.js` | page-crawler #i 下载的 JS 原文 | js-analyzer |
| `recon/js-extract-<batchTag>.json` | js-analyzer 中间产物 | 同实例 |

**编号规则**：每个并行启动的子 Agent 都拿到一个数字 `i`（0、1、2…），所有产出文件都带这个编号后缀，避免互相覆盖。详见 `conventions` 子文档。

## 流水线总图

```
Phase 0  主 Agent 亲自摸底（不 spawn）        → seed.json
   │
Phase 1  spawn × K 个 page-crawler (sync 并行) → pages-i / js-assets-i / js/i-j
   │
Phase 2  spawn × (N+M) 个 prober/js-analyzer  → endpoints 入库
   │
Phase 3  list_endpoints + 缺口扩展 + 报告
```

每个 Phase 的具体步骤、prompt 模板、产物格式拆在独立子文档：

- **Phase 0**（主页探测，决定 entryGroups 切分）→ `load_skill('src-recon', subPath='phase-0-homepage')`
- **Phase 1**（阻塞并行收集）→ `load_skill('src-recon', subPath='phase-1-collect')`
- **Phase 2**（阻塞并行分析）→ `load_skill('src-recon', subPath='phase-2-analyze')`
- **Phase 3**（汇总扩展）→ `load_skill('src-recon', subPath='phase-3-report')`

子 Agent 角色实操指南：

- `agent-page-crawler` — 页面遍历 / JS 下载 / 索引文件 schema
- `agent-endpoint-prober` — 网络拦截器代码 + 触发策略
- `agent-js-analyzer` — python 提取脚本要点

通用规范：

- `conventions` — 端点归一化、文件编号、batch 入库准则

按需加载，不必一次性全拉。

## 编排守则（主 Agent 必读）

1. **必须用 sync 模式 spawn_agent**：禁止使用 `mode: 'async'` 或 `mode: 'fork'`。
   - sync 是阻塞模式：spawn 后父 Agent 必须等子 Agent 返回，期间不能做任何其他操作（包括读文件、发请求、查端点）。
   - async/fork 是后台模式：父会立即继续干活，破坏阶段守门 → 子还没写完文件，父就读到空文件。
   - 同一轮里发多个 sync spawn_agent **会自动并行**，这是设计行为，不需要换 async。
2. **两个阶段都是阻塞并行**：每阶段同一轮里发出所有 sync spawn_agent，等全部返回再进入下一阶段。不要把 spawn 拆到不同轮——会丢失并行性。
3. **spawn_agent 同批不要混入其他工具**：spawn_agent 那一轮里**只放 spawn_agent 调用**，不要同时塞 file_system / list_endpoints / http_request。哪怕看起来"等子运行的间隙顺手做点事"——那是 async 思维，sync 模式下不允许。
4. **Phase 1 → Phase 2 严格串行**：原料没收齐就起分析子 Agent = 它们读到空文件，浪费一整轮。
5. **文件编号要统一**：每个 crawler 都有唯一 crawlerIndex，所有它的产出（pages-i.json、js-assets-i.json、js/i-j.js）都带这个编号。
6. **切片不能太细**：每个分析子 Agent 至少处理 5 个目标，否则启动开销 > 实际工作。
7. **永远 batch 入库**：分析子 Agent 的 prompt 里明写"使用 add_endpoints_batch"。
8. **数据走文件不走 summary**：清单通过 `file_system` 在 workspace 传递；子 Agent 的 prompt 只写"路径 + 索引区间"。
9. **不要自己亲自爬页面或读 JS**：编排者的角色是调度。
10. **不要因为目标"看起来简单"就退化成 K=1**：并行 crawler 开销极小（每个独立浏览器上下文），覆盖收益高。

## 完成报告

所有子 Agent 完成后，`list_endpoints` 总结：

1. 接口总数 + 按 source 分布（network_intercept / js_parse）
2. 按 method 分布
3. 高风险候选（含 id/admin/token/upload/import/export 的路径）
4. 建议优先验证的接口和理由
