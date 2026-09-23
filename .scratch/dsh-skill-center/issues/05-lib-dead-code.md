# 05 — lib 侧死代码与无用参数清理

Status: needs-triage
Severity: Optional
Area: `lib/`

全部经 `grep` 核对：下列符号在**产品代码**里没有任何读取点。删除前请按 `code-review-and-quality` 的要求逐条确认（尤其是「仅测试使用」的那几个，它们可能是刻意的 API 面）。

## 完全无引用（连测试都没有）

| 符号 | 位置 |
|---|---|
| `SkillStateStore#categories()` | `lib/store.js:87-89` |
| `SkillStateStore` 的 `get file()` | `lib/store.js:61-63` |

## 仅测试引用（产品路径不用）

| 符号 | 位置 | 引用它的测试 |
|---|---|---|
| `SkillStateStore#categoryOf(name)` | `lib/store.js:79-81` | `test/categories.mjs:246-247`（产品用 `lib/index.js:100` 的自由函数 `categoryOf(state, name)`） |
| `findParentId` | `lib/categories.js:122-132` | `test/categories.mjs:92-94,159,188`（client 侧另有自己的 `parentIdOf`，见下） |
| `countCategories` | `lib/categories.js:150-154` | `test/categories.mjs:96,218` |
| `flattenCategories` | `lib/categories.js:285-292` | `test/categories.mjs:102`（client 侧另有 `flattenTree`） |
| `categoryPath` | `lib/categories.js:300-311` | `test/categories.mjs:100-101` |
| `parseBoolean`（导出） | `lib/frontmatter.js:84-89` | 内部 `:74` 已在用；导出只为测试 |

`collectIds`（`lib/categories.js:139`）虽然只被测试与 `removeCategory`（`:224`）使用，但内部确实在用，**保留**。

## 无用参数（签名在骗读者）

| 位置 | 问题 |
|---|---|
| `lib/sources.js:263` | `describeSources(configured, defaults, libraryDir, importedNames)` 的函数体从不读 `libraryDir`，而 `lib/index.js:255` 认真地把 `host.libraryDir` 传了进去 |
| `lib/sources.js:236` | `collect(file, root, state, skills, invalid)` 的函数体从不读 `state`，而 `lib/sources.js:204/223` 每次都传 |

## 重复调用

`lib/index.js:73-74`：
```js
const store = new SkillStateStore(path.join(root, 'state.json'), loggerOf(ctx))
const log = loggerOf(ctx)
```
`loggerOf(ctx)` 调了两次（`lib/index.js:600-606`）。先取 `const log = loggerOf(ctx)`，再传给 store。

## 说明：为什么 host/client 两侧各有一套树函数

`lib/categories.js` 的 `findParentId`/`flattenCategories` 与 `client/client.js` 的 `parentIdOf`/`flattenTree`/`treeRows`/`findNode`（`1863-1958`）是重复实现。这是模块系统边界造成的：host 侧是 ESM，client 侧是只允许 `react`/`react-dom`/`dsh-client-ui-primitives` 三个外部模块的 CJS factory（README:239），客户端无法 import host 代码。**不建议合并**——本 issue 只要求删掉 host 侧无人使用的部分，让「哪一侧是唯一实现者」这件事在代码里说得通。

## 验收

- 删除后 `npm test`（六个文件）保持全绿；若某符号决定保留，请在本 issue 的 Comments 里写明保留理由。
