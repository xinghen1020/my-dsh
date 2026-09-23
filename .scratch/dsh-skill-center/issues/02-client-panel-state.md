# 02 — client 面板状态机三处缺陷（竞态 / 错误串道 / 空库闪现）

Status: ready-for-agent
Severity: Optional
Area: `client/client.js`（`Panel`）

三处都在 `Panel` 的状态处理里，建议一次改完。

## 2a 请求无序：慢的读会覆盖新的写

`load()`（`client.js:448-456`）与 `mutate()`（`467-497`）都无条件 `apply_payload` / `setView`，没有序号保护。面板打开时自动 `load`，点「刷新」也会 `load`（`678-680`，`view.phase === 'loading'` 只禁用这一个按钮）。

**触发**：点刷新后立刻点某个开关 → GET 先发出、POST 后发出，若 GET 后到，它带回的是写之前的快照，开关会自己弹回去，用户读作「点了没反应」。
**修法**：`const seq = useRef(0)`，`load`/`mutate` 各自开头 `const mine = ++seq.current`，写状态前 `if (mine !== seq.current) return`。

## 2b 写失败被塞进读错误通道，且不会过期

`client.js:482-485`：
```js
} catch (error) {
  const message = messageOf(error)
  setView((prev) => ({ ...prev, error: message }))
```
`view.error` 同时是读失败的通道：footer（`720`）直接显示它。于是任何一次写失败（重复分类名、拖到非法目标）都会在 footer 留下一条以「无法读取技能库」语境呈现的错误，直到下一次成功的 `apply_payload` 把它清成 `null`。
`renderList` 的全屏错误态（`1090`）有 `view.phase === 'error'` 前置条件，`mutate` 不改 `phase`，所以在正常相位下 **不会**误触发全屏错误——只有在初始读失败后（phase 已是 `'error'`）继续操作工具栏，才会出现「读失败的标题 + 写失败的消息」。
**修法**：拆成 `readError`（只由 `load` 写）与 `writeNotice`（每次 mutate 开头清空、可关闭），`renderList` 的 1090 分支改读 `readError`。

## 2c `checked` 不随快照收敛

`apply_payload`（`437-446`）替换 `skills` 但不动 `checked`（`424`）。技能在面板外被删后，它仍留在选中集：计数（`846`）虚高，且批量操作会带上这个名字——host 的 `knownNames`（`lib/index.js:469-477`）对**整批**返回 404，于是「取消一个已消失的技能」会连带失败整批。
**修法**：在 `apply_payload` 内用新 `skills` 求交集后 `setChecked`。

## 2d 首帧闪现「技能库为空」

初始 `phase: 'idle'`（`420`），`load` 由 `useEffect`（`516-518`）触发，而 effect 在首次绘制之后才跑。`renderList` 只特判 `'loading'`（`1087`）与 `'error'`（`1090`），因此打开面板的第一帧会走 `1116-1122` 的 `t('empty')`——「技能库为空」。
**修法**：初始相位用 `'loading'`，或把 `'idle'` 并入 1087 的条件。

## 验收

- 新增测试覆盖：后到的 GET 不得覆盖已应用的 POST 快照；写失败后 `renderList` 的全屏错误态不出现（`readError` 为空）；`checked` 在快照丢失该技能后被清理；首帧不出现 `empty` 文案。
- `client-render.mjs` 的 23 项保持全绿。
