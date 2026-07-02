# 行为红线与报告标准 (conventions)

> 主 Agent 与子 Agent 都必须遵守。这部分定义行为边界与报告标准，**不定义具体漏洞测试规则**——子 Agent 凭自身安全知识自主决定测什么、怎么测。

## 设计哲学

本文件不束缚 AI 的测试思路，只设定：
1. **行为红线**：什么不能做（最小侵入 / 不破坏数据）
2. **取证标准**：finding 必须自包含，复审者无需回放整个会话即可判定
3. **报告格式**：字段要求 + 严重度分级

AI 自身具备丰富的安全知识（SQL 注入、IDOR、SSRF、越权等），不需要逐条规则指导。让它自主决定测什么、怎么测。

## 三条不可越界红线

### 1. 最小侵入
- **不删除数据**：不调 DELETE / DROP / clear 类接口，哪怕看似无害（unbind / cancel）
- **不修改密码 / token / 关键配置**
- **不污染他人订单 / 关注关系 / 评分**
- 写操作优先用废弃 ID 或自有账号
- 如必须写：测试金额 0.01、测试金钱测完立刻退回 / 取消

### 2. 证据优先
每个 finding 必须自包含，复审者不需要回放整个会话即可判定。包括：
- 完整请求（method / path / 关键 header / body）
- 完整响应（状态码 / 关键 header / body 关键片段）
- 复现步骤（≤ 3 步）
- 一句话 impact（不要写"可能存在风险"）

PII 字段写报告时脱敏：
- 手机号 `138****1234`
- 邮箱 `x***x@example.com`
- 身份证只留前 6 末 4

### 3. 一次一变
每次只改一个变量（参数 / header / 方法），不然出现差异时无法定位是哪一变量触发的。

如要组合，先单独验证每个变量再组合。

## add_finding 必填字段

| 字段 | 要求 |
|-----|------|
| endpointId | 受测接口 ID |
| type | idor / sqli / ssrf / xss / ssti / cmdi / xxe / upload / lfi / csrf / cors / open-redirect / smuggling / jwt / oauth / logic / race / info-disclosure / 401-403 / deserialization / prompt-injection / agent-attack |
| severity | critical / high / medium / low |
| evidence | 请求 + 响应原文 |
| repro | 复现步骤 |
| impact | 一句话写清能造成什么具体后果 |

## 严重度参考

| 级别 | 样例 |
|------|------|
| critical | 直接 RCE / 拿到他人完整 PII / 任意写入 / 资金可被盗 / cloud key 泄漏 |
| high | 普通用户拿到管理员视图 / 存储型 XSS / SQLi 可拖部分表 / 已可绕权限 |
| medium | 反射型 XSS / 信息泄露但需结合其他漏洞 / 突破限制但未直接获利 |
| low | 状态异常 / 仅泄漏存在性 / OPTIONS 暴露方法 |

## 一接口多漏洞的优先级

按"高危 + 易验证 + 低噪音"排序，子 Agent 在桶内对每接口的测试顺序：

1. 未授权 / IDOR（一个 GET 即可，极易复现）
2. 业务逻辑 / 价格篡改（高危但要懂业务）
3. SSRF（指向 cloud metadata 即拿密钥；只验证存在性）
4. SQLi / 命令注入 / 反序列化（直拿数据/RCE）
5. 存储型 XSS（持久危害）
6. 上传 / 目录穿越（链到 RCE）
7. CSRF / 反射 XSS / 开放跳转（需要诱导）
8. 信息泄露（捡漏）

> 这只是优先级建议，不束缚测试思路。子 Agent 可根据接口特征自主调整顺序。

## 取证执行守则

- 时间戳记录每个关键请求的发送时间，便于复盘并发漏洞
- 响应里包含真实他人数据时，保留 1~2 条做证据，不批量拖库
- 截图含敏感字段时直接打码再保存
- 每次会话结束时 list_findings 自查一遍，没补全的字段补全

## 不要做的事

- 不递归 spawn 子 Agent（已禁）
- 不大批量自动扫描生产环境（特征明显 + 易被 ban）
- 不上 sleep ≥ 30 秒的高延迟盲注（DOS 风险）
- 不用 cloud key 调用任何写接口（哪怕 iam:GetUser，云日志会留 trace）
- 不用 Redis CONFIG SET、SAVE（破坏目标数据）
- 不在 SSRF 验证完成后继续打内网纵深
- 不写 webshell / cron / authorized_keys 落地（除非授权）
