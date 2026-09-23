# 01 — 写接口没有同源/鉴权围栏，跨站请求可驱动不可逆卸载

Status: ready-for-agent
Severity: Critical
Area: `lib/index.js`（HTTP 路由）

## 现象

`lib/index.js:164-188` 用 `webServer.register` 注册三条 exact 路由，handler 直接进入 `handleRead` / `handleSources` / `handleMutate`，**没有任何请求围栏**。同一台 server 上，harness 自己的 `/api` 与每个兄弟插件都先调用 `connection.requestRejection(req)`。

## 证据

- 围栏本体 `@deepseek-ai/dsh-client-connection/lib/index.js:553-556`：
  ```js
  requestRejection(request) {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
    return this.browserAuth.isAuthenticated(request) ? void 0 : 401
  }
  ```
  `isTrustedApiRequest`（同文件 `201-215`）要求 Host 是 loopback/trusted、拒绝 `sec-fetch-site: cross-site`、并要求 Origin host 等于 Host。三项 skill-center 全无。
- 兄弟插件都过了这道关：`dsh-host-open-in-app/lib/index.js:1316-1323`（`rejected()`，三条路由开头全用）、`dsh-client-connection/lib/index.js:768-781`（自己的 `/api` 路由）。
- 本插件 `package.json` / `lib/index.js:47` 的注入表只有 `['skills']`，`webServer` 还是可选注入（`lib/index.js:164`），从未注入 `connection`。
- `webServer` 本身不提供任何鉴权：`dsh-host-webserver/lib/index.js:228-259`，`handle()` 匹配到 exact 路由后直接 `await route.handler(req, res)`，只多一层 gzip。

## 实测（跨站请求被接受）

临时脚本挂载真实 `apply()`，按 `WebServer.match` 的方式分发路由，发一条**跨站简单请求**（`origin: https://evil.example`、`sec-fetch-site: cross-site`、`content-type: text/plain`，不触发预检）：

```
status            : 200
skill still there : false
body              : {"libraryDir":"C:\\...\\skill-center\\library",...
RESULT: CROSS-SITE REQUEST ACCEPTED — the skill was uninstalled from disk
```

一次跨站 POST 就删掉了磁盘上的技能。`skills.uninstall` 不可逆（README「卸载」、`CONTEXT.md`「卸载」）。

## 影响面

- 不可逆删除：`skills.uninstall`。
- 任意内容写入技能库：`skills.create`、`skills.import`（含 `overwrite`）。
- 目录探测：`sources.add` 可登记任意已存在目录，`GET /sources` 回读其技能名、描述、相对路径与被拒原因（`lib/sources.js:263-293`）。
- 任何本机用户态进程都能直接调用该 API；浏览器侧可达性取决于浏览器的私有网络策略，但围栏存在的意义正是让这个判断不再必要。
- README:193 宣称「同源、回环地址专用」——**已宣称但未实现**的性质。

## 修法

1. `ctx.inject(['webServer', 'connection'], (hostCtx) => ...)`，与兄弟插件一致。
2. 三条 handler 开头统一 `if (rejected(req, res)) return`，`rejected` 照抄 `dsh-host-open-in-app` 的实现。
3. `connection` 缺席（headless 组装）时**不注册**这三条路由，而不是退化成无围栏注册。
4. 纵深防御（不替代第 2 步）：`POST` 要求 `content-type: application/json`，否则 415——简单请求连预检都过不去。

## 验收

- 新测试：`origin: https://evil.example` + `sec-fetch-site: cross-site` 的 POST 必须 403 且技能仍在磁盘；无 cookie 的同源 POST 必须 401。
- 现有 88 项检查保持全绿。

## Comments

**已实现，未提交**（仓库不是 git 仓库；按用户决定留给 issue 08 处理 `git init` 与二进制归置）。

修法四条全部落地：

1. `lib/index.js` 路由载具改为 `ctx.inject(['webServer', 'connection'], …)`。
2. 新增 `fenceOf(ctx)`（读 `requestRejection`，写入拒绝状态并返回「已答复」），挂在 handler bag 的 `fence` 上；`handleRead` / `handleSources` / `handleMutate` 首句统一 `if (host.fence(request, response)) return`。命名统一为「围栏 / fence」（`CONTEXT.md` 新增该术语）。
3. `connection` 缺席时不注册任何路由——由 inject 依赖集保证，不再退化成无围栏注册。
4. `POST /mutate` 要求 `content-type: application/json`（可带参数），否则 `415`；在读取 body 之前挡掉。

验收：

- 跨站 `403` 且技能仍在磁盘：`test/smoke.mjs`（假围栏，`readdir` 复核）+ `test/host-integration.mjs`（**真 `HostConnectionService`**，只有 `browserAuth` 是替身，`stat` 复核）；另覆盖了仅 Origin 不同源（无 `sec-fetch-site` 标记）的变体。
- 无 cookie 同源 `401`：两个套件都有；`host-integration` 另覆盖读路由。
- 88 项全绿且净增 8 项：`npm test` → 17 + 22 + 14 + 7 + 23 + 13 = **96 passed, 0 failed**。

`/code-review` 双轴结论：Spec 轴无阻塞项（四条修法 + 两条验收均已实现且可复现）；Standards 轴提出的命名不统一、术语未入 glossary、测试替身复制策略造成漂移风险、README 覆盖描述不同步，均已修掉。

已知未处理（低优先级，均有归属）：

- `host-integration.mjs` 在找不到 `@deepseek-ai/*` 时 `exit 0` 跳过，因此 `npm test` 可能在全绿的情况下从未跑过真围栏检查——issue 08 已列此条（要把跳过变成显式失败或固定 `DSH_PACKAGES`）。
- `fenceOf` 每请求解引用 `ctx.connection`，teardown 与在途请求竞争时会抛 TypeError 而非答 403/401；与兄弟插件 `dsh-host-open-in-app` 同形，未偏离宿主现有写法。
