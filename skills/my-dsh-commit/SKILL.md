---
name: my-dsh-commit
description: Use when committing changes to the my-dsh repository — follow the dev-main branch workflow, write a clear Chinese commit message, and push to origin/dev.
---

# my-dsh 提交规范

本仓库是 dsh (DeepSeek Harness) 的组合层配置仓库，位于 ~/Projects/my-dsh。

## 分支纪律

- `dev` = 主力分支，日常所有改动都提交在这里
- `main` = 备份分支，内容永远等于或落后于 dev，不直接提交

## 提交动作

```bash
cd ~/Projects/my-dsh
git add -A
git commit -m "<中文改动说明>"
git push                       # 推 dev
git push origin dev:main       # 需要备份时，把快照同步到 main
```

## 铁律

- 配置文件改动前先看 `git diff`，确认没有密钥（.credentials.yaml / .env 永不入库）
- 提交信息用中文，一句话说清"改了哪个模块、为什么"
- 改完配置记得重启 dsh 生效：`kill $(pgrep -f 'dsh web' | head -1) && dsh web`
