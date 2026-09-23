# dsh-skill-center

DeepSeek Harness 的技能中心：在侧边栏左下角、**「设置」正上方**放一个入口，点开是一个**左右两栏**的居中弹窗——左边是**分类树**、右边是该分类下的技能列表，用来组织技能库、批量启用/禁用，并把其他工具目录（如 `~/.claude/skills`）里的技能**复制**进来。

界面形态仿照 **Edge 收藏夹管理器**（`edge://favorites`）。领域词汇（技能库、影子提供者、启用状态、分类、未分类等）以仓库根目录的 [`CONTEXT.md`](../../CONTEXT.md) 为准，本文只讲这个插件怎么用、怎么实现的。

## 入口位置

| 项 | 值 |
|---|---|
| 席位 | `sidebar.footer.action`（list slot），`order: 9` |
| 面板 | `shell.overlay`（layout 的 root 级 list slot） |

侧边栏外壳的底部是 `footArea`（column）里的 `footerActions` → `settingsArea`，所以 `footer.action` 的每个条目都落在「设置」上方。宽栏渲染图标 + 文字，56px 轨道栏只渲染图标。弹窗走 `react-dom` 的 portal 挂到 `document.body`，不受侧边栏 56px 几何的限制。

**这个席位是「单行 nowrap flex row」**，这一条决定了实现细节，也踩过一次坑：

- `footerActions` 只声明了 `display:flex`，没有 `flex-wrap`，所以**多个条目默认挤在同一行**。dsh-context 的「上下文洞察」（同席位，`order: 10`）把宽度声明成 `calc(100% + 4px)`，于是**任何与它同行的条目都会被压成 0 宽**——第一版正是这样：本插件用 `flex:1`（即 `flex-basis:0%`），被压成 0×42 的透明空块。
- 修法是两层：**本插件的按钮按宽度定尺寸、完全不写 `flex`**（镜像 `lc-ov-entry` 的 `width/height/margin/padding`）；同时给容器补上 `flex-wrap:wrap`，让每个全宽条目各占一行。容器的 class 是构建期哈希的（`hHd-Xa_footerActions`），所以用结构性选择器定位它——渲染器给每个 slot 的 outlet 锚点带一个稳定的 `data-slot` 属性：

  ```css
  div:has(> div[data-slot="sidebar.footer.action"]) { flex-wrap: wrap }
  ```

- **顺序靠 `order`，不靠注册顺序**：`order: 9` 排在「上下文洞察」（10）之前，于是本插件是它正上方那一行。`order` 相等时由注册顺序裁决（而注册顺序取决于 profile 的 bundle 列表），所以**刻意不与它打平**；`test/client-smoke.mjs` 会读已安装的 dsh-context 来断言这一点。
- **这个席位不用 `Tooltip`**：Tooltip 会在锚点外再包一层，而行内尺寸是按条目自身盒模型量的。改用原生 `title`，与同席位既有实现一致。

## 界面与交互

| Edge 收藏夹 | 本插件 |
|---|---|
| 左侧文件夹树（只放文件夹） | 分类树：`未分类` 固定在首行，其后是用户分类，可展开/折叠、按层级缩进 |
| 右栏列出**所选文件夹的直属子项** | 只列该分类的直属技能；子分类以「文件夹行」出现在列表里，点击进入 |
| 书签行：复选框 + 图标 + 名称 + URL | 技能行：复选框 + 技能图标 + 名称 + 描述 + 状态 |
| 行内 `×` 删除 | 行内垃圾桶 = **卸载**（先弹确认） |
| 工具栏：添加收藏夹 / 添加文件夹 / 更多 | 新建技能 / 新建分类 / 更多（展开全部、折叠全部、重命名、删除） |
| 顶部搜索：全库 | 全库搜索（跨所有分类，命中项标注所属分类，离开当前选中分类） |
| 悬停行时左下预览卡 | 悬停树节点时底部预览条显示「分类 · 名称」 |
| 拖拽 | 拖技能行到分类/文件夹行/未分类上即归类；拖分类节点到另一分类上即成为它的子分类 |

其余交互：

- **分类拖拽会标出不能放的地方**：拖动某个分类时，它自己、它整棵子树、以及「未分类」（分类永远不能有子级）都会变暗且不接受投放。所以"没地方可放"是**看得见**的，而不是放下后什么都没发生。左下提示条在拖动期间会说明当前手势的作用。
- **放到当前父级上会明说**：这类投放本来就不改变任何东西，此时底栏显示「它已经在这个分类下了」——否则一次无变化的投放看起来就像拖拽坏了。
- **分类也有「移动到…」**：右键分类 → 移动到…，可选**顶级**或任何分类（本节点及其子树不会出现在列表里）。这条路径不依赖拖拽——树很小、没有合法可拖目标时也能用。
- **批量条常驻**：标题行下面是固定的批量条（启用 / 停用 / 移动到… / 卸载 / 取消选择）。没勾选时整条按钮禁用并显示「已选 0」，而不是整条消失——批量操作只在这里，藏起来就只能靠碰运气发现。
- **多选**：勾选任意行后批量条变可用；拖动一个已勾选的行会带上**整个选择**。
- **未分类只收技能**：把技能行拖到树上的「未分类」即移出分类；拖分类节点过去不接受（有变暗提示）。
- **右键菜单**：分类节点上是 新建子分类 / 重命名 / **移动到…** / **移到顶级**（只对嵌套节点显示）/ 删除分类；技能行上是 移动到… / 启用-停用 / 卸载。之所以要有「移到顶级」：分类唯一的拖放目标是另一个分类，那只会让它嵌得更深，没有这个入口嵌套就是单向门。
- **两种「移动到…」的第一项不同**：技能的列表首项是**未分类**（技能只有「在某个分类里」或「不在任何分类里」）；分类的列表首项是**顶级**（对分类而言"不在任何分类里"就是放在顶层，没有"未分类"可言）。
- **新建技能**收集四样东西：技能名称、描述、**正文（Markdown，可留空）**、**归入分类**（默认就是当前正在看的分类，可改）。正文留空会写入一段占位正文。
- **确认框**：卸载与删除分类都先弹确认。卸载框会逐个列出将被删除的技能名（超过 8 个显示「等 N 项」）与技能库路径；删除分类框说明技能会回落到「未分类」而**技能本身不会被删**。
- **失败不吞掉**：对话框里的操作被宿主拒绝时（重名、名称非法、分类已消失……），**对话框保持打开**并在按钮上方显示原因，已输入的内容也保留——不会关掉对话框把错误埋到面板底栏。
- **Escape 逐层退出**：先关对话框，再关右键菜单，最后才关面板。
- 分类节点可用键盘 Tab 聚焦、Enter/Space 选中。

## 导入（从其他目录复制技能）

工具栏的**「导入」**按钮打开一个对话框：选来源 → 勾技能 → 选归入分类 → 导入。

**导入就是复制。** 复制完成后源目录与库内副本互不影响：改源不会改库，改库不会动源，源目录从头到尾只被读、从不被写。bundle 是**整目录复制**（`references/`、`scripts/`、`assets/` 一起走），因为技能正文会按相对路径引用它们。

### 默认来源

按本机实际情况选定，都是用户级目录（数量小、扫描便宜）：

| 来源 | 路径 | 布局 |
|---|---|---|
| Claude Code | `~/.claude/skills` | `<name>/SKILL.md` |
| Codex | `~/.codex/skills` | `.system/<name>/SKILL.md`（嵌一层） |
| agents 共享 | `~/.agents/skills` | `<name>/SKILL.md` |
| dsh 用户技能 | `<DSH_HOME>/skills` | `<name>/SKILL.md` |

市场缓存（`~/.dsh/skills-management/market/skills`，6600+ 技能）**故意不做默认来源**：它又深又大，每次开对话框扫一遍代价太高。需要时在对话框里「添加来源目录」把路径加进去即可（见下）。

### 发现规则

- 深度上限 4 层，**含 `SKILL.md` 的目录就是一个技能，不再往下走**（它自己的 `references/` 是内容，不是更多技能）。
- 跳过 `.git`、`node_modules` 和其余点开头目录，但**保留 `.system`** —— Codex 的技能就放在那里。
- 平铺 `<root>/<name>.md` 只认**根目录一层**，与技能库自身的布局规则一致。
- 上限保护：4000 个目录项 / 2000 个技能，超出即停止并在对话框里标注「结果已截断」。
- 缺 `description` 或名字非法的条目**列出来但不可导入**（技能库和原生 provider 都会丢弃这种技能，导进来只会立刻消失）。

### 导入规则

- **按「有效名」落盘**：frontmatter 的 `name` 优先，缺省用目录名。所以库里不会出现一个目录名和catalog 报告的名字不一致的技能。
- **同名默认跳过**，并在结果里列出原因；**「覆盖同名技能」勾上后才会替换**（会删掉库里那份，包括你对它做过的本地修改——所以默认不开，并且重新勾选后需要重新选技能）。
- **批量是逐项结算的**：一个重名不会让整批失败，结果行会写「已导入 N · 已跳过 M: name (原因)」。
- 导入后可继续留在对话框里换来源再导；已导入的技能立即标上「已存在」，模型侧也同时可见（导入会走一次注册表失效）。

### 自定义来源

来源行的最后一个 chip 是 **`+ 添加来源目录`**，点开才出现路径输入框——它就挨着其它来源，而不是藏在可滚动对话框的最底部。

- **路径按你实际会输入的样子接受**：`~` / `~/...`（以及 Windows 的 `~\...`）会展开成主目录；**外面包着引号也会被去掉**，因为资源管理器「复制文件地址」给出来的就是带引号的 `"C:\dir"`。相对路径仍然拒绝。
- **必须在磁盘上真实存在**，否则当场报错——一个拼错的路径不会被记下来变成一个永远禁用、没人能解释的灰 chip。（先判「这是不是内置来源」，所以即使 `<DSH_HOME>/skills` 还不存在，加它也只是回答"已经是来源了"。）
- 路径会**持久化**到 `state.json` 的 `sources` 里，重启仍在；只有自定义来源才显示「移除来源」（移除只删记录，绝不动目录）。
- 路径等于某个内置来源时不做记录——内置来源本来就一直在，记一条影子记录只会多出一个删不掉的条目。
- 项目级的 `.claude/skills` 也走这里：服务端没有「当前项目」这个概念，所以由你明确给出路径。

例：把原 skills-management 留下的市场缓存（6600+ 技能）加进来

```
~/.dsh/skills-management/market/skills
```

它又深又大，因此不在默认列表里；加进来后受 4000 项 / 2000 技能的上限保护，超出会标注「结果已截断」。

### 边界

浏览器**只发来源 id 和技能名**，从不发路径、更不发文件路径；服务端拿这两个值回到它自己刚跑的那次扫描里查，路径全部由服务端推出。技能名只用于查表，**永远不会被拼进路径**（所以 `../escape` 会被当作「这个来源里没有这个技能」而不是被当成路径）。目录路径只在「添加来源目录」这一个入口出现，且经过上面的校验。

## 技能库

默认根目录 `<DSH_HOME>/skill-center/library`（`DSH_HOME` 缺省为 `~/.dsh`）。

刻意与 dsh 原生扫描根（`<DSH_HOME>/skills`、项目根、`customSkillDirs`）**不相交**，因此库里不存在与其它 provider 同名的竞争，rank 只用于同层排序。

目录布局与原生 provider 一致，只扫描一层：

- 目录 bundle：`library/<name>/SKILL.md`
- 平铺文件：`library/<name>.md`

frontmatter 沿用原生约定：必填 `name`（小写 kebab-case）与 `description`，可选 `whenToUse`、`disable-model-invocation`、`user-invocable`。解析失败或字段非法的条目**不参与目录**，但会作为 warning 出现在面板底栏，不会让整个列表失败。

## 分类（层级）

分类是**纯组织性元数据**：只用于浏览器侧的呈现与导航，**不影响模型侧可见性或调用**——影子提供者根本看不到它，注册表候选里也没有这个字段（`test/host-integration.mjs` 会断言这一点）。启停治理与分类正交。

- **树形、单父**：每个技能严格归属一个分类（`categoryId`），移动即改归属。
- **未分类**是固定虚拟容器，不可删除、不可建子级，始终在树的首行；它在文档里不是一个节点，而是「没有 `categoryId`」。
- **删除分类 = 删除整棵子树**，其中所有技能回落到未分类；**重命名只改节点名**，因为技能指向的是稳定 id。
- 节点 id 由宿主侧生成（`crypto.randomUUID()`），浏览器只引用。
- 嵌套上限 8 层；移动会拒绝把节点放进自己的子树（否则遍历不再终止）。

## 启用状态

- **不写进技能文件的 frontmatter**：技能文件是技能自己的，启停是技能中心的。
- **未记录 = 启用**。导入或手工拷进库的技能立即可用，不需要第二步。
- **禁用 = 模型与用户调用面都关闭**：影子提供者把该候选的 `invocation` 改写成 `{ modelInvocable: false, userInvocable: false }`。这与原生 `disable-model-invocation`（只对模型隐藏）语义不同。
- 反方向不成立：技能文件自己声明 `disable-model-invocation: true` 时，即使技能中心里是启用，模型面仍然关闭——技能中心能收回一个技能，但不会放宽作者已关闭的接口。
- **界面暂时不展示这两个调用面标记**：行里只显示启用/停用，不再显示「对模型隐藏 / 不可手动调用」。数据没有删——快照里每一行仍然带 `modelInvocable` / `userInvocable`，把 UI 加回来就是 `renderMeta` 里那两行（源码里有注释标着）。

## 状态文档

`<DSH_HOME>/skill-center/state.json`：

```json
{
  "version": 3,
  "categories": [
    { "id": "8f1c…", "name": "工具", "children": [
      { "id": "2a94…", "name": "运维", "children": [] }
    ] }
  ],
  "skills": {
    "code-review-and-quality": { "enabled": true, "categoryId": "8f1c…" },
    "ci-cd-and-automation": { "enabled": false }
  },
  "sources": [
    { "id": "9d02…", "label": "work", "path": "D:\\work\\.claude\\skills" }
  ]
}
```

- **v2 → v3 自动迁移**：读旧文档时只补 `categories: []` 与版本号，`skills` 原有的启停记录原样保留；所有技能一开始都在「未分类」。真正落盘发生在下一次写入。
- **加载时消毒**（`lib/categories.js` 的 `sanitizeTree`）：没有可用名字的节点丢弃、缺失或重复的 id 重新生成、超过 8 层的嵌套截断、解析不到的 `categoryId` 清空、非布尔的 `enabled` 丢弃。手工编辑或截断的文件会降级成可用状态，而不是让面板起不来。
- `sources` 同样会消毒：路径缺失或为空的条目丢弃、同一目录（按平台大小写规则比较）只留一条、缺 id 的补一个、label 缺省用目录名。
- **未知的顶层键与未知的每技能键原样保留**；写入是原子的（临时文件 + rename）且串行；文件损坏时先备份成 `state.json.corrupt-<时间戳>` 再以默认值启动，绝不静默丢数据。
- `categories` 现在是**被建模**的字段，不再原样透传：非法节点会被修复或丢弃。

## 卸载与新建技能

- **卸载**：`library/<name>/`（整棵 bundle 目录）或 `library/<name>.md`，同时清掉它的启停与分类记录。**不可逆**，所以浏览器侧一律先确认。幂等——已经不存在时报告「什么都没删」而不是报错，这样批量卸载可以重试。
- **路径防护**：所有破坏性/创建性文件操作都过 `skillPaths()`，它正向校验「解析出的父目录必须就是技能库本身」，并强制 kebab-case 名称。`../escape`、`a/b`、`Upper`、`dot.name` 一律拒绝——名字是来自浏览器的不可信输入。
- **新建技能**：在 `library/<name>/SKILL.md` 写一个骨架，头两栏进 frontmatter（`name` + `description`），正文栏进正文，再归入所选分类。几点：

  - `description` 为空时写入占位文案而不是留空——因为本插件（和原生 provider）都会丢弃没有 description 的技能，留空会让刚建好的技能立刻从目录里消失。
  - 正文留空时写入一段占位正文，同样不会产生空文件。
  - 正文会做换行统一（CRLF → LF），并且**去掉开头的一段 frontmatter**：对话框已经有专门的两栏管头部，否则把整份 `SKILL.md` 粘进正文栏会留下第二个头。
  - 同名（无论 bundle 还是平铺文件）都拒绝。

## 影子提供者

以 provider 名 `skill-center`、`source: 'custom'`、rank `350` 注册进 `ctx.skills`。

它**始终列出库内全部技能、从不过滤**，只依据启用状态改写候选上的 invocation 标志。这一点是刻意的：如果被禁用的技能从目录里消失，面板就既看不到它、也无法把它重新打开。模型侧之所以看不到禁用技能，是因为 `dsh-tool-skill` 在消费边界按 `isModelInvocable` 过滤。

目录内容或启停发生变化时通过注册时拿到的 `control.invalidate()` 通知注册表（任何写入之后、以及每次读取快照时都会调用）。

## HTTP API

同源、回环地址专用，由 `webServer` 注册。**每条路由都先过宿主 `connection` 服务的 `requestRejection` 围栏**：Host 不是回环/受信地址、带 `sec-fetch-site: cross-site`、Origin 与 Host 不同源 → `403`；围栏通过但浏览器会话无效 → `401`。围栏就是本插件对可达性的全部判断，不额外放宽也不再自造第二套规则。

这两个服务缺一不可：**`connection` 缺席（headless 组装）时三条路由都不注册**，而不是退化成无围栏注册。`webServer` 缺席时补丁仍加载，只是没有浏览器侧入口。

`POST /mutate` 另要求 `content-type: application/json`（可带参数），否则 `415`——这类请求是连预检都过不去的跨站 simple request，在读取 body 之前就挡掉，属纵深防御，不替代围栏。

三个端点：一个读快照，一个来源列表，一个命令分发器。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/dsh-skill-center/api/library` | 返回 `{ libraryDir, categories, skills[], warnings[] }`，并让注册表缓存失效 |
| `GET` | `/dsh-skill-center/api/sources` | 返回 `{ sources[] }`：每个来源的名称、路径、是否存在、技能（含 `imported`）、被拒条目与截断标记 |
| `POST` | `/dsh-skill-center/api/mutate` | body `{ action, ... }`，执行后返回**同一份刷新过的快照** |

`action` 一览：

| action | 参数 | 说明 |
|---|---|---|
| `skills.enabled` | `names: string[]`, `enabled: boolean` | 批量启停 |
| `skills.category` | `names: string[]`, `categoryId: string \| null` | 批量归类；`null` = 未分类 |
| `skills.uninstall` | `names: string[]` | 批量卸载（不可逆） |
| `skills.create` | `name`, `description?`, `body?`, `categoryId?` | 建骨架并归类；`body` 为 Markdown 正文，可留空 |
| `skills.import` | `sourceId`, `names: string[]`, `categoryId?`, `overwrite?` | 从来源复制技能；返回 `{ imported[], skipped[] }` |
| `sources.add` | `path`, `label?` | 记录一个自定义来源目录（绝对路径） |
| `sources.remove` | `id` | 移除自定义来源记录（不动目录） |
| `categories.create` | `name`, `parentId: string \| null` | 建分类 |
| `categories.rename` | `id`, `name` | 重命名 |
| `categories.delete` | `id` | 删除子树，技能回落未分类 |
| `categories.move` | `id`, `parentId`, `index?` | 改父级/排序 |

错误语义：围栏拒绝 → `403`（非同源/非回环）或 `401`（无有效浏览器会话）；`POST` 未声明 JSON → `415`；非 `GET`/`POST` → 405；body 非法、未知 action、非法分类名、非法技能名、非法来源路径（相对路径或指向技能库）、路径越界 → 400；`skills.enabled` / `skills.category` 指向库里不存在的技能、或 `skills.import` 指向不存在的来源 → 404。响应统一带 `cache-control: no-store`。

## 安装

```bash
dsh plugin --profile web add link:D:/workspace/my-dsh/plugins/dsh-skill-center
```

`dsh plugin` 转发给 pnpm 安装，然后按**已安装状态**对账 `dsh.profile.bundles`：因为本包的 `package.json` 声明了 `dsh.bundle.patch`，它会自动加入 profile 的层栈。

**装完必须重启 `dsh web`**——宿主插件树（loader 层栈）只在启动时组装；软链安装，之后改动不必重装。

改**客户端**代码的循环要短一些：实测宿主在每次渲染 index 时会重新读取 bundle 字节，所以 `client/client.js` 的改动**刷新页面即可生效**（无需重启）。改 `lib/`（宿主侧）仍然必须重启。这个差异没有文档承诺，遇到刷新无效就按重启处理。

卸载：

```bash
dsh plugin --profile web remove dsh-skill-center
```

## 开发

零运行时依赖：宿主侧只 import Node 内建模块与相对文件（插件以 junction 链入 profile，真实路径在仓库里，任何第三方依赖都会解析不到）；浏览器侧只向宿主的冻结平台模块表 `require('react' | 'react-dom' | '@deepseek-ai/dsh-client-ui-primitives')`，所以**没有构建步骤**，`client/client.js` 就是源码。

六个测试都是纯 Node，不需要 dsh 进程（`npm test` 依次跑完）：

```bash
node test/smoke.mjs             # 宿主侧：frontmatter / 扫描 / state / provider / HTTP 端点（含导入与请求围栏）
node test/categories.mjs        # 分类树纯函数 + 卸载与新建的文件操作（含路径越界防护）
node test/sources.mjs           # 来源发现（嵌套/隐藏目录/上限）+ 复制的语义与冲突处理
node test/client-smoke.mjs      # 浏览器侧：vm 里跑 bundle，断言两个席位、顺序、primitives 名称
node test/client-render.mjs     # 浏览器侧：用迷你 React 运行时真的渲染面板并驱动点击
node test/host-integration.mjs  # 真 Cordis + 真 SkillRegistry 里挂载本插件
```

两处值得说明：

- `client-render.mjs` 自带一个小 React 运行时（够用的 hook 语义，能支撑 state 更新触发的重渲染），把 `fetch` 换成录制桩，然后**从渲染出的元素树里取出真实的 handler 来点击**。所以它断言的是行为——「点这个开关会发出这条命令」「卸载先弹框、框里点名、确认后才发请求」——而不是结构。这是在不能开浏览器时唯一能验证渲染路径的办法：拼错的 primitive、宿主没传的 prop、接错的处理函数都会在这里暴露。
- `host-integration.mjs` 会从 `realpath(process.execPath)` / `PATH` / 各 nvm 版本目录自动定位已安装的 `@deepseek-ai/*`（可用 `DSH_PACKAGES` 覆盖），找不到就跳过。它验证的是最接近「重启后是否生效」的事实：真 `ctx`、真 effect 形状校验、真 `ctx.inject`、真 `SkillRegistry` 合并目录、分类不泄漏进候选、卸载后技能从真目录里消失，以及 fiber 卸载后 provider 是否真的注销。围栏这层用的是**真的 `HostConnectionService`**（只有浏览器会话判定是替身），因此跨站 `403`、无会话 `401` 走的是宿主真实的 Host/Origin/`sec-fetch-site` 判断，而不是测试自己的一套。

## 已知限制与范围

- **没有工作区覆盖**：`CONTEXT.md` 里的「工作区覆盖」（按工作区三态设置）尚未实现。
- **导入不跟踪来源**：复制之后不再记得它从哪来，所以没有「检查更新 / 重新同步」这种东西——想更新就再导一次并勾上覆盖。源目录也不会被监视。
- **市场缓存不是默认来源**：它又深又大，需要时自己把路径加进来（加进来后受 4000 项 / 2000 技能的上限保护，可能被截断）。
- **状态在内存里缓存**：插件启动后自己读取一次 state.json 并以其为准。外部（另一个进程、手工编辑）改动要重启才可见——技能中心是这份文件的唯一写入方。多进程同时写会互相覆盖。
- **无 provider 级配置**：不声明 Cordis `Config`，因此 `cordis.yml` 不能改技能库路径；目前只认 `DSH_HOME`。
- **删除分类不提供撤销**：只弹确认，没有 Edge 那样的撤销栈。
- **库路径下没有文件系统 watcher**（库根与原生根不相交，原生 watcher 覆盖不到它）。打开面板或点「刷新」会重新扫描目录**并让注册表缓存失效**，因此手工放进库的技能会在模型下一步出现；但没有任何后台监听——不打开面板就不会自动同步。
