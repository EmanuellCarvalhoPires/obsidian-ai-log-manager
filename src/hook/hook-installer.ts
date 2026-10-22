// Registers the hook script in the Claude Code settings (settings.json). Pure functions over the
// parsed settings, so they are easy to test; the plugin does the reading and writing.

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PostToolUse"] as const;

/** Events that only apply to some tools. */
const MATCHERS: Partial<Record<(typeof HOOK_EVENTS)[number], string>> = { PostToolUse: "Bash" };
const SCRIPT_MARK = "ai-log-manager-hook.mjs";

interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

export type ClaudeSettings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

/** Command that runs the script; forward slashes work on Windows too. */
export function hookCommand(scriptPath: string): string {
  return `node "${scriptPath.replace(/\\/g, "/")}"`;
}

function isOurs(entry: HookCommand): boolean {
  return typeof entry.command === "string" && entry.command.includes(SCRIPT_MARK);
}

export function installedEvents(settings: ClaudeSettings, scriptPath?: string): string[] {
  const wanted = scriptPath ? hookCommand(scriptPath) : undefined;
  return HOOK_EVENTS.filter((event) =>
    (settings.hooks?.[event] ?? []).some((g) => (g.hooks ?? []).some((h) => isOurs(h) && (!wanted || h.command === wanted))),
  );
}

export function hooksInstalled(settings: ClaudeSettings, scriptPath: string): boolean {
  return installedEvents(settings, scriptPath).length === HOOK_EVENTS.length;
}

/**
 * Adds the four events. An older entry of this plugin (another vault, an old path) for the same
 * script path is replaced; entries of other tools are never touched.
 */
export function mergeHooks(settings: ClaudeSettings, scriptPath: string): { settings: ClaudeSettings; changed: boolean } {
  const command = hookCommand(scriptPath);
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const groups = (next.hooks?.[event] ?? []).map((g) => ({ ...g, hooks: [...(g.hooks ?? [])] }));
    const present = groups.some((g) => g.hooks.some((h) => h.command === command));
    if (!present) {
      const matcher = MATCHERS[event];
      groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 10 }] });
      changed = true;
    }
    next.hooks![event] = groups;
  }
  return { settings: next, changed };
}

/** Removes the entries of this plugin for the given script path (uninstall). */
export function removeHooks(settings: ClaudeSettings, scriptPath: string): { settings: ClaudeSettings; changed: boolean } {
  const command = hookCommand(scriptPath);
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const groups = (next.hooks?.[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => h.command !== command) }))
      .filter((g) => g.hooks.length > 0);
    const before = (next.hooks?.[event] ?? []).reduce((n, g) => n + (g.hooks?.length ?? 0), 0);
    const after = groups.reduce((n, g) => n + g.hooks.length, 0);
    if (after !== before) changed = true;
    if (groups.length > 0) next.hooks![event] = groups;
    else delete next.hooks![event];
  }
  return { settings: next, changed };
}
