# options（策略选项库）

`--patch` 叠加用的策略选项文件，每个文件一个可组合选项：

```bash
dsh web --patch ~/.dsh/options/workspace-write.yml
# 可叠加: --patch a.yml --patch b.yml
```

示例文件名与作用：

- `read-only.yml`      — 只读沙箱（安全基线）
- `workspace-write.yml`— 工作区可写 + 写前询问（日常推荐）
- `full-access.yml`    — 完全放行（⚠️ 危险，慎用）
- `telemetry-off.yml`  — 遥测关闭（隐私）
- `fast-thinking.yml`  — 思考强度 low（省 token）
- `deep-thinking.yml`  — 思考强度 max（质量优先）

补丁格式：顶层 YAML 数组，按 `- id: <模块id>` 定位，`config` 改配置、`disabled: true` 关模块。
