# Phase 0 — 主页探测（主 Agent 亲自做，但严格限额）

**第一步由主 Agent 自己完成**——亲自探一次主页，基于"实际看到的内容"决定怎么切分并行 crawler。

## ⚠️ Phase 0 硬性限额
- **不要进入 iframe / 不要点击按钮 / 不要登录态交互** —— 那些是 page-crawler 的职责
- **不要下载 JS 文件原文** —— 那是 page-crawler 的职责
- **不要遍历多级页面** —— 只看主页一层，看完立刻进 Phase 1


## 步骤（按需选取）

1. **`browser_navigate`** 打开根域，等 `networkidle`。
2. **`browser_evaluate`** 一次性抽取以下所有信号（合并到 1 次调用里）：
   - 顶部导航菜单的所有同域 `<a href>`
   - 页脚的同域 `<a href>`
   - 所有 `<script src>`（看技术栈）
   - 页面里的 `window.__APP_CONFIG__` / 路由表（如果是 SPA）
   - 主页加载时已发起的 XHR/Fetch URL（用 performance API 拿）
3. **`http_request GET`**（合并到 1 次 python_exec 并发请求里更省）以下路径，看返回：
   - `/robots.txt`
   - `/sitemap.xml`
   - `/api-docs` / `/swagger.json` / `/swagger-ui.html`
   - `/.well-known/openapi.json`


## 写入 `recon/seed.json`

```json
{
  "rootUrl": "https://target.com",
  "techStack": ["...", "..."],
  "navLinks": ["/admin", "/account", "/shop", "..."],
  "configHints": {
    "robotsDirs": ["..."],
    "sitemapDirs": ["..."],
    "openapiPaths": ["..."]
  },
  "homepageXhrs": ["/api/me", "/api/products?page=1", "..."],
  "entryGroups": [
    {"crawlerIndex": 0, "label": "主站根", "url": "https://target.com/"},
    {"crawlerIndex": 1, "label": "后台", "url": "https://target.com/admin/"},
    {"crawlerIndex": 2, "label": "API 文档", "url": "https://target.com/api-docs/"}
  ]
}
```

## 切分 entryGroups 的判断

`entryGroups` 由主 Agent 基于"实际看到的"自行决定切分（K≥2，通常 2–5）：

- **顶部导航的一级路径自然就是分组**——每个一级路径一个 crawler 入口
- **robots/sitemap 提到的目录前缀**里，与导航不重叠的额外作为新入口
- **如果 SPA 有显式路由表**，按一级路由切

## 保底切分

上面探测都很贫瘠时（裸根目录或纯 SPA 单入口），用这套通用切分：

- crawler 0：根域 `/`
- crawler 1：从 `/admin`、`/console`、`/dashboard`、`/manage` 中**第一个 200 响应**的那个
- crawler 2：从 `/api-docs`、`/swagger-ui.html`、`/api/v1`、`/api/v2` 中**第一个 200 响应**的那个

## 反模式

- ❌ 跳过 Phase 0 直接 spawn crawler——切分不会对齐目标实际形态。
- ❌ 因为目标"看起来简单"就只起 K=1 的 crawler——并行 crawler 的开销很小，覆盖收益高。
- ❌ 把 Phase 0 的探测交给子 Agent——切分决策需要主 Agent 直接看到的信号。
- ❌ **Phase 0 进入 iframe / 点击按钮 / 下载 JS 文件原文 / 遍历多级页面**——这些是 page-crawler 的活，主 Agent 越权。

## ✅ Phase 0 完成后立刻做的事

主 Agent 的下一个动作**必须**是：

1. `load_skill('src-recon', subPath='phase-1-collect')` 加载 Phase 1 指南
2. 同一轮里发出 K 个 sync `spawn_agent(agentType='page-crawler')`，每个一个 entryGroup
3. **不要再用 browser/http_request/python_exec/file_system write**——Phase 1 开始后这些工具都属于子 Agent

如果你（主 Agent）现在还想继续 browser_navigate 看下一页，或者用 python_exec 解析 JS——**错了**，那是 page-crawler 的工作。立刻 spawn。
