/**
 * ZCode target. Writes:
 *
 *   - MCP server entry to `~/.zcode/cli/config.json` (global) or
 *     `./.zcode/config.json` (local) under the NESTED `mcp.servers.codegraph`
 *     key — NOT Claude/Cursor's top-level `mcpServers`. Plain stdio shape
 *     `{ type: 'stdio', command, args: ['serve', '--mcp'] }` that does not
 *     proactively write `enabled` (absent means enabled). A user-set
 *     `enabled` value (e.g. a manual `enabled: false` disable) is preserved
 *     when an install rewrites the entry — see writeMcpEntry.
 *   - Instructions to `~/.zcode/AGENTS.md` (global) or `./AGENTS.md`
 *     (local — ZCode reads the project root file directly, not one under
 *     `.zcode/`).
 *   - Front-load prompt hook (global only) into the same config.json under
 *     `hooks.events.UserPromptSubmit` (phase two, §7.1): a `process` hook
 *     running `<node> <CLI entry js> prompt-hook --context-json`. ZCode is
 *     the second client in the ecosystem with a UserPromptSubmit event, but
 *     it parses hook stdout as STRICT JSON — hence the `--context-json`
 *     envelope flag (see src/prompt-hook-output.ts). Workspace-level hooks
 *     are IGNORED by the current ZCode (logged, never run), so a local
 *     install with promptHook skips the hook and says so. The evidence is
 *     mixed: the official web docs (zcode.z.ai/en/docs/hooks) state the
 *     current version ignores workspace-level hooks, while the locally
 *     installed zcode-guide documentation lists workspace config as a
 *     legitimate hook source. Not verified empirically — global-only is
 *     the conservative correct choice; if workspace hooks are ever
 *     confirmed to run, extend this target with a local hook write.
 *
 * ZCode launches the MCP server with the correct project cwd (verified),
 * so no `--path` correction is injected (Claude/Codex class, not Cursor).
 * No permissions concept — a no-op like Codex.
 *
 * The config file is NEVER deleted on uninstall: it can carry `plugins` /
 * `skills` / sibling servers. Uninstall only prunes `mcp.servers.codegraph`,
 * any container (`mcp.servers`, `mcp`) that becomes empty, and our prompt
 * hook entry — `hooks.enabled` is left alone (it may serve the user's own
 * hooks), so even a fully emptied `hooks: { enabled: true }` survives.
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
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  resolveCodegraphCliEntry,
  writeJsonFile,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.zcode')
    : path.join(process.cwd(), '.zcode');
}

function configJsonPath(loc: Location): string {
  // global → ~/.zcode/cli/config.json; local → ./.zcode/config.json.
  return loc === 'global'
    ? path.join(configDir('global'), 'cli', 'config.json')
    : path.join(configDir('local'), 'config.json');
}

function instructionsPath(loc: Location): string {
  // Global AGENTS.md lives under ~/.zcode/; project-local AGENTS.md lives
  // at the project root (NOT under .zcode/), matching how ZCode's
  // hierarchical context loader searches.
  return loc === 'global'
    ? path.join(configDir('global'), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

/**
 * Resolve the `command` for the ZCode MCP entry (D1).
 *
 * On Windows the launcher on PATH is `codegraph.cmd`, and Node spawns `.cmd`
 * shims only through a shell — a bare `codegraph` fails (the same lesson the
 * Claude prompt hook learned, #1466). We scan PATH for `codegraph.cmd` and
 * return its absolute path (the form already validated on this machine's
 * hand-written ZCode entry); when it isn't found we fall back to the
 * `codegraph.cmd` spelling. Other platforms use the bare `codegraph`.
 *
 * The absolute path is normalized to forward slashes: the hand-written entry
 * form validated on this machine uses them, and ZCode/Node spawn both forms
 * identically on Windows — but `jsonDeepEqual` does NOT, so keeping
 * `path.join`'s backslashes would flag a byte-identical existing entry as
 * `updated` instead of `unchanged` on first run.
 *
 * Exported so the unit tests can pin the PATH-scan and fallback behavior.
 */
export function resolveZcodeMcpCommand(): string {
  if (process.platform !== 'win32') return 'codegraph';
  const pathVar = process.env.PATH || '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'codegraph.cmd');
    try {
      if (fs.existsSync(candidate)) return candidate.replace(/\\/g, '/');
    } catch { /* ignore unreadable PATH entries */ }
  }
  return 'codegraph.cmd';
}

function buildZcodeMcpConfig(): { type: string; command: string; args: string[] } {
  const base = getMcpServerConfig();
  return { ...base, command: resolveZcodeMcpCommand() };
}

/**
 * Historical alias for the CLI-entry derivation now lifted into
 * `shared.ts` (the dsh target's hooks.json needs the same walk).
 * Re-exported under the old name so existing imports — and the unit
 * tests that pin the layout walk — keep working unchanged. See
 * `resolveCodegraphCliEntry` in shared.ts for the rationale.
 */
export { resolveCodegraphCliEntry as resolveZcodeCliEntry };

/**
 * The ZCode prompt hook the installer writes (see
 * writeZcodePromptHookEntry): `node <entry js> prompt-hook --context-json`.
 * `type: "process"` (argv-direct execution, no shell — ZCode's documented
 * recommendation). No matcher (it is meaningless for UserPromptSubmit) and
 * no timeout (the 60s default is ample).
 */
export function buildZcodePromptHook(): { type: string; command: string; args: string[] } {
  return {
    type: 'process',
    command: process.execPath.replace(/\\/g, '/'),
    args: [resolveCodegraphCliEntry(), 'prompt-hook', '--context-json'],
  };
}

/**
 * True when a ZCode hook entry (a `{type, command, args}` object) is the
 * prompt hook this installer writes. Matched on ARGS only — the joined
 * array must contain both `prompt-hook` and `--context-json` — because
 * `command`/`args[0]` are re-derived at every install (node upgrades, CLI
 * moves) and must not break identity. The pair is codegraph-specific
 * enough that a user's unrelated hooks never match, while a hand-copied
 * variant of ours still does.
 */
function isZcodePromptHook(h: unknown): boolean {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
  const args = (h as { args?: unknown }).args;
  if (!Array.isArray(args)) return false;
  const joined = args.map(String).join(' ');
  return joined.includes('prompt-hook') && joined.includes('--context-json');
}

/**
 * Write the front-load `UserPromptSubmit` hook into the GLOBAL
 * `~/.zcode/cli/config.json` — `hooks.enabled: true` (config-file hooks
 * are disabled by default in ZCode) plus one matcher-group under
 * `hooks.events.UserPromptSubmit`. Idempotent: an entry of ours already
 * present (matched by args) gets command/args rewritten in place — a node
 * or CLI-location change self-heals on the next install — and a
 * byte-identical file is left untouched (`unchanged`). Sibling events,
 * sibling hooks, and every other key (`mcp`, `plugins`, `skills`, ...) are
 * preserved. Never called for `local`: ZCode ignores workspace-level hooks
 * in the current version.
 */
export function writeZcodePromptHookEntry(): WriteResult['files'][number] {
  const file = configJsonPath('global');
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const created = !fs.existsSync(file);
  const config = readJsonFile(file);

  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  if (!config.hooks.events || typeof config.hooks.events !== 'object' || Array.isArray(config.hooks.events)) {
    config.hooks.events = {};
  }
  if (!Array.isArray(config.hooks.events.UserPromptSubmit)) {
    config.hooks.events.UserPromptSubmit = [];
  }

  const want = buildZcodePromptHook();

  // Self-heal: rewrite an installer-written entry's command/args to the
  // current node/entry paths instead of appending a duplicate.
  let found = false;
  let changed = false;
  for (const group of config.hooks.events.UserPromptSubmit) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (!isZcodePromptHook(h)) continue;
      found = true;
      if (h.command !== want.command || !jsonDeepEqual(h.args, want.args)) {
        h.command = want.command;
        h.args = want.args;
        changed = true;
      }
    }
  }
  if (!found) {
    config.hooks.events.UserPromptSubmit.push({ hooks: [want] });
  }

  // Only an install of the hook may set `enabled` — a user who disabled
  // hooks has no working hooks at all, and ours cannot run without it.
  if (found && !changed && config.hooks.enabled === true) {
    return { path: file, action: 'unchanged' };
  }
  config.hooks.enabled = true;
  writeJsonFile(file, config);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * Remove the front-load `UserPromptSubmit` hook this installer may have
 * written (see writeZcodePromptHookEntry). Used by `uninstall` and by
 * `install` when the user opts out, so the choice round-trips. Surgical at
 * the entry level: only args matching ours are dropped, so the user's own
 * hooks — even in the same event/group — survive. Empty groups are pruned,
 * then events left with no groups; `hooks.enabled` is deliberately left
 * untouched (it may serve the user's remaining hooks), so a config whose
 * hooks we emptied keeps `hooks: { enabled: true }`. Global file only — we
 * never write hooks at workspace scope.
 */
export function removeZcodePromptHookEntry(): WriteResult['files'][number] {
  const file = configJsonPath('global');
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  const config = readJsonFile(file);
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { path: file, action: 'unchanged' };
  }
  const events = hooks.events;
  if (!events || typeof events !== 'object' || Array.isArray(events)) {
    return { path: file, action: 'unchanged' };
  }

  // Pass 1: drop our hook entries from inside every event group.
  let removedAny = false;
  for (const name of Object.keys(events)) {
    const groups = events[name];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h: unknown) => !isZcodePromptHook(h));
      if (group.hooks.length !== before) removedAny = true;
    }
  }
  if (!removedAny) return { path: file, action: 'unchanged' };

  // Pass 2: prune groups with no hooks left, then events with no groups,
  // then an emptied `events` object. Guarded by removedAny so a config
  // with no hook of ours is left byte-for-byte untouched.
  for (const name of Object.keys(events)) {
    const groups = events[name];
    if (!Array.isArray(groups)) continue;
    events[name] = groups.filter(
      (g: any) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0),
    );
    if (events[name].length === 0) delete events[name];
  }
  if (Object.keys(events).length === 0) delete hooks.events;

  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

class ZcodeTarget implements AgentTarget {
  readonly id = 'zcode' as const;
  readonly displayName = 'ZCode';
  readonly docsUrl = 'https://zcode.z.ai/en/docs/hooks';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configJsonPath(loc);
    let alreadyConfigured = !!readJsonFile(file).mcp?.servers?.codegraph;

    // D3 — read-only fallbacks. We only ever WRITE the main
    // `.zcode/config.json`, but a project may already be wired through
    // ZCode's alternate `./zcode.json` or the standard `./.agents/mcp.json`
    // (both use the top-level `mcpServers` key). Reading them keeps
    // `alreadyConfigured` honest so reinstall reports unchanged instead of
    // double-writing. LOCAL checks both alternate files; GLOBAL checks the
    // user-level `~/.agents/mcp.json` (same top-level `mcpServers` shape).
    if (loc === 'local' && !alreadyConfigured) {
      alreadyConfigured =
        !!readJsonFile(path.join(process.cwd(), 'zcode.json')).mcpServers?.codegraph ||
        !!readJsonFile(path.join(process.cwd(), '.agents', 'mcp.json')).mcpServers?.codegraph;
    } else if (loc === 'global' && !alreadyConfigured) {
      alreadyConfigured =
        !!readJsonFile(path.join(os.homedir(), '.agents', 'mcp.json')).mcpServers?.codegraph;
    }

    const installed = loc === 'global'
      ? fs.existsSync(configDir('global')) || fs.existsSync(file)
      : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    const notes: string[] = [];

    // 0. Front-load prompt hook (§7.1), tri-state like Claude's:
    //   true     → write it (global only — ZCode ignores workspace hooks)
    //   false    → strip any a prior install wrote (opt-out round-trips)
    //   undefined → leave untouched (refresh / unmanaged callers)
    // Local + true is not an error, just a no-op with a note: the current
    // ZCode logs-and-ignores project-level hooks (per the official web
    // docs, zcode.z.ai/en/docs/hooks — see the file-header note for why
    // this is the conservative choice), so the hook is user-scope only.
    if (loc === 'global') {
      if (opts.promptHook === true) {
        files.push(writeZcodePromptHookEntry());
      } else if (opts.promptHook === false) {
        const removed = removeZcodePromptHookEntry();
        if (removed.action === 'removed') files.push(removed);
      }
    } else if (opts.promptHook === true) {
      notes.push('ZCode currently ignores project-level hooks — the prompt hook is user-scope only; re-run with --location=global.');
    }

    // 1. MCP server entry
    // Shadowing warning (global only): once ANY server exists under
    // `~/.zcode/cli/config.json`'s `mcp.servers`, ZCode stops reading
    // servers from the same-scope user-level `~/.agents/mcp.json` (the
    // `.zcode` file takes precedence). If we are about to create the
    // first entry there while `~/.agents/mcp.json` already carries
    // servers, the user is about to silently lose them — say so.
    if (loc === 'global') {
      const current = readJsonFile(configJsonPath('global'));
      const serversEmpty =
        !current.mcp?.servers || Object.keys(current.mcp.servers).length === 0;
      const agentsServers = readJsonFile(
        path.join(os.homedir(), '.agents', 'mcp.json'),
      ).mcpServers;
      if (serversEmpty && agentsServers && Object.keys(agentsServers).length > 0) {
        notes.push(
          'Note: adding a server to ~/.zcode/cli/config.json makes ZCode ignore servers in ~/.agents/mcp.json (same-scope .zcode takes precedence) — move them over if you rely on them.',
        );
      }
    }
    files.push(writeMcpEntry(loc));

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    notes.push('Restart ZCode for MCP changes to take effect.');
    return { files, notes };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 0. Remove the prompt hook this installer may have written (global
    // only — the local scope never carries one). `hooks.enabled` stays
    // put: it may serve the user's own remaining hooks.
    if (loc === 'global') {
      const hookCleanup = removeZcodePromptHookEntry();
      if (hookCleanup.action === 'removed') files.push(hookCleanup);
    }

    const file = configJsonPath(loc);
    const config = readJsonFile(file);
    if (config.mcp?.servers?.codegraph) {
      delete config.mcp.servers.codegraph;
      if (Object.keys(config.mcp.servers).length === 0) {
        delete config.mcp.servers;
      }
      if (Object.keys(config.mcp).length === 0) {
        delete config.mcp;
      }
      // D2 — never delete config.json itself. It can carry plugins/skills/
      // sibling servers; even an emptied `{}` is left in place.
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = configJsonPath(loc);
    const snippet = JSON.stringify({ mcp: { servers: { codegraph: buildZcodeMcpConfig() } } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configJsonPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcp?.servers?.codegraph;
  // We never add `enabled` ourselves — absent means enabled in ZCode, so
  // writing `true` would be redundant and writing anything could clobber
  // intent. But when a rewrite is unavoidable, a user-set `enabled` (most
  // importantly a manual `enabled: false` disable) must survive it: carry
  // the value into `after`. The synthesized `after` is also what the
  // idempotency comparison uses, so a re-run over an already-preserved
  // entry still reports `unchanged`.
  const userEnabled =
    before && typeof before === 'object' && !Array.isArray(before)
      ? before.enabled
      : undefined;
  const after = userEnabled === undefined
    ? buildZcodeMcpConfig()
    : { ...buildZcodeMcpConfig(), enabled: userEnabled };

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcp) existing.mcp = {};
  if (!existing.mcp.servers) existing.mcp.servers = {};
  existing.mcp.servers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Strip the marker-delimited CodeGraph block from the ZCode instructions
 * file if a prior install wrote one. Used by both install (self-heal on
 * upgrade) and uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const zcodeTarget: AgentTarget = new ZcodeTarget();
