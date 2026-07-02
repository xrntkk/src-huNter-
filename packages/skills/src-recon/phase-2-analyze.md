# Phase 2 — 阻塞式并行分析（sync × (N+M)）

**关键**：同一轮里同时发出 N+M 个 `spawn_agent(mode: 'sync')`。所有分析子 Agent 并行跑，主 Agent 全部返回后才进入 Phase 3。

## prompt 必须明确的三件事

每个 spawn_agent 的 prompt 必须写清：

1. **哪些索引文件**（可能跨多个 `pages-<i>.json` / `js-assets-<i>.json`）
2. **每个文件中的索引区间**
3. **强调用 `add_endpoints_batch` 批量入库**

## endpoint-prober 切片示例

假设 P=22（来自 pages-0=10, pages-1=8, pages-2=4），N=3：

```text
spawn_agent({mode:"sync", agentType:"endpoint-prober",
  description:"prober 0",
  prompt:
    "读 recon/pages-0.json 的 pages[0..9]。注入网络拦截，触发主功能，" +
    "最后 add_endpoints_batch 一次性入库。" +
    "需要拦截器代码与触发策略时 load_skill('src-recon', subPath='agent-endpoint-prober')。"})

spawn_agent({mode:"sync", agentType:"endpoint-prober",
  description:"prober 1",
  prompt:"读 recon/pages-1.json 的 pages[0..7]。同上规范。"})

spawn_agent({mode:"sync", agentType:"endpoint-prober",
  description:"prober 2",
  prompt:"读 recon/pages-2.json 的 pages[0..3]。同上规范。"})
```

## js-analyzer 切片示例

假设 J=12（jsAssets-0=6, jsAssets-1=4, jsAssets-2=2），M=3：

```text
spawn_agent({mode:"sync", agentType:"js-analyzer",
  description:"js-analyzer 0",
  prompt:
    "读 recon/js-assets-0.json 的 jsAssets[0..5]，从 localPath 读 JS 文件。" +
    "**分段精读还原混淆代码**（默认流程，不要直接 python 批量正则）。" +
    "提取规则与分段策略 load_skill('src-recon', subPath='agent-js-analyzer')。" +
    "整批 add_endpoints_batch 入库。"})

spawn_agent({mode:"sync", agentType:"js-analyzer",
  description:"js-analyzer 1",
  prompt:"读 recon/js-assets-1.json 的 jsAssets[0..3]。同上规范。"})

spawn_agent({mode:"sync", agentType:"js-analyzer",
  description:"js-analyzer 2",
  prompt:"读 recon/js-assets-2.json 的 jsAssets[0..1]。同上规范。"})
```

## 切片粒度

- **每个 prober**：~10 个页面（多了交互轮次太长，少了 spawn 开销摊不平）
- **每个 js-analyzer**：**3-5 个 JS 文件**（LLM 精读混淆代码很慢，单文件可能要分 5-10 段读；这个数字远小于 python 时代的 8）
- **下限**：任何子 Agent 至少处理 2 个目标，否则启动开销 > 实际工作

主 Agent 拿到所有 N+M 个 sync spawn 的返回值，每个返回里都有该子 Agent 入库了多少条接口的统计。

## 反模式

- ❌ Phase 1 没收齐就起 prober——子 Agent 会读到空文件。
- ❌ N+M 太大（>12）——AI SDK 并行能力虽然有，但单轮工具调用过多会拖慢主 Agent 推理。
- ❌ 让子 Agent 自己决定切片范围——切片必须由主 Agent 在 prompt 中明确划定，避免重叠/遗漏。
