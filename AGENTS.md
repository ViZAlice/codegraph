# AGENTS.md — 本 fork 的运维手册

**本文件是 ViZAlice/codegraph 运维规则的唯一来源。** 通用规则在上，各 agent target 的专属规则在最下面。本仓库是 [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) 的 fork，只维护一件事：**各 agent 的适配（installer targets）+ 发布自动化**。上游的 CLAUDE.md / README / docs/design、docs/plans 描述的是上游自己的开发，与本 fork 运维无关。

> 历史说明：曾经的 docs/FORK_WORKFLOW.md 与两份 target 适配方案（zcode / dsh，含对上游源码的调查出处）已并入本文件；原文可在 git 历史中找回（`docs/plans/2026-08-1*.md`、`docs/FORK_WORKFLOW.md`）。给新 target 做适配时，**不再新建方案文档**，把专属规则直接追加到本文件底部。

| 名字 | 指向 / 身份 | 角色 |
| --- | --- | --- |
| `upstream` | colbymchenry/codegraph | 原作者仓库，只读 |
| `origin` | ViZAlice/codegraph | 我们的 fork |
| `feat/agent-targets` | **默认分支，唯一维护的分支** | agent 适配（zcode、dsh…）+ 两个 workflow（publish、sync-main） |
| `main` | 上游的纯镜像 | 由 sync-main.yml 每日自动快进；**禁止一切手动提交与推送** |
| npm | `@vizalice/codegraph` | 我们发布的包；scope 只能是 `@vizalice`（`@colbymchenry` 是原作者的 scope，无发布权限） |

**默认分支为什么不是 main**：GitHub 的 `schedule` 触发只对**默认分支**上的 workflow 生效，而 main 必须保持上游的纯快进（不能携带我们自己的 workflow 文件），所以定时任务所在的分支只能是 feat/agent-targets。

## 硬性禁令

1. 不向 origin 推送 `main`（sync Action 负责它）。
2. 不创建/推送 `v*` 形式的 tag（会与 `git fetch upstream` 带进本地的上游 tag 撞名）；发布只用 `npm-v*`。
3. 不用 `git push --follow-tags`（它会把 fetch 带来的上游 `v*` tag 一起推上去，触发意外发布）。
4. 不改 package.json `name` 的 scope；不在 main 上做任何提交（会破坏 sync 的 `--ff-only`）。

## 命名空间策略（合并上游时必查）

- **功能性包名引用必须用 `@vizalice/codegraph`**：`src/upgrade/index.ts` 的 `NPM_PACKAGE`（否则 `codegraph upgrade` 会把我们的 npm 安装静默替换成上游构建）、`src/installer/index.ts` 里的 `npm install -g` / 卸载提示、`src/bin/codegraph.ts` 的报错提示、README 安装命令、package.json `repository`。
- **上游分发链路保持指向上游，故意不改**：`install.sh` / `install.ps1` / `npm-shim.js` / `src/upgrade/index.ts` 的 `REPO` 常量——它们分发的是上游 bundle（不含 fork 的 target），我们的唯一分发渠道是 npm 包。README 里已注明 bundle 安装器装的是上游构建。
- `claude.ts` 里对 `npx @colbymchenry/codegraph …` 旧格式的识别注释是**上游遗留产物的清理逻辑**，保持原样。
- 合并上游后 `git diff` 审一遍这几处；上游若新增强制性包名引用，同样按本策略改。

## 每日上游同步（自动，无需人工）

`.github/workflows/sync-main.yml`：每天北京时间 10:00 在 GitHub 服务器上把 fork 的 main `--ff-only` 快进到 `upstream/main`，**只动 main**。是否把更新合入 feat/agent-targets 永远是人为决定（见下节）。注意：fork 的 schedule workflow 默认被 GitHub 禁用，需在 Actions 页对该 workflow 点一次 Enable。

## 手动：把上游更新合入 feat/agent-targets（时机自定）

```bash
git fetch origin && git switch feat/agent-targets
git merge origin/main            # main 已被 Action 同步到最新
npm install && npm run build && npx vitest run __tests__/installer-targets.test.ts
git push origin feat/agent-targets
```

冲突经验（历次合并几乎只出这两处，解法固定）：

- `package.json` 前两行：`name` 保留 `@vizalice/codegraph`，`version` 采用上游的。
- `package-lock.json` 根部的 `name`：同步改成 `@vizalice/codegraph`——CI 的 `npm ci` 校验 lockfile 与 package.json 的根包名一致，不改必挂。合并后务必 `git diff package-lock.json` 检查再打 tag。

## 发布 npm

版本号通常随上游合并自动就位；纯自研改动用 `npm --no-git-tag-version version <X.Y.Z>` 手动升。发布 = 打一个 tag，其余全自动（Action 跑 `npm ci → build → npm publish --access public`，约 40 秒）：

```bash
git tag npm-v<X.Y.Z> && git push origin feat/agent-targets npm-v<X.Y.Z>
```

验证：`curl https://registry.npmjs.org/@vizalice%2Fcodegraph` 看 `dist-tags.latest`（npm 网页对数据中心 IP 有反爬 403，用 registry API）。

发布失败排查：Actions 日志报 403 或要求 OTP = 仓库 secret `NPM_TOKEN` 失效或配置不对。token 要求（npmjs.com granular token，一次性配置）：All packages + Read and write + 勾选 bypass 2FA + 过期时间设长。

## 其他电脑安装

```bash
npm install -g @vizalice/codegraph    # 新装；已装的用 npm update -g 升级
codegraph install -y                  # 写入各 agent（zcode / dsh / claude…）
```

npm 包内含编译好的 dist，不依赖本仓库克隆。开发机才需要：`git clone -b feat/agent-targets https://github.com/ViZAlice/codegraph.git`。

## 通用方法论：新增一个 agent target

**先调查，全部要有出处（读目标 agent 的源码或官方文档），七个维度：**

1. **MCP 配置面**：配置文件路径、全局/项目级、格式与 shape（顶层 `mcpServers`？嵌套键？TOML/YAML/插件行？）
2. **指令文件**：agent 读哪个（AGENTS.md / CLAUDE.md / 专有文件），全局与项目级分别在哪
3. **Hook 机制**：有无 prompt 事件（UserPromptSubmit 类）、作用域（workspace 级是否被忽略）、stdout 解析约定（严格 JSON？）
4. **权限面**：有无 auto-allow / permissions 概念
5. **spawn 语义**：经不经 shell、PATH/PATHEXT 如何解析——决定 command 写裸名、`.cmd` 绝对路径还是 `node + entry js`
6. **Home 覆盖**：有无 `<X>_HOME` 环境变量先例（HERMES_HOME、DSH_HOME、COPILOT_HOME 式）
7. **生命周期**：哪些文件是共享配置绝不能删、幂等性怎么判定

**固定改动点（缺一不可）：**

- `src/installer/targets/<id>.ts` 实现 `AgentTarget` 全部方法（detect / install / uninstall / printConfig / describePaths / supportsLocation）
- `src/installer/targets/types.ts` 的 `TargetId` 联合类型 + `registry.ts` 注册（uninstall/refresh 全量扫由此自动覆盖）
- CLI `install` 命令的描述文案 + README 的支持列表
- 有 prompt hook 的话：`installer/index.ts` 里询问 promptHook 的条件要加该 target id
- 测试 `__tests__/installer-targets.test.ts`：`setHome()` 要加该 target 的 home 覆盖变量；标准用例组 = 首装落盘 / 重跑全 unchanged / promptHook opt-out 可回退 / 卸载对未安装状态安全（not-found）
- 最后：把该 target 的专属规则**追加到本文件的「Target 专属规则」章节**

**不变式（违反必出事故）：**

- 幂等：全部经 `shared.ts` 的 `readJsonFile` / `writeJsonFile` / `jsonDeepEqual` 落盘，字节一致的重跑必须报 `unchanged`；写进 JSON 的路径一律正斜杠（Windows 反斜杠会破坏字节级幂等比较）。
- 卸载只删自己写的：共享配置文件永不删除（如 zcode 的 config.json 还可能装着 plugins/skills）；用户设置的兄弟字段（`enabled`、其他 server、其他 hook）必须原样保留。
- Markdown 指令文件用 marker 块（`CODEGRAPH_SECTION_START/END`）做 upsert/移除，绝不裸写。

**平台经验：**

- **Windows**：Node 无法不经 shell spawn `.cmd`——zcode 的 MCP command 扫 PATH 取 `codegraph.cmd` 绝对路径；hook 的 command 一律 `process.execPath` + `resolveCodegraphCliEntry()`（从 `__dirname` 向上找包根，依次尝试 `dist/bin/codegraph.js` → `npm-shim.js` → `scripts/npm-shim.js`）。
- **mac/linux**：裸 `codegraph`（npm 全局安装产生带 shebang 的可执行文件），与全部既有 target 一致。zcode 的 mac 分支代码正确但**未做过真机验收**。
- 别套模板：dsh 经 cross-spawn 自己解析 PATHEXT，反而必须写裸 `codegraph`——spawn 语义要逐 target 确认。

---

## Target 专属规则（置底）

### zcode

- **写入面**：MCP → `~/.zcode/cli/config.json` 的**嵌套键** `mcp.servers.codegraph`（不是顶层 `mcpServers`；local 是 `./.zcode/config.json`）。指令 → 全局 `~/.zcode/AGENTS.md`、项目级 `./AGENTS.md`（项目根，**不在** `.zcode/` 下）。
- **Prompt hook**：`hooks.enabled: true`（ZCode 的配置文件 hook 默认关闭，必须由安装方打开）+ 在 `hooks.events.UserPromptSubmit` 下追加 `{ hooks: [want] }` 组。`type: "process"`（argv 直执行，不经 shell）。ZCode 把 hook stdout 当**严格 JSON** 解析 → 必须用 `--context-json` envelope（见 `src/prompt-hook-output.ts`）。
- **workspace 级 hook 会被忽略**（官方文档口径，与本地 zcode-guide 文档矛盾时取保守）→ promptHook 只做 global；local + true 只出 note 不写盘。
- **遮蔽警告**：`~/.zcode/cli/config.json` 一旦存在 `mcp.servers`，ZCode 就不再读同 scope 的 `~/.agents/mcp.json` → 首次写入且那边已有 server 时要出 note 提醒用户搬迁。
- 永远不写 `enabled` 字段（缺省即启用）；但重写条目时必须把用户设置的 `enabled`（尤其是手动 `false`）原样带过去。
- 卸载：条目级摘除（hook 按 args 含 `prompt-hook` + `--context-json` 匹配，server 按键删）；`hooks.enabled` 留着（可能服务用户自己的 hook）；config.json 永不删除（哪怕删空成 `{}`）。
- 诊断入口 `docsUrl: https://zcode.z.ai/en/docs/hooks`。

### dsh（DeepSeek Harness）

- 无传统配置键：一切皆 `~/.dsh/cordis.patch.yml`（Cordis patch 层，跨 profile 生效、最高优先级）组合树里的**插件行**。patch 层**热重载**，install 文案永远不说 "restart"。
- 两个互相独立的 marker 块：
  1. **MCP**：`- id: mcp-codegraph` 的 `@deepseek-ai/dsh-mcp-client` 插件行——`transport: stdio`、`serverName: codegraph`、command 写**裸 `codegraph`**（dsh 经 cross-spawn 自解析 Windows PATHEXT，**不要**用 zcode 的 `.cmd` 形态）、`args: ['serve', '--mcp']`。只写最小字段集，有默认值的字段不上盘（toolCallTimeoutMs / failOnStartupError / reconnect 等）。工具名呈现为 `mcp__codegraph__<tool>`。
  2. **Hooks bridge**：`@deepseek-ai/dsh-hooks-claude-code` 插件（能跑未修改的 Claude Code 命令 hook），`configPath` 指向我们独占的 `<DSH_HOME>/codegraph-hooks.json`（整文件写/删，绝不与用户共享）。
- **Bridge 契约（已对 deepseek-harness 源码逐条核实）**：`configPath` 为 `z.string().required()`，插件加载时读一次，相对路径相对**进程启动 cwd** 解析 → 必须写绝对路径；hooks.json 用 CC settings 形状 `{ hooks: { UserPromptSubmit: [ { hooks: [ { type: 'command', command } ] } ] } }`；stdin 是完整 CC UserPromptSubmit payload（我们的 `prompt-hook` 子命令已兼容）；stdout 的 `additionalContext` **只在** `hookSpecificOutput` 内且 `hookEventName` 匹配触发事件时生效 → `--context-json` envelope 是必需品不是可选项。
- **Windows**：bridge 经 `ctx.shell` 执行（PowerShell），command 是带引号字符串 `"<absolute node>" "<absolute entry js>" prompt-hook --context-json`。
- **仅 global**（无任何项目级 MCP/hook 配置，Codex 类，`supportsLocation('local') === false`）；`DSH_HOME` 覆盖 home 目录（测试的 `setHome` 必须包含它）。
