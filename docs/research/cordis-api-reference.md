# Cordis API 参考（dsh 调研笔记）

> 调研日期：2026-09-20。来源：deepseek-ai/deepseek-harness 官方仓库 docs/（分支 master）。
> 所有 API 签名均照抄文档原文（`ts cordis-catalog` 围栏内的生成声明）；出处一律指向 GitHub blob URL。本笔记是"地图 + 速查"，需要完整参数表时请回原始文档。

## cordis-api/ 目录地图（每篇讲什么、何时查）

目录 `docs/cordis-api/` 共 6 个主题（多数有 `.zh.md` 中文版），另有 4 个 `.i18n.yaml` 配对元数据文件（读者无需关心）。其中 `inherited.md` **只有英文版**，且为生成文件（`scripts/gen-cordis-catalog.ts`），未提供 `.zh.md` 对侧。

| 文件 | 讲什么 | 何时查 |
|---|---|---|
| [context.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/context.md) / [context.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/context.zh.md) | 上下文（Context）：核心对象，所有服务、事件、生命周期 API 都通过 `ctx` 访问；`extend`/`isolate`/`intercept` 三个派生子上下文方法，静态 symbol 键，底层服务存储方法 `get`/`set`/`provide`/`accessor`/`mixin` | 想知道 `ctx.*` 有哪些方法、子上下文如何作用域化时 |
| [events.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/events.md) / [events.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/events.zh.md) | 事件分发 API：`parallel`/`emit`/`serial`/`bail`/`waterfall` 五种分发方法 + `on`/`once` 注册 + `EventOptions`/`DispatchMode` 类型 | 写事件监听器或分发器、需要确定分发语义时 |
| [fiber.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/fiber.md) / [fiber.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/fiber.zh.md) | Fiber：已加载插件实例，生命周期状态、校验后的配置、作用（effect）与清理；`ctx.effect()`、`fiber.update/restart/await`、`Effect`/`Disposable`/`EffectMeta`/`CordisError`/`ValidationError` 类型 | 做副作用清理、插件热更新（`update`）或排查生命周期错误码时 |
| [registry.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/registry.md) / [registry.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/registry.zh.md) | 插件加载与依赖注入：`ctx.plugin()`、`ctx.inject()`、`Plugin` 类型（Function/Constructor/Object 三种形态 + `inject`/`provide`/`intercept` 元数据）、`Inject` 声明 | 写一个新插件、声明服务依赖或提供方时 |
| [service.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/service.md) / [service.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/service.zh.md) | Service 基类：子类以插件形式加载后注册为 `ctx.<name>`；一组静态 symbol 键（`init`/`check`/`config`/`invoke`/`extend`/`tracker`/`resolveConfig`） | 实现服务类（而非普通函数插件）时 |
| [inherited.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/inherited.md)（无中文版，生成文件） | 一页式速览：harness 插件能看到的全部继承 `ctx` 成员与继承事件（cordis core + loader/hmr/timer） | 想一眼看清"ctx 上到底有什么"、查 `internal/*` 与 `loader/*` 事件名时 |

目录之外、与其紧密相关的两篇：

- [cordis-primer.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md) — Cordis 五个核心概念、分发模式对照表、waterfall 语义、Loader 配置。**入门先读这篇。**
- `docs/cordis-tutorial/`（子目录教程，本次未展开）。

关于文档的可信度：这些英文源文件由脚本生成（`gen-cordis-catalog.ts`）并用 `pnpm run verify-cordis-catalog`（`doc-sync` 的一部分）校验新鲜度，中文版是"经评审对侧"通过双语配对维护（[context.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/context.zh.md) 文件头注释）。

## 核心 API 速查（类型签名 / 关键接口，附出处）

### Context：派生与全局句柄

上下文是一个代理：普通属性读取走服务解析器；`extend()`、`isolate()`、`intercept()` 创建有作用域的子上下文，不修改父上下文（[context.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/context.zh.md)）。

```ts
extend(meta = {}): this
// 在当前作用域之上创建带额外元数据的子上下文；原型继承全部属性，
// meta 的自有属性（含 symbol 键）遮蔽继承属性；父上下文不被修改。

isolate(name: string, label?: symbol)
// 创建子上下文，使服务 name 拥有独立作用域；同一 label 的两次 isolate() 加入同一作用域。

intercept<K extends InjectKey>(name: K, config: Context[K] extends { [symbols.config]: infer T } ? T : never): this
intercept(name: string, config: any): this
// 为在此上下文之下启动的插件添加服务专属拦截配置（祖先条目在前合并）。

root: this          // 应用根上下文（@experimental）
baseUrl?: string    // 解析相对插件/模块说明符的基础 URL
events: EventsService   // 事件总线，方法混入 ctx（ctx.on、ctx.emit…）
logger: LoggerService   // ctx.logger(name) 取具名 logger
reflect: ReflectService // 上下文代理背后的反射层
registry: RegistryService // ctx.plugin、ctx.inject 混入自它
```

静态 symbol 键：`Context.effect` / `Context.filter` / `Context.isolate` / `Context.intercept`；跨 realm 的品牌判断用 `Context.is(value)`（`static is(value: any): value is Context`，以全局 symbol 为键，不靠 `instanceof`）（[context.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/context.zh.md)）。

### Context：底层服务存储

（[context.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/context.zh.md)，源码 `vendor/cordis/src/reflect.ts`）

```ts
get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
get(name: string, strict?: boolean): any
// strict 为 true（默认）时仅返回提供方 fiber 当前活跃的实现。

set<K extends string & keyof this>(name: K, value: undefined | this[K]): void
set(name: string, value: any): void
// 只有提供该服务的 fiber 才能覆盖；set 未提供的名称会抛异常。

provide<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void
provide(name: string, value?: any): () => void
// 注册归当前 fiber 所有的服务实现；返回 disposer。名称已提供或已声明为访问器时抛异常。

accessor(name: string, options: Omit<Property.Accessor, 'type'>): void
// 由 get/set 钩子支持的计算属性；fiber 卸载时移除。

mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void
// 把服务的成员暴露在 ctx 上（方法绑定到服务），如 ctx.on → ctx.events.on。
```

### 事件分发（五种模式 + 注册）

（[events.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/events.zh.md)）

```ts
parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>
parallel<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promise<void>
// 并发运行所有监听器；全部完成后 Promise 兑现。

emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
emit<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): void
// 同步分发，忽略监听器返回值。

serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
serial<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
// 依次等待各监听器，直到其中一个 bail；返回第一个 bail 值（非 null/false/undefined）。

bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
bail<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
// 同 serial 但同步；停在第一个同步 bail 值。

waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
waterfall<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
// 最后一个参数是 next 续接回调；调用 next() 执行下游（最终为内置行为），不调用即否决。

on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
// 注册归当前 fiber 所有的监听器；返回 disposer（若监听器仍在注册中则返回 true）。
```

配套类型（同上出处）：

```ts
interface EventOptions {
  prepend?: boolean  // 插到同事件既有监听器之前
  global?: boolean   // 无视上下文过滤器检查接收事件
}

type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'
```

waterfall 语义补充（[cordis-primer.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md)）：监听器接收 `(...args, next)`；下游返回值经 `next()` 返回当前包装层，可包装后继续向外返回；不调用 `next()` 直接返回即短路。单决策事件的短路是设计意图——策略监听器拥有决策权时可返回而不委托，观察型监听器必须委托。分发模式是事件公开约定的一部分，harness 事件用 `@mode` 标签声明并与分发调用点交叉校验。

### 插件与依赖注入（Registry）

（[registry.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/registry.zh.md)）

```ts
inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
// ctx.plugin({ inject, apply: callback }) 的简写；必需服务变化时卸载并重跑回调。

plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>
// 在当前上下文加载插件；await 在加载完成后结束（配置/启动错误会 reject）。
```

`Plugin` 类型（同上出处，完整定义见原文）：

```ts
type Plugin<T = any> =
  | Plugin.Function<T>     // (ctx, config) 调用的函数插件
  | Plugin.Constructor<T>  // new (ctx, config) 的类插件
  | Plugin.Object<T>       // 带 apply(ctx, config) 的对象插件

namespace Plugin {
  export interface Base<T = any> {
    name?: string                          // 显示名（诊断与 logger 名）
    Config?: StandardSchemaV1<any, T>      // 启动前校验配置的 standard-schema
    inject?: Inject                        // 必需服务；全部可用才加载
    provide?: string | string[]            // 提供的服务名
    intercept?: Dict<boolean>              // 声明消费哪些服务的拦截配置
  }
  export interface Transform<S, T> {
    schema?: true
    Config: (config: S) => T   // 用户侧配置 → 运行时配置
  }
  export interface Runtime {
    name?: string
    fibers: DisposableList<Fiber>          // 该插件回调的全部活跃 fiber
    callback: globalThis.Function          // 注册表身份键
    Config?: StandardSchemaV1
  }
}

type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }
// 数组形式：不带拦截配置地请求服务；对象形式：服务名 → 可选拦截配置。
```

### Fiber 与 Effect

（[fiber.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/fiber.zh.md)）

```ts
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
// execute 立即运行；清理函数按相反顺序运行（调用 disposer 或 fiber 卸载，先到者为准）。
// fiber 已 dispose 时抛 CordisError('INACTIVE_EFFECT')；返回结构无效抛 TypeError。

fiber: Fiber                  // 拥有此上下文的 fiber
fiber.uid: number | null      // 注册表内唯一 id；根 fiber 为 0，dispose 后为 null
fiber.ctx: Context            // 插件运行所在上下文
fiber.config: any             // 校验后的配置（由 update() 更新）
fiber.state                   // 生命周期状态；转换发出 internal/status
fiber.dispose: () => Promise<void>
fiber.store: Dict<Impl> | undefined   // 加载期间所需服务实现的快照
fiber.inertia: Promise<void> | undefined // 进行中的加载/卸载转换
get name()                    // 显示名，继承最近具名祖先，否则 'root'

assertActive()                // 已 dispose 时抛 CordisError('INACTIVE_EFFECT')
getEffects()                  // 返回每个带标签活跃作用的 EffectMeta 树
async await()                 // 等待生命周期工作并重抛启动错误
async restart()               // dispose 后立即以当前配置重载
update(config: any, noSave = false)
// 校验并应用新配置后重启插件；先跑 internal/update waterfall（更新钩子/HMR 可否决）。
// noSave 提示持久化钩子不要写回。配置校验失败抛 ValidationError。
```

类型（同上出处）：

```ts
type Effect<T = any> = SyncEffect<T> | AsyncEffect<T>
// 单个清理函数、兑现清理函数的 promise，或生成多个清理函数的（可能异步的）可迭代对象；
// 生成器作用在每个清理函数产生时注册它。

type Disposable<T = any> = () => T
// 卸载时按注册相反顺序运行；可为异步。

interface EffectMeta {
  label: string        // 如 ctx.on("event")、ctx.provide("name")
  children: EffectMeta[]
}

class CordisError extends Error {
  constructor(public code: CordisError.Code, message?: string)
}
namespace CordisError {
  export const Code = { INACTIVE_EFFECT: 'cannot create effect on inactive context' } as const
}

class ValidationError extends TypeError {
  name = 'ValidationError'
  constructor(issues: readonly StandardSchemaV1.Issue[])
}
```

### Service 基类

子类在构造函数中 `super(ctx, name)` 即注册为 `ctx.<name>`，随所属 fiber 自动移除（[service.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/service.zh.md)）。`service.name: string` 为注册名。静态 symbol 键：`Service.init`（构造后运行的实例方法，类插件）、`Service.check`（可用性谓词）、`Service.config`（虚设拦截配置类型参数）、`Service.invoke`（使服务可调用，如 `ctx.logger()`）、`Service.extend`、`Service.tracker`、`Service.resolveConfig`（拦截配置解析辅助）。

### 继承成员与继承事件速览

（[inherited.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/inherited.md)，仅英文生成文件）

- 继承 `ctx` 成员：`on/once`、五种分发方法、`plugin/inject`、`effect`、`get/set/provide/accessor/mixin`、`extend/isolate/intercept`、`root/fiber/registry/reflect/events/logger`、`ctx.timer`（+ `interval/timeout/throttle/debounce` 四个 helper 直接混入 ctx）、`ctx.loader`（boot 应用的配置 Loader，loader 存在时可用）。
- 继承事件：`internal/plugin`、`internal/status`、`internal/service`（服务绑定拦截钩子，无核心生产者）、`internal/update`（waterfall）、`internal/get`（waterfall）、`internal/set`（waterfall）、`internal/listener`、`internal/dispatch`；来自 loader 的 `exit`、`loader/config-update`、`loader/entry-init`、`loader/partial-dispose`、`loader/patch-context`。

## 内置工具目录要点

文件：[tool-catalog.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.zh.md)（生成文件，`pnpm run verify-tool-catalog` 校验）。

- **性质**：列出已发布插件向 `ctx.tools` 提供的全部面向模型的工具（`name`/`description`/JSON Schema `parameters`）。生成器不是纯静态分析——它会**真实启动**每个工具插件并读 `ctx.tools.schemas()`，因为 schema 可能含运行时展开的枚举、配置决定的名称等。
- **范围**：仅 `packages/*/tool-*` 下的已发布产品工具，各以**默认**配置启动；必填且无默认值的 Config 字段处，包说明会记录本页展示的是哪个分支（如 `todo_write` 的 `allowParallelInProgress` 页面取 `true`）。注册名可以是加载时配置（如 `tool-subagent` 的 `toolName`），部署可能以不同名称提供。`examples/` 演示工具不在范围内。
- **工具包映射表**：每行给出模型可见名称、依赖的服务、写入/影响的事件、别名与部署说明。主要包与工具名（节选，完整表见原文）：
  - shell：`@deepseek-ai/dsh-tool-bash` → `bash`；`dsh-tool-pwsh` → `pwsh`；`dsh-tool-bash-persistent` / `dsh-tool-pwsh-persistent` → 同名持久 PTY 版（依赖 `ctx.terminals`）
  - 文件：`dsh-tool-fs` → `edit`/`read`/`read_image`/`write`（图片工具需 `ctx.attachments` 才注册）；`dsh-tool-fs-search` → `glob`/`grep`（spawn 随包的 ripgrep，不经 shell）；`dsh-tool-str-replace-editor` → `str_replace_editor`
  - 终端：`dsh-tool-terminal` → `terminal_open/read/send/signal/list/close`（需选择启用）
  - 后台任务：`dsh-tool-jobs` → `job_kill`/`job_list`/`job_output`（后台 bash、PTY 发送、subagent 共用）；bash 的 `run_in_background` 注册到通用 `ctx.jobs`
  - 委派：`dsh-tool-subagent` → `subagent`（别名 `subagent`/`subagent_fork`）+ `list_subagent_models`；`dsh-tool-subagent-control` → `interrupt_agent`/`list_agents`/`send_message`
  - 会话只读：`dsh-tool-session-query` → `session_event_read`/`session_event_search`/`session_event_trace`/`session_search`/`session_trace`
  - 其他：`run_code`（`dsh-tools`，PTC 模式保留传输）、`workflow`、`ralph`、`skill`、`todo_write`、`web_search`/`web_fetch`、`lsp`、`ask_user_question`、`exit_plan_mode`、`plugin_manager`、`present`、`schedule_*`、goal 三件套、实验性 agent-team 9 件套、MCP resources 三件套、stagehand 6 件套、`cordis_inspect_list/query`
- **示例 schema（bash，照抄）**（[tool-catalog.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.zh.md)）：

```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "The bash command to execute." },
    "description": { "type": "string", "description": "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"npm install\" → \"Install package dependencies\"." },
    "timeoutMs": { "type": "number", "description": "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry." },
    "workdir": { "type": "string", "description": "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it." },
    "run_in_background": { "type": "boolean", "description": "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies." }
  },
  "required": ["command", "description"]
}
```

## 配置系统要点

文件：[config-catalog.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.zh.md)（生成文件，`pnpm run verify-config-catalog` 校验）。

- **定位**：按**部署**为轴，逐个列出每个可加载 harness 包的 `apply`/服务构造函数接收的完整配置声明（含 JSDoc 与被引用类型）。每个 `config:` 块均可由 `cordis.yml` 条目设置；运行时 schema 有意排除的字段是仅供运行时使用的 seam，不能通过 `cordis.yml` 设置。
- **交叉校验**：生成器把运行时 schemastery schema 与粘贴的声明核对——每个经 schema 验证的键（含嵌套键）必须出现在声明类型里，"粘贴内容无法隐藏加载器接受的字段"。
- **`Requires:` 行**：列出插件通过 `inject` 注入的服务键——其 `cordis.yml` 树还必须加载这些服务的提供者。
- **条目示例（照抄，[config-catalog.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.zh.md)）**：

```ts
// @deepseek-ai/dsh-acp   需要：agents · llm · sessionPersistence · sessions
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /** Maximum summaries returned by one session/list page. */
  sessionListPageSize?: number
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}
```

- **文末三张清单**：
  1. **无配置的可加载插件**——不含 `config:` 块即可加载（如 `@deepseek-ai/dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-storage`、`dsh-terminal` 等约 90 个）；
  2. **Seam 包（不可直接加载）**——抽象服务类，部署时应加载具体实现包，例如 `dsh-fs`（抽象 `FileSystem`）、`dsh-shell`（`ShellExecutor`）、`dsh-sandbox`（`SandboxProvider`）、`dsh-session-persistence`（`SessionPersistence`）、`dsh-session-query`（`SessionQueryEngine`）、`dsh-jobs`（`JobRegistry`）、`dsh-spill`（`SpillStore`）、`dsh-subprocess`（`SubprocessRuntime`）、`dsh-workflow`（`WorkflowEngine`）、`dsh-compaction`、`dsh-credentials`、`dsh-settings`、`dsh-attachment`、`dsh-ptc-runtime`、`dsh-storage-domain` 等；
  3. **库包（无插件入口）**——只能作为库导入，`cordis.yml` 无法加载（如 `dsh-base`、`dsh-app-boot`、`dsh-agent-loop-testkit`）。
- 覆盖面：目录含 100 余个带配置的包章节（从 `dsh-acp` 到 `dsh-workspace-changes`），完整清单见原文目录树。

## 持久化与 session 格式要点

文件：[persistence-catalog.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/persistence-catalog.zh.md)、[persistence-schema.json](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/persistence-schema.json)、[session-format-status.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/session-format-status.zh.md)。

- **信封（envelope）**（[persistence-catalog.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/persistence-catalog.zh.md)）：每条 session log 记录包含 `type`、`seq`、`time`、`data`，可选 `ignorable` 以及条件字段 `surfaceOp` / `sourceEventSeqs`。信封是按 `type` 的正常判别联合（`switch (event.type)` 即可收窄 `data`）。**surface** 事件产生模型历史，仅四种：`system/message`、`user/message`、`assistant/message`、`tool/result`（`SurfaceEventType`）；其余是 **log-only**。`SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }`，replace 由 compaction 等表面重写生产者使用，且节点的 `sourceEventSeqs` 必须包含所有被遮蔽的表面节点。
- **`ignorable` 语义**：标记后，读取方遇到不认识的 `type` 可安全跳过；缺失即必需——读取方遇到不认识的必需事件**必须拒绝重建会话**，不得静默丢弃。
- **事件目录**：按家族列出全部持久化事件及照抄的类型声明与源码位置，家族包括 `agent/*`、`agent-preset/*`、`approval/*`、`assistant/*`、`command/*`、`compaction/*`、`deliverables/*`、`feedback/*`、`goal/*`、`hook/*`、`image/*`、`llm/*`、`model/*`、`permission/*`、`plan/*`、`request/*`、`sandbox/*`、`schedule/*`、`session/*`、`session-log-deepseek/*`、`step/*`、`subagent/*`、`system/*`、`team/*`、`todo/*`、`tool/*`、`tool-workflow/*`、`turn/*`、`user/*`、`web/*`、`workspace/*`。示例（照抄）：

```ts
'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string }
// log-only；arguments 是模型产出的原始 JSON 字符串（未解析）。

'tool/result': {
  turn: number
  step: number
  message: ToolResultMessage
  error?: { name: string; code: string; reason?: string }  // 仅 isError: true 时允许
  meta?: JsonValue                                          // 工具私有展示载荷，JSON 可序列化
}
// surface。
```

- **机器可读 schema**（[persistence-schema.json](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/persistence-schema.json)）：`formatVersion: 1`，含 `roots`（各根类型 + SHA-256 摘要 + 节点化 schema）与 `types`（470 个可达规范化类型）。根类型摘要有：`SessionHeader`（header）、`JsonlHeaderLine`（header，JSONL 物理行）、`SessionEventEnvelope`（envelope）以及每个 `event:*`。指纹规则：注释、源码位置、别名、擦除品牌标记、readonly、无语义重排不影响摘要；元组顺序、属性名、值类型、可选性影响摘要。
- **格式版本**（[session-format-status.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/session-format-status.zh.md)）：代码唯一真源是 `packages/core/session/src/types.ts` 的 `SESSION_FORMAT_VERSION`（写入器版本）；最新已发布格式由该文档的发布记录声明——当前记录为 `latestReleasedVersion: 3`，证据标签 `dsh-v0.1.5-alpha.1`。历史格式与类型变更另见 `docs/persistence-changes/`。

## 工具执行管线

文件：[tool-execution-pipeline.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.zh.md)（英文源含人工维护的 Mermaid 流程图）。

一次工具调用的顺序（照原文流程图节点归纳）：

1. 助手消息含工具调用块 → 记录会话事件 `tool/call`（执行前）→ UI pending 卡片 `presentCall(args)`。
2. `tools/pre-execute` **waterfall**（钩子、权限、沙箱）→ 注册的**单调守卫**（deny 或 abstain；identity 受保护）。`pre-execute` 可 allow / deny / ask；ask 走 `ctx.approval` 一次性提问，缺失或无法回答即 deny，`allowed-once` 放行进守卫。
3. `tools/execute` **waterfall**（超时、重试、指标——环绕式分发）→ 工具 `execute()` 本体；期间仅 tool-fs 类变更走 `fs/write-intent` / `fs/edit-intent` 门禁，并产生工具自有会话事件（`todo/write`、`fs/observed`、`hook/invoked`、`hook/result`、`tool/ptc-dispatch`）。
4. `tools/post-execute` **waterfall**（接受、阻止、替换、补充上下文）→ 注册表对候选结果做无损快照，快照抛错则规范化为 `isError` → `ToolDefinition.finalizeContent`（最后的仅内容不变式）→ `tools/result` 同步通知（冻结的权威结果）→ 记录 `tool/result`（单一面向模型的结果）→ UI `presentResult(args, result)` → 批次全部结算后注入活动批次的 `additionalContexts`（FIFO，作为 `user/message` 插在已记录的工具结果之后）。

关键不变式：三个 waterfall（`pre-execute` / `execute` / `post-execute`）都可以改写一次调用；`finalizeContent` 与 `tools/result` 由定义自身控制、在此之后运行；任何环节抛出都会经注册表外层规范化为 `isError` 结果而不是崩溃循环。审批在单调守卫**之前**处理询问，而不得重序的所有者策略仍作为已注册守卫存在。PTC 模式下保留的 `run_code` 传输及其序列化子调用都进入同一管线：子调用携带父级 token、记录 `tool/ptc-dispatch`、将拒绝呈现为有约束力的驳回，并省略 `additionalContexts` 以保持调用与结果相邻。

## 已知的文档缺口与注意点

- `docs/cordis-api/inherited.md` 无中文对侧（`inherited.zh.md` 不存在）；其余五篇均有 `.zh.md`。
- 各 catalog 的中文版是"经评审对侧"，以英文生成文件为源；若怀疑过期，先跑/看 `pnpm run verify-*-catalog` 的结论（doc-sync 门禁），再对照英文版。
- 五种分发方法在 `events.zh.md` 的类型签名（`waterfall` 返回 `ReturnType<Events[K]>`、非 await）与 `cordis-primer.zh.md` 的分发模式表格（`waterfall` 行标注"是否 await？否"）一致；`cordis-primer` 表格另将 `emit`/`waterfall`/`bail` 标为无 await，与签名相符，未发现矛盾。
- 工具 schema 展示的是**默认配置分支**，不等于你的部署实际 schema（配置可改变参数集合与工具名）——引用 schema 前先核对你的 `cordis.yml`。
