# Phase 1 — 阻塞式并行收集（sync × K）

读 `recon/seed.json` 的 `entryGroups`，**在同一轮思考里连续发出 K 个 `spawn_agent(mode: 'sync')`**——AI SDK 会并行执行它们，主 Agent 在所有 spawn_agent 都返回后才进入下一轮。

> **禁止**"先起一个 crawler 摸底，等返回了再起下一个"——Phase 0 已经做过摸底了。

## spawn 模板

假设 `seed.json` 的 `entryGroups` 有 3 项，同一轮里发出：

```text
spawn_agent({
  mode: "sync",
  agentType: "page-crawler",
  description: "crawler 0 - 主站根",
  prompt:
    "crawlerIndex=0。入口: https://target.com/。" +
    "先 file_system read recon/seed.json 看主页探测结果（避免重复）。" +
    "把页面索引写到 recon/pages-0.json，JS 索引写到 recon/js-assets-0.json，" +
    "JS 原文存到 recon/js/0-<jsIdx>.js。"
})

spawn_agent({
  mode: "sync",
  agentType: "page-crawler",
  description: "crawler 1 - 后台",
  prompt: "crawlerIndex=1。入口: https://target.com/admin/。同上规范，文件后缀 -1。"
})

spawn_agent({
  mode: "sync",
  agentType: "page-crawler",
  description: "crawler 2 - API 文档",
  prompt: "crawlerIndex=2。入口: https://target.com/api-docs/。同上规范，文件后缀 -2。"
})
```

K 个 crawler 同时跑、各写各的文件，主 Agent 一直阻塞到全部完成。

## 提示子 Agent 加载实操指南

在每个 crawler 的 prompt 里加一句：
> "需要更详细的页面遍历/JS 下载步骤时调用 `load_skill('src-recon', subPath='agent-page-crawler')`。"

这样子 Agent 不必预加载完整指南——遇到判断不清楚的细节再按需拉。

## 等所有 crawler 返回后

主 Agent 用 `file_system list recon/` 看产出，依次 read 每个 `pages-<i>.json` 和 `js-assets-<i>.json`，拼成总清单：

- 总页面数 P = Σ `pages_i.length`
- 总 JS 数 J = Σ `jsAssets_i.length`
- 切片粒度：每个 prober ~10 页面、**每个 js-analyzer 3-5 个 JS**（LLM 精读比 python 慢得多，单个 analyzer 不要塞太多）
- 算出要起 N 个 prober 和 M 个 js-analyzer

> **不要进入 Phase 2 之前不读所有索引**——下一阶段要按文件 + 索引区间分配，跳过这一步会导致切片重叠或漏分。

## 反模式

- ❌ 把 K 个 spawn_agent 拆到不同轮——AI SDK 不会并行执行跨轮的工具调用。
- ❌ 在 prompt 里复述完整的 page-crawler 指南——让子 Agent 自己 `load_skill` 拉。
- ❌ 用 async 模式 + 通知监听——本流水线刻意选用 sync 阻塞以简化阶段守门。
