# agent-presets（自定义会话级预设）

放用户自建的 agent preset，每个预设一个子目录：

```
agent-presets/<preset-id>/
├── preset.yml          # name / description / order
└── agent.cordis.yml    # 模块组合（复制官方 standard 改）
```

roster 会自动扫描 `~/.dsh/.agent-presets/`（软链指向本目录），
Web UI 的模式下拉里即可选择。官方预设（standard/code/minimal/cordis）
位于安装包内，**不要**改它们——自定义请复制到这里再改。

参考：官方预设源文件在
`~/.local/lib/node_modules/@deepseek-ai/dsh/config/agent-presets/`
