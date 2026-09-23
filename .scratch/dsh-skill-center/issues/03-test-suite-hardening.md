# 03 — 测试套件硬化：一个恒真断言、两处静默降级、若干未覆盖的安全/边界路径

Status: ready-for-agent
Severity: Optional
Area: `test/`

88 项检查在本机全绿（smoke 13 / categories 22 / sources 14 / client-smoke 7 / client-render 23 / host-integration 9）。以下按「绿了但并不代表它声称的意思」排序。

## 3a 恒真断言（必修）

`test/sources.mjs:369`：
```js
assert.equal(sources[1].label, 'no path' === sources[1].label ? 'no path' : sources[1].label, 'an explicit label should be kept')
```
右侧恒等于 `sources[1].label`，断言即 `x === x`。更糟的是 fixture（`:360`）里那条是 `{ id: 'keep', path: path.join(root, 'other') }`——**没有 label**，所以这句想覆盖的 `lib/store.js:320`「显式 label 被保留」分支实际零覆盖（真实值是 `'other'`）。
**修法**：fixture 改成带 `label: '显式名'` 的条目，断言写成字面量 `'显式名'`。

## 3b 静默降级为「绿」

- `test/host-integration.mjs:141-144`：找不到 `@deepseek-ai/*` 时打印 skipped 并 `process.exit(0)`——唯一真正的注册表集成在瘦环境里报绿却零断言（文件头已声明这是有意为之；本机确实跑了 9 项）。
- `test/client-smoke.mjs:232-235`、`274-277`：`dsh-context` 或 primitives 不在时只打印一行就 `return`，「入口在兄弟项之上」与 primitives 名称核对这两条断言随之消失（本机都执行了，没有打印 skipped）。
**修法**：至少让跳过在汇总行里以 `skipped N` 计数出现，或在这些检查项上要求显式环境变量才允许跳过。

## 3c 断言的是测试自己的常量

`test/client-render.mjs:596-598`：在标题为「though the host still reports them」的检查里断言 `SNAPSHOT.skills.find(...)`——`SNAPSHOT` 是测试自带的 fixture，证明不了 host 侧任何事。

## 3d 两个 `every()` 缺长度前件

`test/smoke.mjs:405`、`474`：`every()` 在空数组上恒真。当前相邻断言恰好保证集合非空，但前件一被改动就静默失效。

## 3e 未覆盖、且能藏真 bug 的路径

| 未覆盖 | 位置 | 静默放行的 bug |
|---|---|---|
| `handleMutate` 500 兜底 | `lib/index.js:292-303` | 任何非 `LibraryError` 的失败（如 `#save` 拒绝）行为无约束 |
| `store.#save` 失败与写链 | `lib/store.js:290-300`（含 `298` 的 `catch(() => {})`） | 「enable 了但没落盘」这类用户真正会报的问题 |
| `readJsonBody` 三条路径 | `lib/index.js:561-575`：非法 JSON、空 body、`MAX_BODY_BYTES` | 上限被删（无界缓冲）或降到比粘贴的正文还低，都能过 |
| `categories.move` 端到端 | `lib/index.js:371-374` | client 侧发了（`client-render.mjs:880/910/933`），host 侧没有任何测试驱动过；case 名拼错、`parentId`/`index` 映射丢失都发现不了 |
| 跨界字段名 | 两侧各自 pin 自己的字面量 | `categoryId` → `category` 这类重命名两个套件都绿 |
| `handleSources` 405/500、`handleRead` HEAD、provider `signal.aborted`、`get()` 的 ENOENT/invalid → `undefined`、`sources.js` 的 `MAX_SKILLS` 上限与 `collect` 的非 `InvalidSkillError` 分支 | `lib/index.js:118/134/140-143/223/248-260`、`lib/sources.js:213/251` | 对应分支被删或写错都不报警 |
| client 页级错误态 / footer 错误行 / sources 加载失败 / `readJson` 非 JSON | `client/client.js:720/1090-1109/1520-1521/1980-1985` | 空白或没有标题的错误面板照样绿 |

`client-render.mjs:419-423` 还把 `skipped` 写死成 `[]`，所以客户端渲染 skipped 原因的那段（`client.js:1646-1649`）从未执行。

## 3f 已知但可接受的局限（记录，不必改）

`client-render.mjs` 自带 Mini-React（`:59-180`）：hook 顺序错乱不会像真 React 那样抛错；嵌套组件由测试自己展开（`:495-503`）且不跑它们的 effect；`P.*` 是透传 Proxy，primitive 的 prop 契约不可验证；`createPortal` 是恒等映射、`addEventListener` 是空实现，所以「更多」菜单、Escape 分层、focus、树面板开关在套件里是死代码。断言普遍是 `className.includes(...)` 与内联 style 字符串，布局与 CSS 只按文本正则核对（`client-smoke.mjs:223-229`）。`host-integration.mjs:134-136` 用固定 `setTimeout` 等 fiber。这些是「没有浏览器时能做到的上限」，写在这里是为了让后续读者知道边界在哪，而不是要求补测。

## 真正覆盖得好的部分（不是客套）

技能名路径护栏有单元 + HTTP 两层（`categories.mjs:349-362` 覆盖 `'../escape'`/`'..'`/`'a/b'`/`'a\\b'`/`'Upper'`/`''`/`'dot.name'`/`42`，`smoke.mjs:462-463`）；`skills.import` 的 `overwrite: true` 有端到端覆盖（`smoke.mjs:544-549`）与 bundle/flat 形态互换（`sources.mjs:234-244`）；损坏 `state.json` 的备份与恢复被断言（`smoke.mjs:274-288`）；400/404 四类错误映射都有（只差通用 500）；`host-integration.mjs` 用真 Cordis + 真 `SkillRegistry` 验证了延迟 `webServer` 注入、手工放入的技能经 API 读一次就进真目录、以及 toggle 真的让真注册表缓存失效。

## 验收

- 3a 修掉后应能覆盖 `store.js:320` 的 label 分支（改坏该分支测试必须变红）。
- 3e 逐项补测，或在本 issue 的 Comments 里写明为何不补。
