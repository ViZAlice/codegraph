# Fork 维护与发布流程

本 fork（ViZAlice/codegraph）的分支模型、上游同步、npm 发布规则。给未来的自己（或任何接手的人）看的操作手册。

## 模型

| 名字 | 指向 | 角色 |
| --- | --- | --- |
| `upstream` | colbymchenry/codegraph | 原作者仓库，只读 |
| `origin` | ViZAlice/codegraph | 我们的 fork |
| `feat/agent-targets` | origin 的**默认分支** | **唯一维护的分支**：agent 适配（zcode、dsh…）+ 发布 workflow 都在这里 |
| `main` | origin / 本地 | 上游的纯镜像，由 Action 每日自动快进，**任何人不得手动提交或推送** |
| npm 包 | `@vizalice/codegraph` | 我们发布的包。scope 必须是 `@vizalice`——`@colbymchenry` 是原作者的 scope，无发布权限 |

为什么默认分支是 `feat/agent-targets` 而不是 main：GitHub 的 `schedule` 触发只对**默认分支**上的 workflow 生效，而 main 必须保持上游的纯快进（不能塞我们自己的 workflow 文件），所以承载定时 workflow 的只能是 feat/agent-targets。

## 每日自动同步（.github/workflows/sync-main.yml）

- 每天北京时间 10:00，在 GitHub 服务器上把 fork 的 `main` 快进到 `upstream/main`（`--ff-only`，保证 main 永远等于上游，永远不会有合并冲突）。
- **只动 main**。是否把上游更新合并进 feat/agent-targets，永远是人为决定的（见下节）。
- Actions 标签页可手动触发（workflow_dispatch）或查看历史。
- 注意：fork 的定时 workflow 若被 GitHub 停用（fork 默认禁用 schedule），去 Actions 页点 Enable。

## 把上游更新合并进 feat/agent-targets（手动，时机自定）

```bash
git fetch origin
git switch feat/agent-targets
git merge origin/main          # main 已被 Action 同步到最新
# 若 package.json 冲突：name 保留 @vizalice/codegraph，version 采用上游
npm install && npm run build && npx vitest run __tests__/installer-targets.test.ts
git push origin feat/agent-targets
```

冲突经验：唯一稳定的冲突点是 `package.json` 前两行（我们改 `name`，上游升 `version`），解法固定——name 用我们的，version 用上游的。其余文件（installer、README 等）目前全部自动合并。

## 发布到 npm（.github/workflows/publish.yml）

**触发规则：只认 `npm-v*` tag**（如 `npm-v1.6.0`）。绝不用 `v*`——`git fetch upstream` 会把上游的 `v1.6.0` 等 tag 带进本地，如果触发规则是 `v*`，这些 tag 一旦被推到本 fork 就会意外触发发布；且 `npm version` 生成的 `v*` tag 会与上游同名 tag 相撞。

发布步骤（版本号来源：合并上游时 package.json 的 version 已就位；纯自研改动则 `npm --no-git-tag-version version <X.Y.Z>` 手动升）：

```bash
git tag npm-v<X.Y.Z>                    # 例：npm-v1.6.0
git push origin feat/agent-targets npm-v<X.Y.Z>
# Action 自动：checkout → npm ci → build → npm publish --access public
```

验证：仓库 Actions 页看运行结果；包页面 https://www.npmjs.com/package/@vizalice/codegraph 。

前提（一次性）：仓库 secret `NPM_TOKEN` 存在且有效——npmjs.com 的 granular token，All packages / Read and write / 勾选 bypass 2FA / 过期时间设长。token 失效的表现是 Action 日志报 403 或要求 OTP。

## 其他电脑安装

```bash
npm install -g @vizalice/codegraph      # 装
npm update  -g @vizalice/codegraph      # 升级
codegraph install -y                    # 装进各 agent（dsh / zcode / claude…）
```

不依赖本仓库的克隆——npm 包里是编译好的 dist。开发机才需要 clone fork（`git clone -b feat/agent-targets https://github.com/ViZAlice/codegraph.git`）。

## 禁止事项

- 不要向 origin 推送 `main`（Action 负责它）。
- 不要推送 `v*` 形式的 tag（会与上游 tag 撞名；发布只用 `npm-v*`）。`git push --follow-tags` 也别用——它会把 fetch 带来的上游 tag 一起推上去。
- 不要把 package.json 的 `name` 改回 `@colbymchenry/*`（发不上去）。
- 不要在 main 上做任何提交（会破坏 sync Action 的 `--ff-only`）。
