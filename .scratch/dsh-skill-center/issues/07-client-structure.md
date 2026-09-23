# 07 — client 结构：对话框分支链、死分支与死字典键

Status: needs-triage
Severity: Optional
Area: `client/client.js`

## 规模事实（用于判断，不是抱怨）

`client/client.js` 共 2004 行：CSS 模板 119 行（`61-179`）、zh/en 字典 174 行（`182-357`）、其余逻辑约 1711 行。其中：

- `apply()` 占 `366-1302`（约 937 行）；`Panel` 一个组件占 `418-1302`（约 885 行），内含约 570 行 `render*` 闭包（`734-1301`），仅 `renderTree` 就约 170 行；
- `renderDialog` 是一个 419 行的自由函数（`1347-1765`）：7 个 `if/else` 分支处理 8 个 `dialog.kind` 值，共享 4 个可变累加变量 `title` / `primaryLabel` / `danger` / `run`（`1358-1362`）；
- `TextField` / `TargetPicker` 定义在**唯一调用点之后**约 1000 行（`1777`、`1801`），文件因此读起来是一条长卷轴。

**平台约束**（已核实，不是懒）：客户端 bundle 就是「每包一个文件」——`dsh-client-modules/lib/index.js:655` 从 `exports["./client"]` 解析唯一路径，`:213` 以 `/plugins/<id>/client.js` 提供；拆成 ES 模块需要构建步骤，而README:239 明确把「没有构建步骤」当作设计前提。所以下面的修法都是**文件内**的分解。

## 结构性修法（按收益排序）

1. **`renderDialog` → 按 kind 的显式分发表。** 每个 kind 一个条目 `{ title(t, dialog), primary(t), danger, fields(dialog, ctx), submit(ctx) }`，共享一个 shell 渲染器（现有的 `1733-1764`）。8 分支链与 4 个可变累加变量一起消失；新增一种对话框不必再改一长串 `else if`。
2. **`renderTree` / `renderList`（含 `renderFolderRow` / `renderSkillRow` / `renderMeta`）提成真正的组件**，接收 props，而不是闭包捕获十来个状态值。顺带解决「每行都递归走一遍分类树」：把 `flattenTree(categories)` 与 `Map<id, node>` 在 `Panel` 里 `useMemo` 一次传下去，现在 `flattenTree` 被调 3 次（`560`、`815`、`1808`）、`findNode` 被调 5 处（`557`、`579`、`1297`、`1369`、`1467`），其中 `1297` 在 `renderMeta` 里**每个可见行每次渲染都要走一遍树**。
3. **三处 drop 收尾逻辑提成一个 `useDropTarget(onDrop)`**：`944-951`（未分类）、`1005-1025`（树行）、`1153-1164`（文件夹行）都在重复 `event.preventDefault(); const payload = dragPayload.current; dragPayload.current = null; setDropTarget(null); if (payload === null) return`。
4. **删掉死分支与死字典键。** 已用 `grep` 核对：以下键在 zh/en 两侧都定义了但没有任何 `t('key')` 读取——`library`（`197`/`286`）、`lockedTarget`（`205`/`294`）、`selectAll`（`222`/`311`）、`results`（`225`/`314`）、`dropHere`（`246`/`335`）、`importSkills`（`250`/`339`）、`importFailed`（`267`/`356`）；再加 `previewSkill`（`245`/`334`），它唯一的读取点在 `previewText` 的 `preview.kind === 'skill'` 分支（`1968`），而**没有任何地方构造 `{ kind: 'skill' }`**——技能行没有 `onMouseEnter`，而树行（`1035`）与未分类行（`952`）都有。共 8 键 × 2 语言 = 16 条字符串。
   同样地，被注释掉的 invocation chip 块（`1289-1295`）与 `dropHere` 时代的注释（`243-246`）应移到 README 或 issue 里，而不是留在渲染路径上。
5. （可选）把 CSS 模板与 `zh`/`en` 字典移到文件顶部之后的一个独立区块，让「这个文件里哪些是逻辑」一眼可见——两者合计 293 行，占 15%。

## 判断点

文件规模（2004 行）是 `code-review-and-quality` 里「单文件约 1000 行」检查信号的两倍。要么按上面 1+2 做一次分解，要么在 README 的「已知限制与范围」里明确写下「单文件是平台约束下的自觉取舍」——两者都比现在「事实存在但没人说」要好。

## 验收

- 行为不变：`client-render.mjs` 23 项 + `client-smoke.mjs` 7 项全绿（这正是这两个套件存在的意义）。
- 死字典键删除后 zh/en 仍然严格对称（测试里已有对称性检查可复用）。
