/**
 * DeepSeek Harness (dsh) target.
 *
 * dsh is a Cordis-architecture plugin harness with NO traditional config
 * keys — every capability is a plugin line in the `cordis.patch.yml`
 * combination tree. The patch layer (`~/.dsh/cordis.patch.yml`) applies
 * across profiles with the highest precedence, so that one file is the
 * whole global surface. This target writes (D-dsh-1 … D-dsh-6):
 *
 *   - MCP: one `- insert:` line for the `@deepseek-ai/dsh-mcp-client`
 *     plugin, wrapped in a `# >>> codegraph mcp >>>` marker block.
 *     There is no mcpServers map — one server = one plugin line with
 *     `serverName: codegraph`; dsh then surfaces tools as
 *     `mcp__codegraph__<tool>`, same shape as Claude/ZCode. Only the
 *     minimal field set is written (transport/serverName/command/args):
 *     defaults stay off disk, minimizing the clobber surface.
 *   - Instructions: `~/.dsh/AGENTS.md` (the ONLY user-level instruction
 *     file dsh reads — no CLAUDE.md), via the shared upsert.
 *   - Front-load prompt hook (D-dsh-3): dsh itself has no native hook
 *     config, but ships `@deepseek-ai/dsh-hooks-claude-code`, a bridge
 *     that runs unmodified Claude Code command hooks. We insert that
 *     bridge as a SECOND marker block and hand it our own exclusive
 *     `<DSH_HOME>/codegraph-hooks.json` (whole-file write/delete, never
 *     shared with the user).
 *
 * Scope: global only — dsh has no project-level MCP/hook config at all
 * (Codex mode). `DSH_HOME` overrides the home dir (HERMES_HOME
 * precedent). Patch-layer writes hot-reload into running dsh sessions,
 * so the install note never says "restart".
 *
 * ---- Bridge schema, verified against V:\Repo\deepseek-harness source ----
 * (required before implementing D-dsh-3; the survey's `configPath`
 * wording is confirmed correct):
 *
 *   - Plugin config field IS `configPath` — `z.string().required()`
 *     (packages/hooks/hooks-claude-code/src/index.ts:44-78, schema at
 *     :72-78). Optional siblings `pluginRoot` / `projectDir` /
 *     `defaultTimeoutMs` / `stderrSummaryMaxChars` are all omitted —
 *     `projectDir` defaults per-run to the session workspace
 *     (index.ts:148-151), which is exactly what a prompt hook wants.
 *     `configPath` is read ONCE at plugin load and a relative path
 *     resolves against the process launch cwd (index.ts:101-104), so we
 *     always write an ABSOLUTE path.
 *   - hooks.json shape: `{ hooks: { UserPromptSubmit: [ { hooks: [ {
 *     type: 'command', command } ] } ] } }` — the CC settings shape
 *     (config.ts:78-123; `type` defaults to 'command', matcher fields
 *     are discarded for UserPromptSubmit).
 *   - stdin payload: full CC shape `{session_id, transcript_path, cwd,
 *     hook_event_name: 'UserPromptSubmit', prompt}` (index.ts:319-338) —
 *     what our `prompt-hook` subcommand already parses for Claude Code.
 *   - stdout: `additionalContext` is honored ONLY inside
 *     `hookSpecificOutput` AND only when its `hookEventName` matches the
 *     firing event (hook-protocol/src/codec.ts:97-133, `expectedEventName`
 *     passed at hooks-claude-code/src/index.ts:170-173). Plain stdout is
 *     NOT used as context (merge.ts folds only `out.additionalContext`).
 *     → the `--context-json` envelope is directly compatible AND
 *     effectively REQUIRED through this bridge.
 *   - Commands run via `ctx.shell` — PowerShell on Windows
 *     (packages/shell/pwsh-local), so the command string is
 *     `"<absolute node>" "<absolute entry js>" prompt-hook --context-json`
 *     with forward slashes and double quotes (pwsh-safe, and node accepts
 *     forward-slash paths on every platform).
 *
 * ---- MCP `command: codegraph` — bare name, unlike ZCode (D-dsh-1) ----
 * dsh spawns stdio MCP servers through cross-spawn
 * (packages/mcp/mcp-client/src/transport.ts), which applies Windows
 * PATH/PATHEXT resolution itself — a bare `codegraph` finds
 * `codegraph.cmd` on PATH. ZCode instead spawns via plain Node
 * (no PATHEXT), which is why that target scans PATH for the `.cmd`
 * absolute path; that workaround is deliberately NOT copied here.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  jsonDeepEqual,
  removeMarkedSection,
  replaceOrAppendMarkedSection,
  resolveCodegraphCliEntry,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

/** Marker pair around the MCP plugin insert line (git-hooks.ts precedent). */
const MCP_BLOCK_START = '# >>> codegraph mcp >>>';
const MCP_BLOCK_END = '# <<< codegraph mcp <<<';
/** Marker pair around the hooks-bridge plugin insert line (independent block). */
const HOOKS_BLOCK_START = '# >>> codegraph hooks >>>';
const HOOKS_BLOCK_END = '# <<< codegraph hooks <<<';

/** Plugin-line id for our MCP client insert (detect matches this line). */
const MCP_PLUGIN_ID = 'mcp-codegraph';
/** Plugin-line id for our hooks-bridge insert. */
const HOOKS_PLUGIN_ID = 'hooks-claude-code-codegraph';

function dshHome(): string {
  return process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : path.join(os.homedir(), '.dsh');
}

function patchYmlPath(): string {
  return path.join(dshHome(), 'cordis.patch.yml');
}

function hooksJsonPath(): string {
  return path.join(dshHome(), 'codegraph-hooks.json');
}

function agentsMdPath(): string {
  return path.join(dshHome(), 'AGENTS.md');
}

/**
 * The MCP insert block (D-dsh-1). Minimal field set only — every other
 * schema field (env/cwd/toolCallTimeoutMs/failOnStartupError/reconnect)
 * has a harness default and stays off disk. `command: codegraph` is the
 * bare name on purpose: cross-spawn resolves PATHEXT on Windows (see
 * the file header), unlike ZCode's plain-Node spawn.
 */
export function renderDshMcpBlock(): string {
  return [
    MCP_BLOCK_START,
    '- insert:',
    `    - id: ${MCP_PLUGIN_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        transport: stdio',
    '        serverName: codegraph',
    '        command: codegraph',
    "        args: ['serve', '--mcp']",
    MCP_BLOCK_END,
  ].join('\n');
}

/**
 * The hooks-bridge insert block (D-dsh-3). `configPath` is the verified
 * required field of `@deepseek-ai/dsh-hooks-claude-code`; absolute +
 * forward slashes because the bridge reads it once at process load and
 * resolves relatives against the launch cwd.
 */
export function renderDshHooksBlock(): string {
  const configPath = hooksJsonPath().replace(/\\/g, '/');
  return [
    HOOKS_BLOCK_START,
    '- insert:',
    `    - id: ${HOOKS_PLUGIN_ID}`,
    "      name: '@deepseek-ai/dsh-hooks-claude-code'",
    '      config:',
    `        configPath: '${configPath}'`,
    HOOKS_BLOCK_END,
  ].join('\n');
}

/**
 * The CC-format hooks config the bridge reads (D-dsh-3). Our exclusive
 * file — written whole, deleted whole. The command string must survive
 * pwsh: double-quoted absolute entry path with forward slashes (the
 * entry derivation is shared with the ZCode hook via
 * `resolveCodegraphCliEntry`).
 */
export function buildDshHooksJson(): Record<string, unknown> {
  // Absolute node captured at install time (process.execPath — same form as
  // the ZCode hook entry): the bridge runs this via pwsh/bash, which would
  // otherwise need `node` on PATH.
  const nodeBin = process.execPath.replace(/\\/g, '/');
  const command = `"${nodeBin}" "${resolveCodegraphCliEntry()}" prompt-hook --context-json`;
  return {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command }] },
      ],
    },
  };
}

/** Whole-file write of our exclusive hooks.json; idempotent on content. */
function writeHooksJson(): WriteResult['files'][number] {
  const file = hooksJsonPath();
  const existed = fs.existsSync(file);
  let existing: unknown;
  if (existed) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      existing = undefined; // corrupt → overwrite; the file is ours alone
    }
  }
  const want = buildDshHooksJson();
  if (jsonDeepEqual(existing, want)) {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, JSON.stringify(want, null, 2) + '\n');
  return { path: file, action: existed ? 'updated' : 'created' };
}

/** Delete our exclusive hooks.json outright (we never share it). */
function deleteHooksJson(): WriteResult['files'][number] {
  const file = hooksJsonPath();
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  try {
    fs.unlinkSync(file);
  } catch {
    return { path: file, action: 'not-found' };
  }
  return { path: file, action: 'removed' };
}

/**
 * `true` when a line of the patch layer is our MCP insert line —
 * matched on the `id:` value (spec D-dsh-4), agnostic to indentation.
 */
function patchHasMcpLine(content: string): boolean {
  const pattern = new RegExp(`^-\\s+id:\\s*${MCP_PLUGIN_ID}\\s*$`);
  return content.split(/\r?\n/).some((line) => pattern.test(line.trim()));
}

class DshTarget implements AgentTarget {
  readonly id = 'dsh' as const;
  readonly displayName = 'DeepSeek Harness (dsh)';
  readonly docsUrl = 'https://github.com/deepseek-ai/deepseek-harness';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = patchYmlPath();
    let alreadyConfigured = false;
    try {
      alreadyConfigured = patchHasMcpLine(fs.readFileSync(file, 'utf-8'));
    } catch { /* absent patch layer — nothing configured */ }
    // `profiles/` existing = dsh has actually run on this machine
    // (spec D-dsh-4; the home itself can pre-exist without profiles).
    const installed = fs.existsSync(path.join(dshHome(), 'profiles'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['dsh has no project-local config; re-run with --location=global.'],
      };
    }

    const files: WriteResult['files'] = [];
    const patchFile = patchYmlPath();
    const patchExisted = fs.existsSync(patchFile);
    let patchChanged = false;

    // 0. Front-load prompt hook via the CC bridge, tri-state like
    // claude/zcode:
    //   true     → write the bridge insert + our hooks.json
    //   false    → strip both (opt-out round-trips)
    //   undefined → leave both untouched (refresh / unmanaged callers)
    if (opts.promptHook === true) {
      const action = replaceOrAppendMarkedSection(
        patchFile, renderDshHooksBlock(), HOOKS_BLOCK_START, HOOKS_BLOCK_END,
      );
      if (action !== 'unchanged') patchChanged = true;
      files.push(writeHooksJson());
    } else if (opts.promptHook === false) {
      const action = removeMarkedSection(patchFile, HOOKS_BLOCK_START, HOOKS_BLOCK_END);
      if (action === 'removed') patchChanged = true;
      const removed = deleteHooksJson();
      if (removed.action === 'removed') files.push(removed);
    }

    // 1. MCP insert line — its own marker block. Block-level upsert:
    // byte-equal → untouched; stale content inside the markers (e.g. a
    // future schema/command change) → swapped in place, self-healing;
    // markers absent → appended after the user's own patch lines,
    // which are preserved verbatim either way.
    const mcpAction = replaceOrAppendMarkedSection(
      patchFile, renderDshMcpBlock(), MCP_BLOCK_START, MCP_BLOCK_END,
    );
    if (mcpAction !== 'unchanged') patchChanged = true;

    // One report entry for the patch file no matter how many blocks were
    // managed: 'created' only when the file itself is new, 'updated'
    // when any block changed, 'unchanged' when every block already
    // matched byte-for-byte.
    files.unshift({
      path: patchFile,
      action: !patchExisted ? 'created' : patchChanged ? 'updated' : 'unchanged',
    });

    // 2. Instructions — user-level AGENTS.md is the only file dsh reads.
    files.push(upsertInstructionsEntry(agentsMdPath()));

    // Patch-layer writes hot-reload (profile-boot re-reads on change);
    // deliberately no "restart" wording.
    return {
      files,
      notes: ['Changes hot-reload into running dsh sessions.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };

    const files: WriteResult['files'] = [];
    const patchFile = patchYmlPath();

    // Strip both marker blocks (D-dsh-6). removeMarkedSection deletes
    // the patch file itself when the last block leaves it empty — the
    // Codex convention — and leaves sibling patch lines intact.
    const hooksAction = removeMarkedSection(patchFile, HOOKS_BLOCK_START, HOOKS_BLOCK_END);
    const mcpAction = removeMarkedSection(patchFile, MCP_BLOCK_START, MCP_BLOCK_END);
    files.push({
      path: patchFile,
      action: hooksAction === 'removed' || mcpAction === 'removed'
        ? 'removed'
        : 'not-found',
    });

    // Our exclusive hooks file — delete outright.
    files.push(deleteHooksJson());

    // AGENTS.md — strip the marker block; delete when it empties out.
    files.push({
      path: agentsMdPath(),
      action: removeMarkedSection(agentsMdPath(), CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END),
    });

    return { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# dsh has no project-local config; use --location=global.\n';
    }
    return `# Add to ${patchYmlPath()}\n\n${renderDshMcpBlock()}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    // The unconditional install surface. hooks.json is written only when
    // the user opts into the prompt hook, so it is not listed here.
    return [patchYmlPath(), agentsMdPath()];
  }
}

export const dshTarget: AgentTarget = new DshTarget();
