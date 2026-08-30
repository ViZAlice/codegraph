# dsh (DeepSeek Harness) Target 适配方案

> 目标：为 codegraph 安装器新增 `dsh` target。基准仍是 Codex 动作集（MCP + 指令块），
> 并含前置注入钩子（借助 dsh 的 Claude Code hooks 桥）。
> **实施约束（用户指令）**：只改源码与测试，**禁止 `npm run build` / `npm install -g` /
> 任何真实配置写入**——另一窗口正通过 junction 使用当前全局 codegraph，dist 不可动。
> 真机安装与验收等用户后续指令。

**状态**：调查完成（基于 V:\Repo\deepseek-harness 源码核实），待实现
**工作分支**：`feat/dsh-target`（自 `feat/zcode-target` @71a7a8c 切出）

---

## 一、dsh 适配面调查结论（全部有源码出处）

dsh 是 Cordis 架构的 plugin-harness：**没有传统配置键**，一切能力 = `cordis.patch.yml`
组合树里的插件行。与本仓库 11 个既有 target 的关键差异：

| 面 | dsh 的形态 | 出处 |
|---|---|---|
| MCP | `~/.dsh/cordis.patch.yml`（跨 profile 全局层，优先级最高）里 insert 一行 `@deepseek-ai/dsh-mcp-client` 插件；**无 mcpServers 映射**，一 server 一行 | `packages/mcp/mcp-client/src/index.ts:1-14`、`apps/cli/src/profile-boot.ts:44-51` |
| stdio spawn | MCP 官方 SDK `StdioClientTransport` → **cross-spawn**：Windows 下自带 PATH/PATHEXT 解析，裸命令与 `.cmd` 垫片可直接跑 | `packages/mcp/mcp-client/src/transport.ts:31-39` |
| 信任门控 | 无（写入即连接）；工具命名 `mcp__<serverName>__<tool>` 与 Claude/ZCode 同形 | `index.ts:107-128` |
| 指令文件 | 用户级**仅** `~/.dsh/AGENTS.md`（无 CLAUDE.md）；项目级 AGENTS.md/CLAUDE.md 链自动发现（无需安装动作） | `packages/context/agent-instructions/src/render.ts:98`、`config.ts:11-13` |
| 钩子 | 官方桥 `@deepseek-ai/dsh-hooks-claude-code`：读 Claude Code 格式 hooks.json，支持 **UserPromptSubmit 注入附加上下文**；但桥本身也要 insert 进 patch 层，且**不在 base bundle** | `packages/hooks/hooks-claude-code/src/index.ts:203-235` |
| Hook 命令执行 | 经 `ctx.shell`：**Windows = pwsh**（非 bash）——命令串必须 PowerShell 兼容 | `packages/shell/pwsh-local/src/index.ts:218` |
| 项目级配置 | **没有**项目级 MCP/hook 配置 → target 仅支持 global | `profile-boot.ts`、hooks 桥 TODO |
| detect | `~/.dsh/profiles/` 目录存在 = installed；`DSH_HOME` 环境变量可覆盖 home | `packages/util/home-paths/src/index.ts:87-91` |
| 热重载 | patch 层写完即生效，无需重启（note 里不必写 "restart"，可写热重载提示） | `profile-boot.ts:285-294` |

字段 schema（insert 行的 config）：`transport/serverName/command/args/env/cwd/
toolCallTimeoutMs/failOnStartupError/reconnect`；`serverName` 必须 `[A-Za-z0-9_-]{1,32}`
全局唯一；**无 enabled 字段**（禁用 = 行级 `disabled: true`）。完整文档：
`docs/config-catalog.md` 1207-1258 行。

## 二、设计决策

**D-dsh-1 — MCP 条目 = 单个 insert 行，写在 `~/.dsh/cordis.patch.yml`**

```yaml
# >>> codegraph mcp >>>
- insert:
    - id: mcp-codegraph
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: codegraph
        command: codegraph
        args: ['serve', '--mcp']
# <<< codegraph mcp <<<
```

- 只写最小字段集（transport/serverName/command/args）——默认值不落盘，减少 clobber 面
- `command` 用**裸 `codegraph`**：cross-spawn 的 PATHEXT 解析是 dsh 自己的 spawn 路径，
  有调查证据背书，无需 ZCode 式绝对路径（此差异写入代码注释）
- 用标记注释包裹整块（`# >>> / # <<<`，git-hooks.ts 先例），块级 upsert/remove；
  文件不存在则创建为仅含本块，卸载后为空则删文件（Codex 惯例）
- 幂等：标记块内容 byte-equal → unchanged；用户在块外加自己的 patch 行不受影响

**D-dsh-2 — 指令块 = `~/.dsh/AGENTS.md`**，复用 `upsertInstructionsEntry`/`removeMarkedSection`。

**D-dsh-3 — 前置注入 = CC 桥 + 自有 hooks 文件**（比照 zcode 二期）

1. patch 层再 insert 一行桥插件（同一标记块策略，独立标记）：
```yaml
# >>> codegraph hooks >>>
- insert:
    - id: hooks-claude-code-codegraph
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: '<DSH_HOME>/codegraph-hooks.json'
# <<< codegraph hooks <<<
```
   ⚠️ **实现前必须核实**桥插件的 config schema 确切字段名（读
   `V:\Repo\deepseek-harness\packages\hooks\hooks-claude-code\src/config.ts` 与
   `index.ts:44-53`）——`configPath` 是调查报告措辞，以源码为准；同时确认其 stdin
   传递与 `additionalContext` 解析格式（是否为 CC 的 hookSpecificOutput 形态，决定
   `--context-json` 信封是否直接兼容）。
2. 写 `<DSH_HOME>/codegraph-hooks.json`（我们独占的文件，可整文件读写）：
```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command",
  "command": "node \"<CLI入口js>\" prompt-hook --context-json" } ] } ] } }
```
   - 命令串 **pwsh 兼容**：`node` + 双引号绝对路径 + 参数（正斜杠路径）
   - 入口 js 复用 ZCode 的推导逻辑（见 D-dsh-5）
   - 三态语义同 claude/zcode：promptHook true 写 / false 删 / undefined 不动

**D-dsh-4 — 作用域与 detect**：`supportsLocation` 仅 global（无项目级概念，Codex 模式）；
installed = `<DSH_HOME>/profiles/` 存在；alreadyConfigured = `cordis.patch.yml` 含
`mcp-codegraph` 行 id（或标记块）。`DSH_HOME` 环境变量覆盖 home（HERMES_HOME 先例）。
local 时 skip + note。

**D-dsh-5 — CLI 入口推导复用**：把 zcode.ts 的 `resolveZcodeCliEntry` 提升到
`shared.ts` 为 `resolveCodegraphCliEntry(startDir?)`（逻辑不变），zcode.ts re-export
旧名保持测试不动，dsh target 与 hooks.json 共用。

**D-dsh-6 — 卸载对称**：剥两处标记块（mcp / hooks）+ 删 `codegraph-hooks.json`
（我们独占，直接删）+ 剥 AGENTS.md 指令块；patch 层文件空则删文件；`settings.yaml`
等其他文件永不触碰。

## 三、实现清单

1. `types.ts`：TargetId 加 `'dsh'`
2. `shared.ts`：`resolveCodegraphCliEntry` 提升（自 zcode.ts），zcode.ts re-export
3. 新建 `targets/dsh.ts`：YAML 标记块编辑器（upsert/remove，注释感知）+ MCP 行 +
   hooks 桥行 + hooks.json 写删 + detect/install/uninstall/printConfig/describePaths；
   `id='dsh'`，`displayName='DeepSeek Harness (dsh)'`，docsUrl 用 config-catalog 或 repo
4. `registry.ts` 注册（尾部）；`bin/codegraph.ts` install 描述加 dsh；
   `index.ts` uninstall 提示串加 `~/.dsh`；front-load 提问条件加 dsh（桥方案同样受益）
5. README Supported Agents 加一行
6. 测试（镜像既有惯例，全部 tmp 隔离）：首装/幂等/自愈（command 路径变更重写）、
   兄弟 patch 行保留、卸载往返、AGENTS.md 用户内容保留、hooks.json 三态、DSH_HOME
   覆盖、local skip note、pwsh 命令串形状、printConfig 不落盘

## 四、验证边界（本轮 ONLY）

- `npx vitest run __tests__/installer-targets.test.ts __tests__/installer.test.ts` 全绿
- `npx tsc --noEmit -p tsconfig.json` 零错误
- **禁止**：`npm run build`、`npm install/pack`、写 `~/.dsh`、写 `~/.zcode`、动 `dist/`
- 真机验收（安装到用户机器、真实 dsh 联测）——**等用户指令后另做**

## 五、真机验收清单（预写，待用户放行后执行）

- [ ] `codegraph install --target dsh`：写 `~/.dsh/cordis.patch.yml` + `~/.dsh/AGENTS.md`（+ hooks 桥行与 hooks.json）
- [ ] 重跑全 unchanged；`--print-config dsh` 输出 YAML 片段
- [ ] 起一个 dsh 会话，确认 `mcp__codegraph__codegraph_explore` 工具出现且可查询已索引项目
- [ ] 结构化提示的前置注入经桥生效（dsh 热重载，无需重启）
- [ ] `codegraph uninstall --target dsh` 干净往返
