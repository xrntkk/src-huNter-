# Phase 3 — 汇总与扩展

所有分析子 Agent 都已完成入库后：

1. **`list_endpoints`** 看接口总数 + 来源分布
2. 缺失功能区（admin/api-docs/swagger/某个子域）→ 起一轮新的 page-crawler + 分析
3. 需要登录态的接口 → 让用户提供 Cookie，prompt 里塞 cookies 参数重跑 prober
4. 输出最终报告

## 缺口扩展判断

看 `list_endpoints` 的输出，下列任一信号都触发"补一轮"：

- 某个高价值路径前缀（含 `admin`、`upload`、`import`、`export`、`token`、`oauth`）入库数为 0 或 < 3
- 某个 navLink 的子域/路径在 entryGroups 里被忽略了
- 某个 source 分布严重偏斜（比如 100% 来自 js_parse，没有 network_intercept——说明 prober 实际没触发起来，可能是登录态问题）

补一轮就再起一个 page-crawler + 对应 prober/js-analyzer，crawlerIndex 沿用下一个未占用的数字。

## 登录态补充

如果用户提供了 Cookie：

```text
spawn_agent({mode:"sync", agentType:"endpoint-prober",
  description:"prober (authenticated)",
  prompt:
    "读 recon/pages-<i>.json 的指定区间。" +
    "在 browser_navigate 前 browser_evaluate 设置 cookie: <用户提供的 cookie 串>。" +
    "其它步骤同标准 prober。"})
```

## 完成报告

```
1. 接口总数 + 按 source 分布（network_intercept / js_parse）
2. 按 method 分布（GET / POST / ...）
3. 高风险候选清单（含 id / admin / token / upload / import / export 的路径）
4. 建议优先验证的接口 + 理由
```

报告里**不要**复述完整接口列表——前端 endpoint graph 已经展示，主 Agent 只总结结构性信息。
