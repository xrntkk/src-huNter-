# 漏洞分类信号速查 (category-signals)

> 主 Agent 切片时用，子 Agent 在桶内做二次细分时也用。**只提供"信号 → 漏洞类型"的映射，不规定具体测试方法**——子 Agent 凭自身知识自主决定怎么测。

## 鉴权 / 越权 / JWT

| 信号 | 大概率漏洞 |
|------|----------|
| path 含 `{id}` / `userId` / `orderId` / `fileId` / `uuid` | IDOR / 越权 |
| `?include=user` / `?expand=...` / `?fields=*` | 字段过滤泄漏 |
| 同接口可匿名访问，仅 header / cookie 区分身份 | 鉴权缺失 |
| `Authorization: Bearer <三段串>` | JWT 攻击 |
| 普通用户访问得 403 的管理路径 | 路径绕过 / BFLA |
| OAuth 跳转链路 (`redirect_uri`、`state`、`code`) | OAuth 配错 |
| 涉及实名 / 风控 / 反欺诈 | 流程绕过 |

## 业务逻辑 / 并发

| 信号 | 大概率漏洞 |
|------|----------|
| 字段含 price / amount / discount / coupon | 金额篡改 |
| 多步骤流程（下单 → 支付 → 发货） | 状态机绕过 |
| 同动作可重复触发收益 | 限制绕过 / 并发竞态 |

## 注入家族

| 信号 | 大概率漏洞 |
|------|----------|
| 参数反射在响应体（HTML/JS/JSON） | XSS |
| `'` 触发 500 / 错位 / `SQLSTATE` 报错 | SQLi |
| `{{7*7}}` 渲染为 49、`${T(...)}` 反射 | SSTI / 表达式语言 |
| 参数走到 shell 工具（ping/host/convert/pdf） | 命令注入 |
| cookie/参数 base64 含 `rO0`、`aced`、`O:8:`、`pickle`、含 `${jndi:...}` | 反序列化 / JNDI |

> NoSQL/XSLT/CSV/CRLF/类型混淆/原型链污染/EL 注入等：命中相应信号时，凭你的安全知识自主设计 payload。

## SSRF / XXE / 协议层

| 信号 | 大概率漏洞 |
|------|----------|
| 参数为 URL：`?url=` `?image=` `?proxy=` `?webhook=` | SSRF |
| Content-Type 含 `xml`、SOAP、SVG、Office Open XML | XXE |
| 走 CDN/反向代理（`Server`、`Via`） | 请求走私 |

> DNS 重绑定 / Host 头攻击 / HTTP2 / WebSocket / 缓存欺骗：凭你的知识自主测试。

## 文件 / 路径

| 信号 | 大概率漏洞 |
|------|----------|
| `multipart/form-data` 上传 | 上传漏洞 |
| 参数为路径：`?file=` `?template=` `?lang=` `?download=` | LFI / 路径穿越 |
| 提供文件下载 / 预览 | LFI |
| 接受 `.git/` `.svn/` 路径 / 命中泄露 | 源码泄露 |

## 客户端 / 协议层

| 信号 | 大概率漏洞 |
|------|----------|
| 表单提交不带 CSRF token / 跨域请求带 cookie | CSRF |
| Origin 反射在 ACAO，且 ACAC: true | CORS 配错 |
| 跳转参数 `?next=` `?redirect=` `?return=` | 开放跳转 |

> Clickjacking / CSP 绕过 / dangling-markup / HPP / CRLF：凭你的知识自主测试。

## 信息泄露 / 未授权 / 兜底

| 信号 | 大概率漏洞 |
|------|----------|
| 任何 web app | 兜底扫：/.git /actuator /swagger /debug /.env /.DS_Store |
| 错误响应回显堆栈 / SQL 报错 / 路径 | 信息泄露 |
| OPTIONS / HEAD 返回敏感数据 | 信息泄露 |
| 内部端口 6379/9200/11211/8080 暴露 | 未授权服务 |
| GraphQL `/graphql` 接受 introspection | GraphQL 信息暴露 |

## AI / LLM 类（如目标含 AI 功能）

| 信号 | 大概率漏洞 |
|------|----------|
| 接口含 `chat` / `completion` / `prompt` | Prompt 注入 |
| Agent 类 / function calling / RAG / MCP | Agent 攻击链 |

## 子 Agent 桶内细分流程

子 Agent 收到一桶接口后，按上面信号矩阵做"二次匹配"，凭自身知识自主选择 payload 与测试方法：

```
for endpoint in bucket:
  signals = matchSignalsLocal(endpoint)
  for sig in signals:
    凭你的安全知识选择最可能命中的测试向量
    发送请求，对比响应判定
    命中即 add_finding
```

不需要 load 任何专题 skill——你自身已具备这些安全知识。需要 payload 字典时调 `query_knowledge`。
