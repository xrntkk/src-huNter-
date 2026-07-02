---
name: src-web-vuln
description: SRC Web 漏洞验证编排器。主 Agent 接到一批接口后按特征切片到多个漏洞家族桶，并行 spawn 子 Agent 独立验证。子 Agent 凭自身安全知识自主决定测什么、怎么测，本技能只设定行为红线与报告标准，不束缚测试思路。详细策略在子文档渐进式披露。
when_to_use: 接到"对这批接口测漏洞 / 验证某接口是否存在 X 漏洞"类任务时，主 Agent 用本技能做切片 + 并行 spawn。
---

# SRC Web 漏洞验证方法论 (并行分类探索版)

**核心思想**：把"对一批接口测漏洞"这个任务从"主 Agent 串行试每个 payload"转成"按漏洞家族切片，每片一个 sync 并行子 Agent"。每个子 Agent 只负责一类漏洞 + 一组接口，凭自身安全知识（SQL 注入、IDOR、SSRF、越权等它都懂）自主选择测试方法与 payload，**本技能不提供逐条规则、不束缚测试思路**。主 Agent 只负责切片、调度、汇总。

## 设计哲学

- **不束缚 AI 的测试思路**：不提供"先做 A 再做 B"的步骤化 checklist，子 Agent 自主决定测什么、怎么测
- **只设定行为边界与报告标准**：红线（最小侵入 / 一次一变 / 取证标准）+ 漏洞严重度分级 + finding 字段要求
- **AI 自主决定测试范围**：子 Agent 在自己负责的漏洞家族内，可自由发挥其安全知识，不被固定 payload 字典限制

## 角色

- **主 Agent (orchestrator)**：拉 list_endpoints → 按"分类信号矩阵"把接口分配到 N 个桶 → 同一轮里 sync 并行 spawn N 个 `exploit-verify` 子 Agent → 等全部返回后汇总报告。**不要自己直接发 payload。**
- **子 Agent (exploit-verify ×N)**：每个只负责一类漏洞 + 一组接口；凭自身安全知识对每个接口最小化探测，发现就 add_finding，结束时返回简短摘要。需要具体 payload 时可调 `query_knowledge` 查本地语料库。

## 工作流总图

```
list_endpoints → 切片到 N 桶 → spawn × N (sync 并行) → 等齐 → 汇总
```

每一阶段细节散在子文档：
- 切片策略与信号矩阵 → `load_skill('src-web-vuln', subPath='dispatch')`
- 子 Agent prompt 模板 → `load_skill('src-web-vuln', subPath='subagent-prompt')`
- 行为红线 + 取证标准 + 报告格式 → `load_skill('src-web-vuln', subPath='conventions')`
- 各漏洞分类的快速诊断信号汇总 → `load_skill('src-web-vuln', subPath='category-signals')`

## 漏洞家族分桶（默认 6 类）

每个桶对应一个 sync 子 Agent。子 Agent 的 prompt 里只需告诉它"你这桶要测哪类漏洞 + 拿到的接口列表"，**无需指定要 load 哪些 skill**——子 Agent 自带安全知识。

| 桶 | 漏洞家族 | 典型信号 |
|----|---------|---------|
| 1 | **鉴权 / 越权 / JWT** | 路径含 ID、Authorization: Bearer、admin 路径、redirect_uri |
| 2 | **业务逻辑 + 并发** | 参数含 price/qty/discount、有领券/转账/提现 |
| 3 | **注入家族** | 参数被反射、报错含 SQL、模板片段 `{{`/`${`、shell 分隔符触发 |
| 4 | **SSRF / XXE / 协议** | 参数为 URL、Content-Type=xml、走 CDN/反向代理 |
| 5 | **文件 / 路径** | 上传接口、参数为文件名/路径、可访问 .git/.svn |
| 6 | **客户端 / 协议 + 信息泄露** | 跨域+cookie、跳转参数、debug 端点、未授权内网服务 |

> 桶并非互斥：同一接口可能进多个桶（一个 ID 接口既可能 IDOR 也可能 SQLi）。让多个子 Agent 各自试，比让单个 Agent 串行试便宜。
>
> 如目标含 AI 功能（chat/completion/agent），追加第 7 桶 **AI/LLM**：prompt 注入、Agent 攻击链、function calling 滥用。

## 切片守则（主 Agent 必读）

1. **必须用 sync 模式 spawn_agent**：禁止使用 `mode: 'async'` 或 `mode: 'fork'`。
   - sync = 阻塞模式：spawn 后父 Agent 必须等子返回，期间不能做任何其他操作（不能再 list_endpoints、不能 http_request、不能 add_finding）。
   - async/fork = 后台模式：父会立即继续干活，破坏"等齐 → 汇总"的契约。
   - 同一轮发多个 sync spawn 会自动并行，**不需要**为了并行换 async。
2. **spawn_agent 同批不要混入其他工具**：spawn_agent 那一轮里**只放 spawn_agent 调用**。
3. **同一轮发出所有 sync spawn**：要并行就一定一次发 N 个 spawn_agent 调用，分散到不同轮就退化成串行。
4. **每桶接口数 ≥ 3**：否则启动开销 > 实际工作。如果某桶只有 1~2 个接口，合并到信号最接近的另一桶。
5. **桶不得超过 8 个**：太多并发反而争抢浏览器/网络资源。默认就用上面 6 桶模板（AI 桶可选）。
6. **每桶给出的接口列表 ≤ 15 个**：超过就同类切片再起一个子 Agent（如"鉴权-A"、"鉴权-B"）。
7. **不在主 Agent 上下文里复述完整接口列表**——通过 prompt 传 endpointId 数组，子 Agent 用 list_endpoints 自己取详情。
8. **守门**：所有 sync 子 Agent 都返回后再进入汇总阶段；如果某个子 Agent 失败/超时，可以重 spawn 一次同类接管。

## 完成报告

所有子 Agent 返回后，主 Agent 用 `list_endpoints` + findings 总结：
1. 各桶产出 finding 数量与严重度分布
2. 高危漏洞（critical / high）逐条复述：endpoint + 一句话 impact
3. 推荐进一步深挖的方向（如某桶发现 IDOR，建议横向枚举更多 ID 类接口）
4. 未发现漏洞但仍可疑的接口（响应异常但不足以定性的）

## 不要做的事

- 不在主 Agent 一边 spawn、一边自己也发 payload —— 角色冲突
- 不让子 Agent spawn 子 Agent —— spawn_agent 已禁递归
- 不在 prompt 里粘大段 payload 字典 —— 子 Agent 自带知识，需要时自己查
- 不为了"全覆盖"把所有漏洞类型塞进一个子 Agent —— 按桶切分才并行高效
