# page-crawler 子 Agent 实操指南

收到 prompt 后做三件事：A. 页面遍历 → B. JS 全文下载 → C. 写产出索引。

prompt 里会指定你的 `crawlerIndex` 和入口 URL。所有产出文件都要带这个编号后缀。

## A. 页面遍历

1. **`browser_navigate`** 打开入口（`waitUntil=networkidle`）
2. **`browser_evaluate`** 抽：
   - 同域 `<a href>` 链接
   - 所有 `<script src>` 资源列表
3. **同域链接入队递归**——遍历直到队列空
   - 去重：相同 path 只保留一份代表
   - 跳过明显冗余的分页/锚点变体
   - **不预设深度或数量上限**，遍历广度优先即可
4. **跳过**：
   - 外链（不同域名）
   - 锚点跳转（`#xxx`）
   - 登出/删除按钮（`/logout`、`/delete?id=...`）
   - 明显重复的同 path 页面

## B. JS 全文下载

对去重后的每个 JS URL：

1. **`http_request(GET, url)`** 拉完整 body
2. **`file_system({action:"write", path:"recon/js/<crawlerIndex>-<jsIdx>.js", content: <完整 JS 文本>})`**

> 文件大不要紧——下游用 python 分析，模型不读全文。**不要**提前截断或只下载前 N 字节。

## C. 写产出索引

按下面的契约写两个文件。

### `recon/pages-<crawlerIndex>.json`

```json
{
  "crawlerIndex": 0,
  "generatedAt": "2026-...",
  "scope": "https://target.com/admin/*",
  "pages": [
    {
      "index": 0,
      "url": "...",
      "title": "...",
      "forms": [{"action": "...", "method": "..."}]
    }
  ]
}
```

### `recon/js-assets-<crawlerIndex>.json`

```json
{
  "crawlerIndex": 0,
  "jsAssets": [
    {
      "index": 0,
      "url": "https://x/a.js",
      "localPath": "recon/js/0-0.js",
      "size": 12345,
      "fromPage": "..."
    }
  ]
}
```

## 摘要纪律

最终摘要只汇报：

- `crawlerIndex`
- 写入路径
- 各计数（页面数 / JS 数 / 跳过数）
- 若干高亮入口（admin / upload / login / 看起来 API 文档的页面）

**禁止**复述完整 pages 数组到摘要——主 Agent 会自己读 JSON。
