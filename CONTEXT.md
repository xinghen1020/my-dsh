# my-dsh

宿主机运行 DeepSeek Harness（dsh）的工程，以及在其上开发的插件（首个：`dsh-skill-center`）。本 glossary 记录 skill-center 相关的领域语言。

## Language

**技能（Skill）**:
一个含 `SKILL.md`（可带 YAML frontmatter）的目录，是模型和用户可调用的最小能力单元。
_Avoid_: 插件（plugin/bundle 指整个 dsh 扩展包，不是技能）

**技能库（Skill Library）**:
`~/.dsh/skill-center/library`，由 skill-center 独占治理的技能根目录；刻意与 dsh 原生扫描根（`~/.dsh/skills` 等）不相交，使库技能在宿主注册表的每个 scope 层都只有这一个来源。
_Avoid_: 用户库、installed dir、`~/.dsh/skills`（那是遗留默认根，仅作导入来源）

**影子提供者（Shadow Provider）**:
skill-center 注册的技能 provider：始终列出库内全部技能，但按启用状态在返回的候选上改写 invocation 标志。因库根与原生根不相交，它无同名竞争即天然唯一有效；rank 350 仅用于万一同名的层内优先级。
_Avoid_: 过滤提供者（暗示"不列出"，会让被禁技能漏回）

**导入（Import）**:
把其他来源（执行器目录、市场缓存等）的技能目录复制进技能库。复制后各来源副本互不影响。

**启用状态（Enablement State）**:
skill-center 外部存储中每个技能的开/关记录；**禁用 = 模型与用户界面均完全不可见**。不写入技能文件的 frontmatter。
_Avoid_: 模型可见性治理（skills-management 的术语，语义不同——它只对模型隐藏）

**工作区覆盖（Workspace Override）**:
按工作区（canonical 路径为键）对单个技能的三态设置：启用 / 禁用 / 跟随全局；未覆盖时以全局启用状态为准。
_Avoid_: 工作区开关（暗示与全局无关的两层模型）

**工作区（Workspace）**:
dsh Web UI 中添加的目录工作区：`{id, path, title, sessionIds}`；会话以其 header 的 cwd canonical 路径归属工作区。

**卸载（Uninstall）**:
把技能目录从技能库移除的操作；不可逆。与启用状态无关——禁用中的技能同样可卸载。
_Avoid_: 删除（旧 UI 文案）

**来源（Source）**:
可导入技能的外部目录（如各 coding agent 的技能目录、市场同步缓存）。只读，不参与启停治理。

**分类（Category）**:
用户组织技能的树形容器（同构于收藏夹文件夹）：分类可嵌套，每个节点有稳定标识与名称；每个技能严格归属一个分类（**单父**），移动即改归属。纯组织性元数据：只用于 Web UI 的呈现与导航，**不影响**模型侧可见性或调用——影子 provider 对其无感知。删除分类 = 删除其整棵子树，受影响技能全部回落**未分类**；重命名只改节点名称，不触及技能归属。
_Avoid_: 分级（暗示有序等级）；标签（暗示每技能可挂多个）；扁平列表（旧模型，已废弃——树形单父取代之）；模型可见性治理（分类与启停治理正交）

**未分类（Uncategorized）**:
分类树中固定的虚拟容器，收纳未归属任何分类的技能；不可删除、不可建子级，始终可见。
_Avoid_: 默认分类（它不是可分配的值，而是缺省归属的呈现）

**围栏（Fence）**:
技能中心 HTTP API 的请求准入判定，由宿主 `connection` 服务的 `requestRejection` 给出：Host 非回环/受信地址、带 `sec-fetch-site: cross-site`、或 Origin 与 Host 不同源 → `403`；判定通过但浏览器会话无效 → `401`。**它不是技能中心自己的策略**——技能中心只保证每条路由都先过这道关，并且在无围栏可问时不注册路由（不退化成无围栏注册）。
_Avoid_: 鉴权（只覆盖会话那一半，且暗示本插件自造了判断）；守卫（同一概念的第二套说法）
