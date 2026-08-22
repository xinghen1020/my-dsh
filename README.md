# my-dsh

个人 DeepSeek Harness (dsh) 配置仓库——**组合层即代码**。

## 这是什么

dsh (DeepSeek Harness) 的架构是"一切皆插件"：模型适配器、工具、会话日志、Agent Loop、Web UI 全部是 Cordis 插件行，通过 **bundles → profile patch → home patch → --patch** 四层叠加组合。

本仓库只存**组合与配置层**（可重建、定义了"你是谁"的部分），不存运行时与机密（密钥、会话日志、生成物）。

## 文件清单

| 文件 | 来源 | 作用 |
|---|---|---|
| `profiles/web/package.json` | `~/.dsh/profiles/web/` | **bundle 配方**：`dsh.profile.bundles` 定义 web profile 由哪些模块栈组成 |
| `profiles/web/cordis.patch.yml` | `~/.dsh/profiles/web/` | web profile 的补丁层（id 定位的配置覆盖/禁用/插入） |
| `cordis.patch.yml` | `~/.dsh/` | home 级常驻策略，对所有 profile 生效 |
| `settings.yaml` | `~/.dsh/` | 全局设置（默认 agent preset 等，无机密） |
| `scripts/deploy.sh` | — | 一键部署：把本仓库软链为 `$DSH_HOME` 的事实源 |

## 当前模块组合

- web profile bundles：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`
- 启动后加载 135 个模块行（`dsh web --dump-config` 可查全量）
- 内置 agent presets：`standard`（标准）/ `code`（PTC 代码模式）/ `minimal`（极简，当前默认）/ `cordis`（创造模式）

## 部署

```bash
git clone git@github.com:xinghen1020/my-dsh.git ~/my-dsh
bash ~/my-dsh/scripts/deploy.sh   # 软链进 ~/.dsh, 改配置=改仓库=自动版本化
dsh web                            # 重启生效
```

## 安全边界（永远不进仓库）

- `.credentials.yaml` / `.env` —— API 密钥
- `storages/`、`sessions/` —— 运行时状态与会话日志（含完整对话）
- `node_modules/`、`profiles/*/cordis.yml` —— 依赖与生成树，可重建

## 进阶路线

在 `package.json` 增加 `dsh.bundle` 字段指向 `cordis.patch.yml`，本仓库即可升级为可安装的 dsh 插件（`dsh plugin add my-dsh`），这是"一切皆插件"的分享形态。

> 版本：dsh 0.1.1-rc.2（developer preview，可能有破坏性变更）
