/**
 * Output-envelope helper for the `prompt-hook` CLI command.
 *
 * Claude Code injects a UserPromptSubmit hook's raw stdout as context, so
 * the default (no flag) emits the text verbatim. ZCode parses the same
 * hook's stdout as STRICT JSON instead — a non-JSON payload only reaches
 * the log, never the context — so the identical command takes
 * `--context-json` and wraps the text in the documented
 * `hookSpecificOutput` envelope (the officially recommended shape; the
 * event name must match `UserPromptSubmit` or the whole payload is
 * dropped, unknown keys are ignored).
 *
 * INVARIANT — the caller must emit this output AT MOST ONCE per action.
 * Multiple emissions concatenate into invalid JSON (two objects back to
 * back), which strict-JSON clients like ZCode parse as garbage and drop
 * silently — the context never reaches the model and nothing errors.
 *
 * Pure and side-effect-free, and deliberately kept OUT of
 * `bin/codegraph.ts` (which runs `program.parse()` at import time) so the
 * wrapping can be unit-tested by importing this module directly.
 */
export function wrapPromptHookOutput(text: string, contextJson: boolean): string {
  if (!contextJson) return text;
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: text,
      },
    }) + '\n'
  );
}
