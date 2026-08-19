# ZCode Target 适配方案（以 Codex 为基准，对照全部 11 个 target）

> 目标：让 ZCode 成为 codegraph 安装器的一等公民 target——`codegraph install --target zcode`
> 一条命令完成全部适配，取代目前手动写入的 MCP 配置。行为基准 = 安装器对 Codex 所做的
> 每一件事；本文同时调查了其余全部 target 的适配面，逐维度评估 ZCode 能做到什么、值得做什么。

**状态**：调查完成，待实现
**基准版本**：codegraph v1.5.0（本仓库 master）
**License**：MIT —— fork / 改动 / 回传上游均无障碍

---

## 一、基准：`codegraph install --target codex` 究竟做了什么

Codex 是所有 target 中最简形态（无权限、无钩子、仅全局），完整动作按安装器编排顺序如下。
源码：`src/installer/index.ts`（编排）、`src/installer/targets/codex.ts`（target 本体）。

### 1.1 编排层动作（所有 target 共享，`runInstallerWithOptions`）

| 步骤 | 动作 | Codex 的情形 |
|---|---|---|
| 1 | CLI 装到 PATH：交互确认后 `npm install -g @colbymchenry/codegraph`（`--yes` 跳过，超时 120s） | 共享 |
| 2 | 探测 `detect('global')`：`installed` = `~/.codex/` 目录存在；`alreadyConfigured` = `config.toml` 含 `[mcp_servers.codegraph]` | 用于 multiselect 预选 |
| 3 | 位置选择：`supportsLocation('local')` 返回 **false** → 用户选 local 时整个 target 被跳过并提示"re-run with --location=global" | **global-only** |
| 4 | autoAllow（权限）：Codex 无权限概念 → 静默忽略 | no-op |
| 4¾ | promptHook（前置注入钩子）：仅 Claude，忽略 | no-op |
| 5 | 逐 target 调 `install()`，每个文件动作打一行日志 | — |
| 5½ | Pro beta 邮箱 opt-in（仅交互模式，一次） | 共享 |
| 6 | **不索引**：只提示 `cd <project> && codegraph init` | 共享 |
| — | 遥测 `recordLifecycle('install', {targets, scope, kind})` | 共享 |

### 1.2 `install()` 落盘动作（Codex 全部只有这两个文件）

**A. MCP 条目 → `~/.codex/config.toml`**（`codex.ts:144`）
- 追加 TOML 表 `[mcp_servers.codegraph]`，只有 `command = "codegraph"` + `args = ["serve", "--mcp"]`
- 建目录/建文件（`created`/`updated`）；幂等 upsert（字节等价 → `unchanged`）；原子写
- 用户在同一表里手加的键重装时保留

**B. 指令块 → `~/.codex/AGENTS.md`**（`shared.ts:186`）
- 写 `<!-- CODEGRAPH_START/END -->` 标记块（`instructions-template.ts`）
- 原因（#704）：MCP `initialize` 指令只有主 agent 可见，子 agent / 非 MCP 场景只读指令文件
- 幂等 + 自愈旧版长块 + 用户内容保留

### 1.3 逆向与其他入口

| 命令 | 行为 |
|---|---|
| `uninstall --target codex` | 删 TOML 表（空文件则删文件）；剥离 AGENTS.md 标记块（空则删文件） |
| `install --print-config codex` | 只打印片段 |
| `upgrade`（内部 `install --refresh`） | 仅对已配置 target 重跑 install，刷新模板 |
| `describePaths()` | `[config.toml, AGENTS.md]` |

---

## 二、全部 11 个 target 的适配面调查

### 2.1 总矩阵

| Target | MCP 配置文件 | MCP 键位/条目风味 | 指令文件 | 权限 | 钩子 | 位置 | 特殊处理 |
|---|---|---|---|---|---|---|---|
| **claude** | `~/.claude.json` / `./.mcp.json` | `mcpServers` 标准形 | `~/.claude/CLAUDE.md` / `./.claude/CLAUDE.md` 标记块 | ✅ `permissions.allow` 加 `mcp__codegraph__*` | ✅ `UserPromptSubmit` → `codegraph prompt-hook` | 双 scope | 迁移/清理三批历史遗留（`./.claude.json` 错写、pre-0.8 mark-dirty/sync-if-dirty 钩子、旧长指令块）；win32 钩子命令写 `codegraph.cmd` |
| **cursor** | `~/.cursor/mcp.json` / `./.cursor/mcp.json` | `mcpServers` + **注入 `--path`**（global 用 `${workspaceFolder}`，local 用绝对路径） | ❌ 不写；**删除**旧 `.cursor/rules/codegraph.mdc` 自愈 | ❌ | ❌ | 双 scope | `--path` 因 Cursor 不传 workspace 信息；重启提示 note |
| **codex** | `~/.codex/config.toml` | TOML 表，仅 command+args | `~/.codex/AGENTS.md` 标记块 | ❌ | ❌ | 仅 global | 自写窄 TOML 序列化器（`toml.ts`） |
| **opencode** | `~/.config/opencode/opencode.jsonc` / `./opencode.jsonc`（XDG 全平台一致） | `mcp.<name>` = `{type:'local', command:[数组], enabled:true}` | `~/.config/opencode/AGENTS.md` / `./AGENTS.md` | ❌ | ❌ | 双 scope | JSONC **注释保留**编辑（jsonc-parser）；清扫 legacy `%APPDATA%` 错写 |
| **hermes** | `$HERMES_HOME/config.yaml` | YAML `mcp_servers` + **`platform_toolsets.cli` 白名单加 `mcp-codegraph`** | ❌ 无 | ❌ | ❌ | 仅 global | 手写 YAML 行级编辑器；不加白名单则工具被 CLI profile 过滤 |
| **gemini** | `~/.gemini/settings.json` / `./.gemini/settings.json` | `mcpServers`，`trust` 留空（确认弹窗归用户） | `~/.gemini/GEMINI.md` / `./GEMINI.md` | ❌ | ❌ | 双 scope | 卸载不删空 settings.json |
| **antigravity** | `~/.gemini/config/mcp_config.json`（统一后）或 legacy `~/.gemini/antigravity/mcp_config.json` | **无 `type` 字段**（带 `type:"stdio"` 会被拒）；macOS 解析**绝对路径** | ❌（与 gemini 共用 GEMINI.md，由 gemini target 负责） | ❌ | ❌ | 仅 global | `.migrated` 标记文件判路径；卸载双路径清扫；macOS GUI PATH 裁剪问题 |
| **kiro** | `~/.kiro/settings/mcp.json` / 同 local | `mcpServers` | ❌ 不写；**删除**旧 steering `codegraph.md` 自愈 | ❌ | ❌ | 双 scope | note：Kiro IDE 需手动开 MCP 开关（CLI 不用） |
| **copilot-vscode** | VS Code User `mcp.json` / `.vscode/mcp.json` | `servers`（非 mcpServers）；JSONC | ❌ | ❌ | ❌ | 双 scope | local 注入绝对 `--path`，global **刻意不注**（`${workspaceFolder}` 会在无文件夹窗口报错） |
| **copilot-cli** | `~/.copilot/mcp-config.json`（尊重 `COPILOT_HOME`） | `mcpServers` + `tools: ["*"]` | ❌ | ❌ | ❌ | 仅 global | 探测需排除 VS Code 扩展留下的纯 `ide/` 目录；PATH 扫描找 binary |
| **copilot-jetbrains** | `%LOCALAPPDATA%\github-copilot\intellij\mcp.json` | `servers` 形；JSONC | ❌ | ❌ | ❌ | 仅 global | 仅重启后重读配置（restart note） |

### 2.2 横向提炼：适配的七个维度

1. **MCP 条目**（人人都有）——但每家一种方言：键位嵌套（`mcpServers` / `mcp.<name>` / `servers` / TOML 表 / YAML）、序列化格式（JSON / JSONC / TOML / YAML）、条目字段（opencode 的 `enabled:true`、copilot 的 `tools:["*"]`、antigravity 的禁 `type`）。
2. **workspace 解析修正 `--path`**——仅当客户端不给 MCP server 传递项目信息时注入：Cursor 永远注（不传 roots、cwd 不对）；VS Code 仅 local 注（global 有变量展开坑）；Claude/Codex 不注（cwd 正确/传 rootUri）。
3. **指令文件**——四家写（claude/codex/opencode/gemini，都是"该 agent 的子代理会读指令文件"的架构）、其余不写（Cursor/Kiro 曾写过，#529 后改为依赖 MCP initialize 并自愈删除；Copilot 系/Hermes/Antigravity 从未写）。
4. **权限自动放行**——全生态仅 Claude 一家有 `permissions.allow` 文件面。
5. **前置注入钩子 `UserPromptSubmit`**——同样仅 Claude 一家（唯一有该事件的客户端，直到现在）。
6. **启用门控**——Hermes 要加 toolset 白名单、Kiro IDE 要手动开开关（只能 note 提示）、opencode 显式 `enabled:true`。ZCode 的 MCP **全 scope 自动连接**，无门控——是最省事的一类。
7. **命令解析健壮性**——antigravity 在 macOS 解析绝对路径（GUI PATH 裁剪）、claude 钩子在 win32 写 `.cmd`。核心教训：**不能假设裸命令名在任何客户端/平台组合下都能 spawn**。

---

## 三、ZCode 的能力面（官方 zcode-guide 指南 + 本机实证）

| 面 | 用户级（global） | 工作区级（local） |
|---|---|---|
| 配置文件 | `~/.zcode/cli/config.json`（纯 JSON） | `<repo>/.zcode/config.json`（或 `<repo>/zcode.json`） |
| MCP 键位 | `mcp.servers.<name>`（**嵌套**） | 同形状 |
| MCP fallback | `~/.agents/mcp.json` 顶层 `mcpServers`（仅读） | `<repo>/.agents/mcp.json` |
| MCP 条目字段 | `{type, command, args, env?, enabled?}`（本机 godot 条目实证 `env`/`enabled`） | 同 |
| 指令文件 | `~/.zcode/AGENTS.md` | `<repo>/AGENTS.md`（向上搜到项目根） |
| Hooks | `hooks.events.<Event>`，需 `hooks.enabled:true`；**七事件含 `UserPromptSubmit`**；stdout 严格 JSON，`additionalContext` 注入 | 同 |
| 权限 | 无 `permissions.allow` 文件面；运行时权限由模式决定，`PermissionRequest` 钩子可程序化 allow/deny | — |
| 其他独有面 | **plugins**（可打包 MCP+hooks+skills+commands）、skills、slash commands | 同 |

**关键实证（本机）**：
- 现有手动条目用绝对路径 `C:/Users/viza2/AppData/Roaming/npm/codegraph.cmd`，连接正常 → Windows 下绝对路径方案已被验证
- 本会话调用 `codegraph_explore` 时 server 正确解析了 cwd（报错信息给出的是工作区路径）→ **ZCode 会以正确 cwd 启动 MCP server，无需 `--path` 修正**（与 Claude/Codex 同类，优于 Cursor）

### 七维度 × ZCode 能力对比

| 维度 | 最全的参照 | ZCode 能否做到 | 决策 |
|---|---|---|---|
| 1. MCP 条目 | 各家方言 | ✅ 原生 | 写 `mcp.servers.codegraph`，标准 stdio 形，纯 JSON（claude/cursor 同款读写路径，复用 `shared.ts`） |
| 2. `--path` 修正 | Cursor/VS Code | 不需要（实证 cwd 正确） | **不注入**，与 Claude/Codex 一致 |
| 3. 指令文件 | claude/codex/opencode/gemini | ✅ 原生读 AGENTS.md，且子代理同读 | 写标记块（#704 的直接受益者） |
| 4. 权限放行 | 仅 claude | ❌ 无文件面 | no-op（与 Codex 相同）；`PermissionRequest` 钩子方案见 §7.3，不推荐默认做 |
| 5. 前置注入钩子 | 仅 claude | ✅ **ZCode 是全生态第二个有 `UserPromptSubmit` 的客户端** | 二期实现（§7.1），有输出格式适配工作 |
| 6. 启用门控 | hermes/kiro/opencode | 无门控，自动连接 | 无需处理；加一条 restart note（多数 target 都有） |
| 7. 命令解析 | antigravity/claude | 需要处理（win32 `.cmd` 问题） | **D1**：win32 解析绝对路径 |

**结论：ZCode 一期能拿到的适配 = MCP + 指令块 + restart note（超过 11 家中的 7 家）；二期加上前置注入钩子后 = 追平 Claude 满配（除权限文件外），成为全生态适配第二全的客户端。**

---

## 四、映射表与关键决策

| Codex（基准） | ZCode global | ZCode local |
|---|---|---|
| `config.toml` 加 `[mcp_servers.codegraph]` | `~/.zcode/cli/config.json` 写 `mcp.servers.codegraph` | `<repo>/.zcode/config.json` 写 `mcp.servers.codegraph` |
| `~/.codex/AGENTS.md` 注入标记块 | `~/.zcode/AGENTS.md` 注入同一标记块 | `<repo>/AGENTS.md` 注入同一标记块 |
| 仅 global | **双 scope 都支持**（ZCode 有原生工作区配置） | |
| `autoAllow` no-op | no-op | |
| `promptHook` 忽略 | 一期忽略；二期 §7.1 | |
| uninstall 时空文件删除 | **config.json 永不删除**（承载 `plugins`/`skills`/兄弟 server） | |
| MCP 值 `{type:'stdio', command:'codegraph', args}` | 同形，`command` 按 D1 解析 | |

**D1 — Windows 命令解析**：裸 `codegraph` 在 win32 有 spawn 失败风险（Node 无 shell 不能直接执行 `.cmd`；上游在 claude 钩子上踩过 `claude.ts:305`，antigravity 在 macOS 上因同类问题解析绝对路径）。本机 ZCode 可用条目即绝对路径。实现 `resolveZcodeMcpCommand()`：win32 → `where codegraph.cmd` / npm 全局 bin 推导绝对路径，回退 `'codegraph.cmd'`；其他平台 → `'codegraph'`。幂等收益：本机首跑与现有条目字节一致 → 报 `unchanged`，零破坏。

**D2 — uninstall 修剪**：删 `mcp.servers.codegraph` → `mcp.servers` 空则删键 → `mcp` 空则删键 → 写回。兄弟键原样保留。AGENTS.md 走 `removeMarkedSection`（空则删文件，与 Codex 一致）。

**D3 — fallback 不写**：只写主路径 `.zcode/config.json`；`detect` 兼容读 `.agents/mcp.json` 与 `zcode.json` 以正确报 `alreadyConfigured`。

**D4 — local 指令文件**：写 `<repo>/AGENTS.md`（ZCode 原生工作区指令文件，codex/opencode 同读，标记块幂等无害——上游对 opencode local 已是同一做法）。

**D5 — 不写 `enabled` 字段**：ZCode 省略即默认启用；显式写 `true` 会在用户手动停用后重装被当作"需要更新"，反而覆盖用户选择（opencode 写 `enabled:true` 是其方言要求，ZCode 无此要求）。

---

## 五、实现清单（fork 内改动点）

1. **`src/installer/targets/types.ts`** — `TargetId` 联合追加 `'zcode'`
2. **新建 `src/installer/targets/zcode.ts`** — `ZcodeTarget`（体量对标 `gemini.ts`，复用 `shared.ts` 全套 JSON 工具 + `upsertInstructionsEntry`）：
   - `id='zcode'`，`displayName='ZCode'`；`supportsLocation` 双 true
   - `detect`：global → `~/.zcode` 或 `~/.zcode/cli/config.json` 存在；`alreadyConfigured` 读 `mcp.servers.codegraph`（兼容 D3 fallback）。local → `./.zcode/config.json` 等
   - `install`：① `writeMcpEntry`（`readJsonFile` → `jsonDeepEqual` 幂等 → `writeJsonFile`）② `upsertInstructionsEntry` ③ note: `Restart ZCode for MCP changes to take effect.`
   - `uninstall`：D2 修剪 + `removeMarkedSection`
   - `printConfig` / `describePaths`
3. **`registry.ts`** — 追加到 `ALL_TARGETS` 尾部
4. **`bin/codegraph.ts`** — install 命令 description 加 ZCode；`index.ts` uninstall 位置提示串加 `~/.zcode`
5. **`README.md`** — badge + Supported Agents 列表
6. **`__tests__/installer-targets.test.ts`** — 镜像 codex 用例 + zcode 特有：兄弟键保留卸载、win32 命令解析、local scope、对手动条目 unchanged

## 六、验收标准

- [ ] `codegraph install --target zcode`：写 `~/.zcode/cli/config.json` + `~/.zcode/AGENTS.md`，逐文件日志
- [ ] **本机回归**：对现有手动条目执行后报 `unchanged`，现有 MCP 连接不受影响
- [ ] 重复执行全部 `unchanged`
- [ ] `--location local`：写 `./.zcode/config.json` + `./AGENTS.md`
- [ ] `codegraph uninstall --target zcode`：godot 等兄弟 server 与 `plugins`/`skills` 原样保留；AGENTS.md 用户内容保留
- [ ] `codegraph install --print-config zcode` 输出片段
- [ ] `codegraph upgrade` 的 refresh 扫描识别已配置的 zcode
- [ ] `npx vitest run __tests__/installer-targets.test.ts` 通过

---

## 七、二期与备选形态

### 7.1 二期主线：UserPromptSubmit 前置注入（追平 Claude 满配）——已定案

ZCode 是除 Claude 外唯一有 `UserPromptSubmit` 的客户端。以下契约取自官方文档 zcode.z.ai/en/docs/hooks（2026-08 核实）：

- **stdin**：一行 JSON，含 `prompt`、`cwd`（另有 `session_id` 等 Claude 兼容别名）→ `codegraph prompt-hook` 的解析器直接兼容，无需改动输入侧
- **stdout 注入**：`{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "<文本>"}}`（官方推荐形态；顶层 `additionalContext` 亦可）。非 JSON 输出只进日志不进上下文；未知键忽略、事件名不匹配整体丢弃 → 必须包信封
- **工作区级 hooks 当前版本被忽略**（安全设计，仅记日志）→ **钩子只装 global**；local 安装时跳过并 note 说明
- **执行器**：`type: "process"`（argv 直执行、无 shell、官方推荐）。`command` = `process.execPath`（安装时的 node 绝对路径，零 PATH 依赖）；`args[0]` = CLI 入口 js 绝对路径——安装时推导：包根（`__dirname` 上溯到含 package.json 的目录）下优先 `dist/bin/codegraph.js`（源码布局），否则 `npm-shim.js`（npm 布局，dist 只有 .d.ts；已实测 `node npm-shim.js prompt-hook` 可用且转发 argv）。路径统一正斜杠（与 D1 一致）
- **必须** `"hooks": { "enabled": true, ... }`（配置文件钩子默认禁用）；只增改 `enabled`/`events.UserPromptSubmit`，用户已有的其他事件组原样保留；卸载只删我们的钩子条目，**`enabled` 保持不动**（可能服务于用户自己的其他钩子）
- 每会话启动时快照钩子配置 → 安装后需**重启会话**生效
- 不设 matcher（UserPromptSubmit 的 matcher 无过滤作用）与 timeout（默认 60s 足够）

**CLI 侧改动**：`codegraph prompt-hook` 增加 `--context-json` 标志——输出原文本前包上信封；所有静默/no-op 路径保持零输出（空输出合法）。钩子命令因此是
`node <入口js> prompt-hook --context-json`，门控逻辑（关键词分级/图谱验证）完全复用不改。

**target 侧改动**（`zcode.ts`）：`InstallOptions.promptHook` 三态语义与 claude 对齐（true 写入 / false 移除 / undefined 不动）；幂等识别按 args 含 `prompt-hook` + `--context-json` 匹配（跨 node/路径变更自愈更新）；编排层 `index.ts` 的 front-load 提问条件从仅 claude 扩为 `claude || zcode`，文案同步。

### 7.2 备选形态 B：打包成 ZCode plugin（未采用，记录备查）

ZCode 的 plugin 机制可一次性贡献 MCP server + hooks + skill。优点是分发优雅（marketplace 安装）；
缺点是脱离了 codegraph 统一安装器体系（`codegraph install/uninstall/upgrade --refresh` 管不到它），
与"统一走命令行"的目标冲突。**作为 target 实现后，plugin 反而可以只做薄壳引用**，二者不互斥。

### 7.3 不推荐：PermissionRequest 钩子自动放行

技术上可行（`PermissionRequest` 钩子可返回 allow），但 ZCode 默认就对 MCP 工具无阻塞式弹窗面，
收益趋近于零，且程序化放行会干扰用户手动选择的权限模式。放弃。

## 八、工作流：fork 策略

- 本地 `codegraph_repo` 直接改（clone 即工作副本）。建议分支 `feat/zcode-target`，
  完成后 `git remote add fork <你的fork地址>` 推送；上游更新 `git fetch origin && git rebase`
- MIT 允许保留版权线前提下自由分发；`targets/` 架构就是为新增 agent 设计的，成熟后可向上游
  提 PR（合并后维护成本归零，且 ZCode 用户群都能受益）
