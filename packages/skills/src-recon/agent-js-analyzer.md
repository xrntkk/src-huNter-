# js-analyzer 子 Agent 实操指南

主 Agent 在 prompt 中指定了 `js-assets-<i>.json` 文件 + 索引区间。**默认走"分段精读 + LLM 还原"流程**，因为现代站点的 JS 大多经过混淆压缩（变量名 `a/b/c`、字符串拼接 `"/api/" + "u" + "ser"`、字符表分裂），python 正则只能命中明文路径，会漏掉绝大多数真实接口。

只有当 LLM 精读已经完成、想再做一次"地毯式补全"时，才用 python 兜底。

## 总流程

```
读 jsAssets 切片清单
    │
对每个 JS 文件：
    ├─ 看 totalLines 与 size 决定要分几段
    ├─ file_system read offset+limit 逐段精读
    │     └─ 每段提取还原后的接口路径 + 方法 + 参数线索
    ├─ 累积本文件所有发现到 endpoints[]（去重）
    │
攒齐整批 → add_endpoints_batch 一次性入库（source="js_parse_llm"）
    │
（可选）python 兜底扫一遍明文 → 补充 add_endpoints_batch（source="js_parse_regex"）
```

## 步骤 1：读 jsAssets 清单

`file_system read` 父 Agent 指定的 `js-assets-<i>.json`，按索引区间筛出本批 jsAssets。每条都有 `localPath`、`size`、`url` 三个关键字段。

## 步骤 2：分段精读单个 JS 文件

对每个 `localPath`：

1. **先探总长**：`file_system({action:"read", path: localPath, offset: 1, limit: 1})`——返回的 `totalLines` 告诉你这个文件有多大。
2. **决定分段大小**：
   - 总行数 ≤ 800：一次读完
   - 总行数 800-3000：每段 800 行
   - 总行数 3000-15000：每段 1200 行
   - 超过 15000 行的单文件：可能是几个 bundle 拼起来的，每段 1500 行；如果文件 > 5MB 用 python 兜底快速过一遍再精读关键段
3. **逐段读**：
   ```
   file_system({action:"read", path: localPath, offset: 1, limit: 1200})
   // 返回 endLine + hint，下次 offset = endLine + 1
   file_system({action:"read", path: localPath, offset: 1201, limit: 1200})
   ...
   ```

## 步骤 3：从每段里提取接口

每读完一段，**在脑子里**做以下还原（不要写脚本）：

### 识别 HTTP 客户端调用

混淆后常见形态：

```js
// axios / fetch 调用——找方法名 + URL 参数
.get("/api/u" + "ser/" + e)
.post(`/api/${t}/save`, n)
n.request({url: "/api/order/" + a + "/items", method: "PUT"})
$.ajax({type: "DELETE", url: "/api/admin/u/" + i})
A("/v1/auth", "POST", o)              // 内部封装函数，看上下文猜
```

要还原的两件事：
- **拼接还原**：`"/api/" + "u" + "ser"` → `/api/user`；`/api/${t}/save` 看 `t` 的赋值上下文（如果是常量串就还原，是 props 就 `{name}`）
- **方法判断**：明确的 `.get/.post/.put/.delete/.patch` 直接用；`{method: "X"}` 配置式也用；都没有就 `UNKNOWN`

### 识别路由表 / API 常量

```js
const E = {
  list: "/api/orders",
  detail: "/api/orders/",
  create: "/api/orders/new",
  delete: t => `/api/orders/${t}`
}
```

整张表里的所有字符串都是接口候选。这是 LLM 精读相对 python 最大的优势——python 正则不知道 `delete` 那行是模板。

### 识别框架元数据

```js
@RequestMapping("/api/admin")
@GetMapping("/users/{id}")     // 拼成 /api/admin/users/{id}
router.post("/api/login", ...)
```

类装饰器、`router.X` 注册、`Route` 配置——都要顺着上下文拼出完整路径。

### 跳过哪些

- 静态资源（`.js`/`.css`/`.png`/`.svg`/`.woff`/`.map`/`.ico`/`.jpg`）
- 三方域名（`https://cdn.foo.com/bar` 这种）
- 看起来明显是页面路径不是 API（`/login.html`、`/dashboard`，除非 SPA 的路由配置告诉你是 API）
- DOM 选择器、CSS class（`/main > .header`）

## 步骤 4：归一化 + 去重

入库前每条接口都要经归一化：

- 数字段 ≥ 2 位 → `{id}`
- UUID → `{id}`
- 末尾斜杠去掉
- query string 不入 pathTemplate

详见 `conventions` 子文档。

**本文件内**的所有候选攒到一个数组里，按 `(method, pathTemplate)` 去重；最后整批一起入库。

## 步骤 5：批量入库

```text
add_endpoints_batch({
  endpoints: [
    {
      method: "POST",
      pathTemplate: "/api/orders/{id}/items",
      source: "js_parse_llm",
      description: "来自 recon/js/0-3.js (LLM 精读 1201-2400 行) — request 配置式调用，url 由 a 参数拼接"
    },
    ...
  ]
})
```

- `source: "js_parse_llm"` 区分于兜底的 `js_parse_regex`
- `method` 能判断就填实际值，不能判断填 `UNKNOWN`
- `description` 必带：哪个 JS 文件 + 大致行号区间 + 怎么识别出来的（拼接/路由表/装饰器/...）
- 单批 ≤ 500 条；超出让主 Agent 再细切 jsAssets 区间

## 步骤 6（可选）：python 兜底

整批 LLM 精读完成后，**如果**怀疑还有遗漏（例如一个超大 bundle 行数很多但你只精读了一半），再跑一次 python 正则地毯式扫。这一步是补充，不是替代。

```python
import re, json, pathlib

API_HINTS = ('/api', '/v1', '/v2', '/service', '/gateway', '/bff', '/rest')
STATIC_EXT = ('.js', '.css', '.png', '.svg', '.woff', '.map', '.ico', '.jpg')
PATH_RE = re.compile(r'["\'`](/[A-Za-z][\w/${}\-.]{3,})["\'`]')

def normalize(p: str) -> str:
    p = re.sub(r'/\d{2,}(?=/|$)', '/{id}', p)
    p = re.sub(
        r'/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?=/|$)',
        '/{id}', p,
    )
    return p[:-1] if p != '/' and p.endswith('/') else p

results = []
for js_path in BATCH:
    text = pathlib.Path(js_path).read_text(encoding='utf-8', errors='ignore')
    for m in PATH_RE.finditer(text):
        p = m.group(1)
        if any(p.endswith(ext) for ext in STATIC_EXT): continue
        if not any(h in p for h in API_HINTS): continue
        line_no = text.count('\n', 0, m.start()) + 1
        results.append({'path': normalize(p), 'sourceFile': js_path, 'lineNo': line_no})

# 与 LLM 已入库的 (method=UNKNOWN/_, pathTemplate=path) 去重——只补 LLM 没找到的
# 入库时 source="js_parse_regex"，description 注明"python 兜底"
```

- 兜底入库的 `source` 一定要标 `js_parse_regex`，方便后续审计区分质量
- 主 Agent 看到两类 source 的接口就知道哪些更可靠（LLM 精读 > 兜底）

## 反模式

- ❌ 默认就 python 批量提取——会漏掉所有混淆/拼接/路由表里的接口
- ❌ 一次 read 整个 1MB 的 JS——`limit` 不指定时上限是 2000 行，超过会被截断；混淆 JS 经常一行几万字符（压缩到一行），totalLines 看着很小但实际全文在第 1 行
- ❌ 把 JS 全文塞回主 Agent 让主 Agent 提取——子 Agent 的角色就是把脏活包掉
- ❌ 跳过归一化直接把 `/api/user/12345` 入库——和 `/api/user/67890` 会变成两个不同接口
- ❌ 单条 add_endpoint 入库——浪费 tool 调用配额

## 一行就是整个 bundle 的特殊处理

混淆 + 压缩后 `webpack` / `terser` 经常把整个文件压成 1-3 行，每行几十万字符。这种情况下：

- `totalLines` 会很小（< 10），但 `size` 很大（> 500KB）
- 直接 read 第 1 行就能拿到全部内容，但内容塞不进 context
- 应对方式：先看 size，超过 200KB 时**直接 python 兜底过一遍拿到候选清单**，然后用 grep/sed 把候选周围 ±500 字符的片段切出来再让 LLM 精读
- 这是 python 主导的少数场景之一
