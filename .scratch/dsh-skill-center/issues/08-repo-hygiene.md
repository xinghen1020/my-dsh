# 08 — 工程卫生：没有版本控制、树里有二进制归档、没有 CI

Status: needs-triage
Severity: Optional
Area: 仓库根

## 事实

1. **这个工程不是 git 仓库。** `git status` → `fatal: not a git repository (or any of the parent directories): .git`，但根目录有 `.gitignore`（13 行，UTF-8，内容正确）。README.md:65 也写着「本仓库」。
   后果：没有历史、没有可评审的 diff、出错无法回滚；`code-review-and-quality` 里「每个变更都要有能独立成立的描述」「锁文件必须提交且评审其 diff」这些要求无处附着。
2. **树里有无法评审的二进制与来历不明的参考资料**（与插件源码同级、不在 `docs/` 下）：
   - `plugins/plugins.rar`（73,473 字节，二进制归档，内容未核对）；
   - `plugins/参考.html`（36,556 字节）。
   二进制文件无法 diff、无法评审，且归档里可能包含任何东西（含凭据）。
3. **没有任何 CI 配置**：全仓库只有 `plugins/dsh-skill-center/package.json` 的 `test` 脚本。六个测试套件是纯 Node、零依赖、跑完不到几秒，是最省力的 CI 对象。
4. **`pnpm` 在本机不可用**（`pnpm --version` → CommandNotFoundException），而 README:19 与安装/卸载章节（`dsh plugin --profile web add|remove|why`）都依赖 `dsh plugin` 转发给 pnpm。这是环境事实，不是代码缺陷，但会让文档里的命令在新机器上直接失败。

## 建议

- `git init` 并做一次初始提交（`.gitignore` 已就绪），之后任何改动都经 commit + review。
- `plugins/参考.html` 移入 `docs/`（它显然是设计参考）或删除；`plugins/plugins.rar` 解包成可评审的目录、或移出仓库（若它是插件的历史打包，请改为在 release 里提供）。
- 加一条最小 CI：依次跑 `node test/smoke.mjs`、`categories.mjs`、`sources.mjs`、`client-smoke.mjs`、`client-render.mjs`、`host-integration.mjs`。注意 issue 03 的 3b：`host-integration.mjs` 在缺少 `@deepseek-ai/*` 时会打印 skipped 并 `exit 0`，CI 里要么固定 `DSH_PACKAGES`，要么把跳过变成显式失败。
- README 的安装章节补一句「需要 pnpm」（已有前置要求，但「安装」章节的命令没再提），或在 `dsh plugin` 缺 pnpm 时给出可读报错。

## 验收

- `git log` 有历史，`git status` 干净。
- 树里不再有 `.rar`；`参考.html` 或在 `docs/` 或已删除。
- CI 跑通六个测试文件，且跳过路径不会伪装成通过。
