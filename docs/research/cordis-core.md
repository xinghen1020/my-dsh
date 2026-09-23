# Cordis 插件框架核心（dsh 调研笔记）

> 调研日期：2026-09-20。来源：deepseek-ai/deepseek-harness 官方仓库 docs/（分支 master）。
> 引用格式为 GitHub blob URL。中文文档优先（`.zh.md`）。

## 术语表（精简）

摘自官方术语表与 primer，只保留框架层核心词：

- **插件（plugin）**：实现 Service 的对象，三种形态——函数（`apply(ctx)`）、带 `apply` 方法的对象、`Service` 子类。生命周期由 Cordis 挂载到上下文。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md)
- **上下文（Context, `ctx`）**：服务的容器。每个服务占据稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`）；其他插件按 key 查找服务，而非 import 实现。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md)
- **inject**：插件声明所需服务 key 的导出项；Cordis 让插件保持 PENDING 直到服务就绪。加载顺序由依赖而非配置位置表达。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/03-services.zh.md)
- **fiber**：已加载插件实例的运行时句柄；状态机 `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`（可 `FAILED`）。`fiber.dispose()` 等待全部清理（含异步 disposer）并递归卸载子插件。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md)
- **effect**：可逆注册。内置 API（`ctx.on`、`ctx.plugin`、服务注册、harness 注册表 `ctx.tools.register(...)` 等）本身就是 effect，随插件卸载自动撤销；框架外资源须包进 `ctx.effect()` 并返回 disposer。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md)
- **事件分发模式**：`emit`（同步广播，无返回值）、`parallel`（并发等待）、`serial`（按序 await，首个非 `null`/`false`/`undefined` 返回值胜出并停止）、`bail`（serial 的同步版）、`waterfall`（环绕中间件）。模式是事件公开约定的一部分，harness 事件以 `@mode` 标签记录并由生成目录交叉校验。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md)、[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/04-events.zh.md)
- **seam（能力 seam）**：包含三种角色的*可替换能力*——**Service Definition**（拥有自身 `ctx.<key>` 与词汇类型的 Cordis `Service`，可以是抽象类或具体注册表，**绝不是 TypeScript interface**）、一个或多个 **Service Provider**、一个或多个 **Consumer**。规范范例：`dsh-shell`（定义）/ `dsh-bash-local`、`dsh-bash-sandbox`（提供方）/ `dsh-tool-bash`（消费方）。"替换一个提供方就能改变整个产品" 的原因即在此。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.zh.md)、[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
- **scope**：按 agent 划分的注册单位，只有全局/带作用域两层，扁平结构；带作用域注册不向下继承给 subagent。**scope key** 按对象同一性比较——一个活跃 agent 就是其自身 scope 的 key。**shadowing**：带作用域的工具/片段/变量仅在该 scope 内替换同名全局项。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.zh.md)
- **`agent.ctx`**：agent 的带作用域上下文；在其上的注册的可见性与生命周期都绑定该 scope，监听器参与 scope 过滤分发。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.zh.md)
- **setup window**：创建 agent 的时隙（`CreateAgentOptions.setup`）：scope 与 agent 对象已存在，但 agent/会话未发布、`agent/created` 未触发；此时只做注册，从不驱动 agent。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.zh.md)
- **轮次（turn）/ 步骤（step）/ Round**：步骤 = 一次模型请求 + 其引发的工具执行；轮次 = 零或多个步骤（排空已接纳输入）；Round = 承载轮次的外层策略迭代（如 Goal Round、Ralph Round），计数器归策略所有。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.zh.md)
- **profile / 组合包（bundle）/ patch**：见下一节。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)

## 核心概念：插件树、分层 bundles、Profile

- Cordis 是 dsh 底层框架（以 vendor 方式引入）：插件向共享上下文贡献服务、类型化事件和可逆副作用。**产品的每一部分都是插件**——模型适配器、工具注册表、会话日志乃至 agent loop 本身——因此每项都可从配置替换。没有特权内核：扩展方式是把插件挂载到其他插件旁边。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
- 运行中的 `dsh` 是一棵**插件树**，由启动时按序叠加的各层组成：
  - **profile**：存放在 Harness home 的具名组装。列出自己叠放的 bundle、存放树外插件、保存用户自己的 `cordis.patch.yml`。随发行版交付的模板：`web`、`headless`、`sdk`、`sdk-minimal`、`acp`。用 `dsh --profile <name>` 或 `dsh <name>` 选择。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
  - **bundle（组合包）**：Cordis 配置项及挂载代码的分发格式，因此其插入内容始终可被上层 patch。`package.json` 的 `dsh.bundle` 指向 patch 文件；profile 用 `dsh.profile` 列出 bundle。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
  - **分层顺序**（应用于空条目列表之上）：各 bundle 按 profile 列出顺序 → profile 的 `cordis.patch.yml` → home 级那份 → 任意 `--patch` overlay。一条 patch 按 `id` 定位条目并替换其整个 config，或插入新条目。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
- `dsh-base` 是 `web`/`headless`/`sdk`/`acp` 的共享第一层（模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测）；`dsh-web-app` 增加浏览器应用、`dsh-headless` 增加无服务器一次性运行器、`dsh-sdk-app` 增加 SDK JSON-RPC 服务器、`dsh-acp-app` 增加 ACP 服务器。**例外**：`dsh-sdk-minimal` 不应用 `dsh-base`，自带完整显式 SDK 配置树。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
- YAML 同时控制 HMR 默认值：base 启用仅监视配置的 `dsh-hmr`；headless/sdk/acp 禁用；`sdk-minimal` 不含它。Profile patch 可覆盖。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
- 查看本机实际配置树：`dsh --profile web --dump-config`；打印出的任何条目都可以被自己的 patch 替换。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
- 核心包与 ctx 键（部分）：`ctx.sessions`（core/session）、`ctx.systemPrompt`（core/system-prompt）、`ctx.tools`（core/tools）、`ctx.agents`（core/agent）、`ctx.agentLoop`（core/agent-loop）、`ctx.llm`（llm/llm）、`ctx.webhookRuntime`（webhook）；`core/scope` 是库、无 ctx 键。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
- **事件即扩展点**，三个事件域：会话事件（持久事实，追加日志并经 `session/event` 广播，重载后仍存在）、`agent/*` 事件（携带活跃 Agent 的实时协调接口）、能力事件（`fs/*`、`tools/*`、`telemetry/*`，无需导入循环即可附加策略/适配器）。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
- 实践规则（primer）：按行为归属选 ctx 域——工具流水线事件属 `ctx.tools`，模型流式输出属 `ctx.llm`，agent 协调属 `ctx.agents`；拦截和策略优先用事件，直接能力调用优先用服务方法。每个注册都应有对应 disposer；teardown 顺序有要求时把相关工作放进同一个 effect。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md)

## Agent 生命周期

来源：[agent-lifecycle.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.zh.md)（时序图）+ [architecture.zh.md 轮次流程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)。

- 持久回放事实存于 `session/event`；实时控制与状态存于 `agent/*`。需要可回放 transcript 的 SDK 用户消费 `session/event`；`agent/*` 用于队列与状态、提示词拦截、请求构造、steering、续跑与错误处理。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.zh.md)
- 主干流程（文字化）：输入经 inbox 唤醒驱动器 → `turn/start` → 认领 next-step 输入 + 一条排队消息 → `system-prompt/assemble`（waterfall）→ `agent/pre-step`（waterfall，权威的 reject 或 `enter(messages)` 决策；首次领取被拒/为空则关闭不含步骤的轮次）→ `step/start` → `agent/request`（waterfall）→ `prepareCall(config, signal)` → 协调 `system/message`/`user/message`、按需记 `request/header`/`request/context` → 从日志派生并冻结请求 → 经 `llm/stream` waterfall 发起绑定调用 → `agent/assistant-stream` chunk* → 成功则 `assistant/message`（失败到 settlement 则 `assistant/attempt` + `agent/request-error` waterfall 决定重试或保留原错误）→ 工具循环 `tool/call` → `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tool/result` → `step/end` → 自然停止且 inbox 空时 `agent/turn-stopping`（serial 终止检查点）→ `turn/end`。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.zh.md)
- 关键不变量：
  - **取消语义**：`prepareCall` 与流式两个异步阶段中任一取消，都不提交 system 与 users 消息。循环发送不可变请求，同时保留实时取消能力。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.zh.md)
  - **模型可见即已记录**：抵达模型请求的一切必须能从会话日志重建（运行时不变量断言）；新增模型可见输入需要新的会话事件。`deriveMessages()` 从日志投影模型历史。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
  - `agent/assistant-stream` 的 chunk frame 是瞬态；`assistant/message` 嵌入精确的紧凑带时间 stream，`assistant/attempt` 记录已到 settlement 的失败/重试/取消且不进模型历史；settlement 前硬中断则无持久 attempt stream。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.zh.md)
  - `agent/pre-step`、`agent/request`、`llm/stream`、三个 `tools/*` 是 waterfall，监听器必须调用 `next()` 委托；`agent/turn-stopping` 是 serial，无 `next()`。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
  - 重试不重复组装、`agent/pre-step` 或用户消息准入；恢复在仍打开的步骤内进行（compaction 由 `dsh-compaction-basic` 经 `agent/pre-step` 处理压力，`agent/request-error` 仅用于规范上下文溢出）。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.zh.md)
  - AgentLoop 在启动已排队工作前等待串行 `agent/created` 初始化；初始化失败回滚创建。steering 与注入上下文（`agent.inject()`，落到下一次获准请求）在后续认领时经过同一 `agent/pre-step` waterfall。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)、[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.zh.md)

## Cordis 教程要点（按 tutorial 篇目组织）

教程入口：[cordis-tutorial/index.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/index.zh.md)。统一运行方式：`node --import tsx ../../vendor/cordis/bin.js`（vendor 内单文件启动器：创建根 Context、挂载 Loader，从当前目录读 `./cordis.yml`；不需要 API 密钥）。

### 1. 第一个插件 — [01-first-plugin.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/01-first-plugin.zh.md)

模块以命名导出提供 `apply`；`name` 导出项是可选诊断元数据。`cordis.yml` 是配置项列表：

```yaml
- name: './hello.ts'
```

```ts
import type { Context } from '@deepseek-ai/cordis'
export const name = 'hello'
export function apply(ctx: Context) { /* 注册贡献 */ }
```

- 列表位置不保证加载先后（各项并发启动），顺序由 `inject` 依赖决定。
- `apply` 抛异常 → 进程终止（明确报错，不跳过）；但模块**无法解析**（路径/包名拼错）时只经 logger 服务报告、不崩溃，启动早期可能被丢失——"新条目没效果先查拼写"。

### 2. 生命周期与 effect — [02-lifecycle-and-effects.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md)

```ts
ctx.effect(() => {
  const timer = setInterval(() => console.log('tick'), 200)
  return () => { clearInterval(timer) }   // disposer
})
const fiber = ctx.plugin(heartbeat)        // 代码挂载子插件，返回 fiber
await fiber.dispose()                      // 递归卸载，等所有清理完成
```

- 卸载诱因：修改配置、热重载、显式 dispose、所需服务消失。
- disposer 按注册逆序启动，但多个**异步** disposer 并发运行——有顺序要求就放进同一个 disposer 内依次 await（与 primer "放同一个 effect" 一致）。
- fiber 状态机 `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`，`apply`/配置校验抛异常进 `FAILED`。

### 3. 服务与 inject — [03-services.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/03-services.zh.md)

```ts
export class GreeterService extends Service {
  constructor(ctx: Context) { super(ctx, 'greeter') }  // 运行时以 'greeter' 注册 → ctx.greeter
  greet(who: string) { return `Hello, ${who}!` }
}
declare module '@deepseek-ai/cordis' {
  interface Context { greeter: GreeterService }        // 编译时声明合并，不生成代码
}
export function apply(ctx: Context) { ctx.plugin(GreeterService) }

// 消费方：
export const inject = ['greeter']   // PENDING 直到就绪；apply 内 ctx.greeter 保证存在
```

- 消费方只写 `'tools'` 这类 key，不 import 提供方 → 配置可换提供方而不改消费方（例：卸载 `dsh-bash-local` 挂另一个 `shell` 提供方，所有注入 `'shell'` 的插件重启并使用新实现）。
- `inject` 是持续跟踪而非一次性检查：运行中服务消失 → 依赖插件随之卸载；服务恢复 → 重新加载。
- 可选依赖：跳过 `inject`，用 `ctx.get('greeter')` 探测（无提供方时为 undefined）。
- 服务名共用扁平命名空间，自有服务要加前缀。

### 4. 事件 — [04-events.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/04-events.zh.md)

```ts
declare module '@deepseek-ai/cordis' {
  interface Events { 'stats/report'(name: string, count: number): void }  // namespace/action 约定
}
this.ctx.emit('stats/report', name, next)
ctx.on('stats/report', (name, count) => { ... })   // effect：随插件卸载自动移除
```

- waterfall 语义（环绕中间件）：监听器收到 `(...args, next)`；`await next()` 拿下游结果并可包装返回；不调用 `next()` 直接返回即**短路（否决）**。

```ts
ctx.on('demo/transform', async (input, next) => {
  if (input.includes('blocked')) return '** blocked **'  // 拥有决策权 → 短路
  return next()                                          // 仅观察/标注 → 必须委托
})
const out = await ctx.waterfall('demo/transform', 'hello', async () => 'hello')
```

- 常设纪律：观察型 waterfall 监听器忘记 `next()` 会静默吞掉全部下游默认行为。harness 用 waterfall 的场景：`agent/request`（替换模型调用配置）、`approval/request`（策略代替用户作答）。
- 注意（文档间小出入）：primer 的分发模式表把 `waterfall` 的"是否 await"标为**否**，而教程代码与事件签名（`Promise<string>`）都在 `await ctx.waterfall(...)`。以教程/代码为准：waterfall 返回 promise 且需 await；primer 表格该格疑为笔误。[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md)、[来源](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/04-events.zh.md)

### 5. 配置 — [05-config.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/05-config.zh.md)

```ts
import Schema from '@deepseek-ai/schemastery'
export interface Config { greeting: string; targets: string[] }
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  targets: Schema.array(String).default(['world']),
})
export function apply(ctx: Context, config: Config) { ... }
```

```yaml
- name: './config-demo.ts'
  config:
    targets: ['alpha', 'beta']
```

- 仓库用 Schemastery；Cordis 本身接受任意 Standard Schema 验证器（仅导出普通对象作为 `Config` 无效）。
- 校验失败 → `ValidationError`，fiber 进 FAILED，进程以状态码 1 退出；插件绝不会带着不完整配置启动。
- `!!js` 标签支持加载时求值的配置值，**仅**在 `config` 与条目 `disabled` 字段内有效；`disabled: !!js ...` 在每次挂载决策时基于 loader 上下文求值（dsh 扩展，可按平台/环境门控）；其余元数据保持静态字面值。环境选插件用 overlay。

### 6. 组合与 HMR — [06-composition-and-hmr.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/06-composition-and-hmr.zh.md)

- 配置项元数据：`id`（稳定标识，loader 区分"修改现有条目"与"先删后加"）、`disabled: true`（保留条目、跳过挂载）、嵌套组（作为单元加载/卸载）、`isolate`（给组提供某服务名的独立实例，两组可各自看到不同的 `shell` 提供方）。不带 `id` 的条目每次读配置都会拿到新 id → 任何配置文件编辑都会令它被当作先删后加而重新挂载。
- HMR：`@deepseek-ai/dsh-hmr` 监视文件，保存时先卸载旧实例（effect 回卷）再加载新代码；编辑 `cordis.yml` 本身也触发按 id 的增量更新。注意 HMR 经 Cordis logger 输出且 `inject` `timer`——缺 logger/`@deepseek-ai/cordis-plugin-timer` 时它会静默停在 PENDING。
- 诊断 PENDING 插件（"为什么我的插件没输出"的标准答案——PENDING 是合法状态，不是错误）：

```ts
import { FiberState, type Context } from '@deepseek-ai/cordis'
for (const runtime of ctx.registry.values())
  for (const fiber of runtime.fibers)
    if (fiber.state === FiberState.PENDING) console.log(`${fiber.name} is PENDING`)
```

### 7. 进入 harness — [07-into-the-harness.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/07-into-the-harness.zh.md)

```ts
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet the named person.',
    parameters: { name: { type: 'string', required: true, description: 'Who to greet' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) { return `Hello, ${args.name}!` },
  }))
  await ctx.tools.execute({
    callId: brandString<ToolCallId>('demo-1'),
    name: 'greet', arguments: { name: 'Cordis' },
    signal: new AbortController().signal,
  })
}
```

- `defineTool` 把 `parameters` 规约转换为给模型看的 JSON Schema、推导 `args` 类型并在 `execute` 前校验；`output.schema` 声明规范返回值，`output.render` 是可持久化内容的 Native renderer。
- `ctx.tools.register(...)` 的 disposer 附着到调用插件 → 卸载即注销。
- 观察方插件用 `ctx.on('tools/result', (exec, result) => ...)` + `import type {} from '@deepseek-ai/dsh-tools'` 引入包级声明合并；`tools/result` 在结果物化过程中发出，早于 `execute` 的 promise 向调用方兑现。
- 最小组合需同时列出 `@deepseek-ai/dsh-system-prompt` 与 `@deepseek-ai/dsh-tools`（工具注入 `systemPrompt` 服务贡献 schema），缺提供方则 PENDING。

## 对本项目的开发依据意义（何时查哪篇）

| 场景 | 查哪篇 |
|---|---|
| 快速回忆 Cordis 概念（插件/ctx/inject/事件/effect） | [cordis-primer.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md) |
| 动手写第一个插件、跑通 loader | [cordis-tutorial/01](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/01-first-plugin.zh.md)、[02](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md)（effect/disposer/fiber 状态机） |
| 新增/替换一项能力（提供方） | [03-services](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/03-services.zh.md) + 架构页"能力 seam"节（三角色一起设计） |
| 写事件监听/waterfall 拦截器 | [04-events](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/04-events.zh.md)（观察型必须 `next()`）+ [架构页事件节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)（三个事件域的选择） |
| 给插件加可配置项 | [05-config](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/05-config.zh.md)（Schemastery schema、`!!js` 限制） |
| 组合/patch/profile 层叠、HMR、插件不加载排查 | [06-composition-and-hmr](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/06-composition-and-hmr.zh.md) + [架构页 Profile 与组合包节](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)；实机用 `dsh --profile web --dump-config` |
| 注册模型可调用工具 | [07-into-the-harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/07-into-the-harness.zh.md) |
| 改动/理解轮次、步骤、请求构造、取消、重试 | [agent-lifecycle.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.zh.md) + [架构页轮次流程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md) |
| 用词对齐（seam/scope/turn/step 等规范定义） | [glossary.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.zh.md) |
| 某服务/事件的精确签名 | 子系统页面生成的 `cordis-surface` 区块与 `docs/cordis-api/`（本次未逐页核对，教程 index 指向此处） |

### 文档缺口与存疑点

- primer 分发模式表中 `waterfall` 标为不需 await，与教程代码（`await ctx.waterfall(...)`、事件签名 `Promise<string>`）不一致，疑为 primer 表格笔误（见上）。
- primer 的 `serial` 描述为"监听器按注册顺序观察"且有返回值，教程补充了裁决规则（首个非 `null`/`false`/`undefined` 返回值胜出并停止后续）；`bail` 在 primer 表中是"直到某个监听器返回 bail 值"，教程称其为"serial 的同步版本"。两处可互相补全，无实质矛盾。
- 事件签名、服务方法的权威参考在生成文档（子系统页 `cordis-surface` 区块、`docs/cordis-api/`）中，本次调研未逐页读取；本笔记不虚构任何 API 签名，仅记录教程示例中实际出现的用法。
- 架构页引用的若干决策 note 路径（`.agents/notes/implemented/architecture/*.md`）未在本次范围内核实是否存在。
