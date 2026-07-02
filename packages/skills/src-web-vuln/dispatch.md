# 切片策略 (dispatch)

> 主 Agent 拉到 list_endpoints 后，怎么决定每个接口进哪个桶。

## 输入

- `list_endpoints` 全量结果，带 method / path / params / 响应特征 / source
- 用户额外提示（如"重点看 admin 类"、"先打金钱相关"）

## 输出

```json
{
  "buckets": [
    {
      "id": "auth-idor",
      "family": "鉴权/越权",
      "endpointIds": [12, 14, 15, 17, 22, 30]
    },
    ...
  ]
}
```

> 不再需要 `skillsToLoad` 字段——子 Agent 凭自身安全知识测试，无需预加载专题 skill。需要具体 payload 时子 Agent 自行调 `query_knowledge` 查语料库。

## 信号 → 桶映射规则

按以下顺序匹配，**先匹中先归桶**（同接口可进多个桶但优先看主特征）：

```
1) 鉴权/越权 (auth-idor)
   - path 含 {id} / 数字段，且接口需要登录访问
   - path 含 admin / manage / internal / backend
   - 响应里出现别人的 PII 字段时
   - 同一资源有 list / detail / update 多动词

2) JWT / OAuth (auth-jwt)
   - request header 有 Authorization: Bearer 三段
   - path 含 oauth / authorize / token / callback / sso
   - response 有 access_token / refresh_token

3) 业务逻辑/并发 (logic-race)
   - body 字段含 price / amount / qty / discount / coupon / balance / quota
   - path 含 transfer / withdraw / refund / order / pay / coupon / signin / lottery

4) 注入家族 (injection)
   - 任意 GET 参数能在响应中反射
   - 错误信息含 SQL/stack trace
   - 参数名典型 search / q / filter / sort / orderBy
   - body 含 SQL/HQL/CQL 类查询字段
   - 含 ${} / {{}} 类模板片段

5) SSRF / XXE (ssrf-xml)
   - 参数值是 URL：?url= ?image= ?webhook= ?proxy= ?callback=
   - Content-Type 含 xml / soap / svg
   - 上传 / 导入"远程地址"

6) 文件/路径 (file-path)
   - multipart/form-data 上传接口
   - 参数为文件名/路径：?file= ?path= ?template= ?lang= ?download=
   - 提供文件下载/预览

7) 客户端协议/信息泄露 (client-info)
   - 跨域 + 带 cookie（CORS）
   - 跳转参数 ?next= ?redirect= ?return=
   - Host 头反射在响应里
   - 任何接口（兜底）：扫一遍 /.git/HEAD /actuator /swagger /debug /.env
```

## 切片算法（伪代码）

```ts
function dispatch(endpoints) {
  const buckets = new Map<string, Endpoint[]>()
  for (const ep of endpoints) {
    const tags = matchSignals(ep) // 一个接口可能匹中多个 tag
    for (const t of tags) {
      buckets.get(t)?.push(ep) ?? buckets.set(t, [ep])
    }
  }
  // 太小的桶（<3）合并到主特征最接近的相邻桶
  for (const [k, v] of buckets) {
    if (v.length < 3) {
      const fallback = nearestNeighbor(k)
      buckets.get(fallback).push(...v)
      buckets.delete(k)
    }
  }
  // 太大的桶（>15）按子特征切两半，编号 -A / -B
  for (const [k, v] of [...buckets]) {
    if (v.length > 15) {
      const [a, b] = splitByFreq(v) // 按 path 前缀 / method 二分
      buckets.delete(k)
      buckets.set(k + '-A', a)
      buckets.set(k + '-B', b)
    }
  }
  return buckets
}
```

## 用户偏好覆盖

如果用户明确指定"只看 X"，直接降桶数到 1~2 个：
- "测越权" → 只生成 auth-idor 桶 + auth-jwt 桶
- "测注入" → 只生成 injection 桶

## 切片完成后的最低必要日志

主 Agent 在 spawn 之前，**用一行打印每个桶的 (id, 接口数)**，方便人工 review 切片是否合理。然后立即并发 spawn，不要在中间穿插其他工具调用——会丢失并行性。
