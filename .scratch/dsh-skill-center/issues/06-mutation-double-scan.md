# 06 — 每次写操作对技能库做两遍全量扫描

Status: ready-for-agent
Severity: Optional
Area: `lib/index.js`

## 现象

一次写请求会走两遍 `scanLibrary`：

1. `applyMutation` 的 `skills.enabled` / `skills.category` 先调 `knownNames`（`lib/index.js:469-477`）→ `host.describe()`（`:92-103`）→ `scanLibrary`（`lib/library.js:47-76`）。
2. `handleMutate` 再调 `host.snapshot()`（`:291`）→ `describe()` → `scanLibrary` **第二遍**。

`scanLibrary` 每个技能是 `readdir` + `readFile` + `stat`（`lib/library.js:86` 的 `Promise.all`）再加 frontmatter 解析。

## 量化

设技能库 N 个技能，一次开关点击 = `2 × (1 readdir + N readFile + N stat + N 次 frontmatter 解析)`。

- N=100 → 约 400 次系统调用 + 200 次解析；N=500 → 约 2000 次系统调用 + 1000 次解析。
- `skills.import` 更重：除收尾那次 `scanLibrary` 外，还要 `scanSource` 整个来源目录（上限 4000 项 / 2000 技能，`lib/sources.js:27-33`），逐条 `readSkillFile`。
- README:71 提到的市场缓存（6600+ 技能）一旦被加成来源，这个规模就在可达范围内。

而这两遍扫描里的**技能数组内容是相同的**：`skills.enabled` / `skills.category` / `categories.*` / `sources.*` 都不碰磁盘上的技能文件，只有 `store` 的内存状态变了（`lib/store.js:99-128`、`:150-245`，`#save` 是 temp+rename 原子写）。

## 修法

把「扫描」与「组装」拆开，一次请求只扫一遍：

- `describe()` 拆成 `scan = () => scanLibrary(libraryDir)` 与 `compose(scanResult, state)`；
- `knownNames(names, scanResult)` 复用同一次扫描；
- `handleMutate` 对**不碰文件**的 action 复用该扫描结果，对 `skills.create` / `skills.uninstall` / `skills.import` 在写后重扫一次（这几条本来就必须重扫）。
- `GET /library` 保持每次重扫——这是刻意设计（`lib/index.js:207-217` 解释了为什么扫描同时要 `invalidate`），不要引入跨请求缓存，否则手工放进库的技能又会不可见。

## 验收

- 一次 `skills.enabled` 请求只发生一次 `scanLibrary`（可在测试里计数 `readdir`/`readFile` 调用，或给 `describe` 注入一个计数器）。
- `GET /library` 仍然每次重扫；`skills.uninstall` 之后返回的快照里该技能确实消失（防止复用陈旧扫描）。
- 现有 88 项检查全绿。
