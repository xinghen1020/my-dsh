# my-dsh

在宿主机直接运行 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的极简工程。以本项目目录为默认工作区，Web UI 中可随时添加任意目录（如 `d:\workspace`）作为工作区。

> dsh 是能执行命令的 agent，运行在你的用户权限下；它会按 Web UI 中你选中的工作区目录读写文件。

## 目录结构

```
my-dsh/
├── start-dsh.cmd      # 一键启动 dsh web（Windows）
├── README.md
└── .gitignore
```

## 前置要求

- **Node.js 18+**（本机已验证 v24.19.0）
- **pnpm**（`dsh plugin` 命令会转发给它；`npm install -g pnpm`）
- 能访问 npm registry（若需代理，见下方说明）

## 安装

```bash
npm install -g @deepseek-ai/dsh
```

若网络需要代理：

```bash
npm install -g @deepseek-ai/dsh --proxy http://127.0.0.1:10809 --https-proxy http://127.0.0.1:10809
```

## 运行

双击 `start-dsh.cmd`（自动清理 3080 端口旧实例 → 启动 dsh → 自动打开浏览器）。

或手动：

```bash
dsh web
```

> **访问 token**：新版本启用 token 认证。dsh 启动时打印的地址形如 `http://127.0.0.1:3080/?token=...`，浏览器用这个完整地址打开（脚本/dsh 自动打开的已带 token）。**每次重启 token 都会变**，但它只用于首次登录：兑换一次签名 cookie 后（本工程已把有效期调到 10 年，见 profile 的 `cordis.patch.yml` → `cookieMaxAgeDays`），平时直接访问 `http://127.0.0.1:3080` 即可，重启 dsh 也无需重新登录。仅换浏览器、清 cookie 或改端口时才需要用新 token URL 重新打开。

停止：关闭 dsh 窗口或按 Ctrl+C。

## 首次使用

1. 打开 Web UI 后进入 **设置 → 模型**，填入 [DeepSeek API 密钥](https://platform.deepseek.com/)并保存。
2. 点击 **选择工作区**，添加 `d:\workspace\my-dsh`（或任意你想让 agent 工作的目录，如 `d:\workspace`）。
3. 选中工作区后即可开一个会话运行任务。

## 插件

```bash
dsh plugin --profile web add <包名>    # 安装插件
dsh plugin --profile web remove <包名> # 卸载插件
dsh plugin --profile web why <包名>    # 查看依赖来源
```

已安装：

- `dshmarket`（插件市场）
- `dsh-skill-center`（技能中心，本仓库 `plugins/dsh-skill-center/`，以 `link:` 软链安装）——入口在侧边栏左下角**「设置」正上方**，点开是仿 Edge 收藏夹的**左右两栏**弹窗：左栏分类树、右栏该分类的技能列表，可批量启用/禁用、拖拽归类、多选批量操作、卸载、新建技能/分类。技能库在 `~/.dsh/skill-center/library`，状态在 `~/.dsh/skill-center/state.json`（v3）。**禁用 = 模型与用户调用面都关闭**（与原生 `disable-model-invocation` 只对模型隐藏不同）；**分类是纯组织性元数据，不影响模型可见性**。见 [plugins/dsh-skill-center/README.md](plugins/dsh-skill-center/README.md)。

安装或改动插件后需重启 `dsh web` 才生效——宿主插件树在启动时组装（客户端 bundle 的改动刷新页面即可，实测宿主每次渲染 index 都会重读它）。

### 待办：从市场缓存导入

技能中心目前**不含导入**：技能需要用文件系统放进 `~/.dsh/skill-center/library`，或在面板里「新建技能」。原 skills-management 插件留下的市场缓存（`~/.dsh/skills-management/market/skills`，6600+ 技能）是后续导入功能的来源之一；它的自动同步随该插件卸载而消失，需要更新缓存时手动执行：

```bash
git -C ~/.dsh/skills-management/market pull
```

## 数据与升级

- 会话、设置、凭据存于 `~/.dsh`（主机目录，透明可见，备份即复制该目录）。
- 升级到新版本：

  ```bash
  npm install -g @deepseek-ai/dsh@latest
  ```

## 备注

- `dsh` 处于 developer preview，迭代频繁、可能有破坏性变更，升级前留意 [官方仓库 Release](https://github.com/deepseek-ai/deepseek-harness/releases)。
- 安全：dsh 拒绝绑定 `0.0.0.0`（仅监听本机回环），避免向局域网暴露远程代码执行能力。
