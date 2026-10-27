// Guided setup of the module (the AI Ecosystem flow that runs the skill `configurar-ai-log-manager`
// the first time the module is installed): reports what the plugin detects and applies the
// answers. Every function tolerates an older AI Ecosystem without the hooks service.
import { HOOKS_SERVICE } from "./types";
import type { AIEcosystemAPI, HooksService, SetupHandler } from "./types";
import type { LogSettings } from "../core/ports";

export const SETUP_MODULE_ID = "ai-log-manager";

/** Keys the guided setup may save, mapped to settings. */
export const SETUP_KEYS = [
  "modo_dos_logs",
  "pastas_acompanhadas",
  "instalar_hooks",
  "pasta_dos_projetos",
] as const;

/** Keys of older guided setups that recorded development events (moved to AI Git Tools): accepted and ignored. */
const IGNORED_SETUP_KEYS: readonly string[] = ["registrar_eventos_dev", "ler_remoto"];

export interface SetupDeps {
  getSettings: () => LogSettings;
  saveSettings: () => Promise<void>;
  /** Facts read from the vault and the disk, never secret values. */
  facts: () => Promise<{
    existingLogs: number;
    projectsWithClone: string[];
    hooksInstalled: boolean;
    claudeHomeFound: boolean;
  }>;
  folderExists: (path: string) => boolean;
  /** Writes the Claude Code hooks (the person already agreed in the interview). */
  installHooks: () => Promise<void>;
}

/** Accepts true/false, "true"/"false" and "sim"/"nao". */
export function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (["true", "sim", "yes", "s"].includes(v)) return true;
  if (["false", "nao", "não", "no", "n"].includes(v)) return false;
  return undefined;
}

function isVaultFolder(value: string): boolean {
  const parts = value.trim().replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  return parts.length > 0 && !parts.some((p) => p === ".." || p.startsWith(".")) && !/^[A-Za-z]:$/.test(parts[0] ?? "");
}

export function createSetupHandler(deps: SetupDeps): SetupHandler {
  return {
    detect: async () => {
      const s = deps.getSettings();
      const facts = await deps.facts();
      return {
        mode: s.mode,
        watch: s.watch,
        trackedFolders: s.trackedFolders,
        projectsRoot: s.projectsRoot,
        projectsRootExists: deps.folderExists(s.projectsRoot),
        existingLogs: facts.existingLogs,
        projectsWithClone: facts.projectsWithClone,
        hooksInstalled: facts.hooksInstalled,
        claudeHomeFound: facts.claudeHomeFound,
      };
    },
    save: async (key, value) => {
      if (IGNORED_SETUP_KEYS.includes(key)) return undefined;
      const s = deps.getSettings();
      switch (key) {
        case "modo_dos_logs":
          if (value !== "active" && value !== "observe") return 'modo_dos_logs must be "active" or "observe"';
          s.mode = value;
          break;
        case "pastas_acompanhadas":
          if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return "pastas_acompanhadas must be a list of absolute folder paths";
          s.trackedFolders = [...new Set((value as string[]).map((v) => v.trim()).filter((v) => v !== ""))];
          break;
        case "instalar_hooks": {
          const b = toBoolean(value);
          if (b === undefined) return "instalar_hooks must be true or false";
          if (b) {
            try {
              await deps.installHooks();
            } catch (err) {
              return `Could not install the hooks: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
          return undefined;
        }
        case "pasta_dos_projetos":
          if (typeof value !== "string" || !isVaultFolder(value)) return "pasta_dos_projetos must be a vault-relative folder without '..' or hidden segments";
          s.projectsRoot = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
          break;
        default:
          return `Unknown key "${key}". Accepted keys: ${SETUP_KEYS.join(", ")}`;
      }
      await deps.saveSettings();
      return undefined;
    },
    validate: () => {
      const missing: string[] = [];
      if (!deps.getSettings().projectsRoot.trim()) missing.push("projects folder is empty");
      return Promise.resolve(missing.length === 0 ? { ok: true } : { ok: false, missing });
    },
  };
}

/** Registers the setup handler. Returns the unregister function (a no-op when the service is missing). */
export function registerSetupHandler(api: AIEcosystemAPI | undefined, handler: SetupHandler): () => void {
  try {
    const hooks = api?.getService<HooksService>(HOOKS_SERVICE);
    if (!hooks || typeof hooks.registerSetupHandler !== "function") return () => undefined;
    return hooks.registerSetupHandler(SETUP_MODULE_ID, handler);
  } catch (err) {
    console.debug("[AI Log Manager] Could not register the setup handler", err);
    return () => undefined;
  }
}
