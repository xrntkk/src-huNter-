# 通用规范（所有子 Agent 都遵守）

## 端点归一化

入库前所有 `pathTemplate` 必须经过下面的归一化：

| 输入 | 输出 |
|------|------|
| `/api/orders/123` | `/api/orders/{id}` |
| `/api/orders/12345/items/7` | `/api/orders/{id}/items/{id}` |
| `/u/abc123def` | `/u/{slug}`（仅当看起来是随机串/短 slug） |
| `/api/users/<UUID>` | `/api/users/{id}` |
| `/api/list/` | `/api/list`（去末尾斜杠，根 `/` 除外） |
| `/api/search?q=foo` | `/api/search`（query string 不入 pathTemplate） |

判断"是否是 ID/slug"的规则：

- **纯数字段** ≥ 2 位 → `{id}`
- **UUID 标准格式**（`8-4-4-4-12` 十六进制）→ `{id}`
- **短随机串**（混合大小写字母 + 数字、长度 5–20，看起来不是英文单词）→ `{slug}`
- **明显是英文路径段**（`users`、`orders`、`detail`）→ 保留

## 文件编号统一

每个并行启动的子 Agent 拿到一个数字 `i`（0、1、2…）：

- page-crawler 的 `crawlerIndex` → 决定 `pages-<i>.json` / `js-assets-<i>.json` / `js/<i>-<j>.js`
- 同一 crawler 下载的多个 JS 用 `<crawlerIndex>-<jsIndex>.js`（例 `0-3.js`、`0-4.js`）
- prober/js-analyzer 不必持久化中间文件，但入库时 `description` 里要带来源路径方便追溯

主 Agent 调度时把编号写进 prompt——不要让子 Agent 自己挑编号。

## batch 入库准则

所有分析子 Agent 必须用 `add_endpoints_batch`：

- **整批一次入**：浏览或扫描完所有指定页面/JS 后再调一次
- **单批上限 500 条**：超过的让主 Agent 再细切，不要在子 Agent 里多次调用
- **本批内去重**：同 `(method, pathTemplate)` 只入一次

## description 写什么

| source | description 模板 |
|--------|------------------|
| `network_intercept` | `"来自页面 <页面 URL> 触发"` |
| `js_parse_llm` | `"来自 <localPath> (LLM 精读 <行号区间>) — <识别方式>"`（如"路由表"、"axios.post 拼接"、"@RequestMapping 装饰器"） |
| `js_parse_regex` | `"来自 <localPath> 行 <lineNo>（python 兜底）"` |
| `swagger` | `"来自 <swagger json URL>"`（如果 Phase 0 命中过） |

不写空 description——后续验证人员需要靠它定位。

## 摘要纪律（所有子 Agent）

最终摘要里**不要**复述完整接口列表或页面列表。只汇报：

- 处理范围（crawlerIndex / 文件 / 索引区间）
- 各类计数（页面数、JS 数、入库数、跳过数）
- 关键路径前缀（admin、upload、token、login）
- 任何反常情况（被验证码挡住、路径全部 404、JS 文件异常大）

主 Agent 会自己读 JSON / 调 `list_endpoints` 拿细节。
