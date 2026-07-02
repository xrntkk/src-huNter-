# endpoint-prober 子 Agent 实操指南

主 Agent 在 prompt 中指定了 `pages-<i>.json` 文件 + 索引区间。你的工作：用浏览器访问每个页面，注入网络拦截器，触发主功能，把抓到的 XHR/fetch 用 `add_endpoints_batch` 一次性入库。

## 步骤

1. **`file_system read`** 父 Agent 指定的 `pages-<i>.json`，按索引区间筛出本批页面。
2. 对每个页面：
   1. **`browser_navigate`**（`waitUntil=networkidle`）
   2. **`browser_evaluate`** 注入网络拦截器（见下方代码）
   3. **`browser_click`** 触发主功能（最多 5 个安全按钮），或 `browser_fill` + 提交
   4. **`browser_evaluate`** 读 `window.__capturedRequests`，提取同站接口
3. **攒齐整批后** `add_endpoints_batch` **一次性入库**（`source="network_intercept"`）

## 网络拦截器代码

每访问一个新页面就注入一次：

```js
window.__capturedRequests = [];

const _f = window.fetch;
window.fetch = (...a) => {
  try {
    window.__capturedRequests.push({
      type: "fetch",
      url: String(a[0]),
      method: (a[1]?.method) || "GET",
      body: a[1]?.body || null
    });
  } catch (e) {}
  return _f.apply(this, a);
};

const _o = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (m, u) {
  this.__m = m;
  this.__u = u;
  return _o.apply(this, arguments);
};

const _s = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (b) {
  window.__capturedRequests.push({
    type: "xhr",
    url: this.__u,
    method: this.__m,
    body: b || null
  });
  return _s.apply(this, arguments);
};
```

## 触发策略

页面打开后页面本身可能已经发了一些 XHR（比如 `GET /api/me`）。除此之外要主动触发：

- 优先点击表面的"主功能"按钮：搜索、加载更多、提交、保存、查询
- 表单页：`browser_fill` 填合理的最小数据（邮箱用 `test@test.test`、密码用 `test1234`），然后提交
- **跳过**：登出、删除、密码重置、支付确认这类破坏性按钮
- 单页最多触发 5 个动作，避免无穷点击

## 安全护栏

- 不点删除 / 登出 / 转账 / 付款类按钮
- 不提交可能产生外发邮件的表单
- 出现验证码就放弃该页面继续下一页（不要尝试绕过）

## 入库规范

```text
add_endpoints_batch({
  endpoints: [
    {
      method: "GET",
      url: "https://target.com/api/me",
      pathTemplate: "/api/me",
      source: "network_intercept",
      description: "来自页面 /account/dashboard 触发"
    },
    ...
  ]
})
```

- **批量提交**：一次入库整批，不要每个接口单独调一次工具
- **归一化路径**：见 `conventions` 子文档
- **去重**：同 method + 同 pathTemplate 在本批内只入一次
