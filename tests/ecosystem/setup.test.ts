import { describe, expect, it } from "vitest";
import { DEFAULT_LOG_SETTINGS } from "../../src/core/ports";
import { SETUP_KEYS, createSetupHandler, toBoolean } from "../../src/ecosystem/setup";

function make(over: Partial<{ hooks: boolean }> = {}) {
  const settings = { ...DEFAULT_LOG_SETTINGS };
  let saved = 0;
  let hooks = 0;
  const handler = createSetupHandler({
    getSettings: () => settings,
    saveSettings: async () => void (saved += 1),
    facts: async () => ({ existingLogs: 7, projectsWithClone: ["App"], hooksInstalled: over.hooks ?? false, claudeHomeFound: true }),
    folderExists: (p) => p === "Projetos",
    installHooks: async () => void (hooks += 1),
  });
  return { settings, handler, saved: () => saved, hooks: () => hooks };
}

describe("setup handler", () => {
  it("detects facts without secrets", async () => {
    const { handler } = make();
    const d = await handler.detect!();
    expect(d).toMatchObject({ mode: "active", existingLogs: 7, projectsWithClone: ["App"], projectsRootExists: true, hooksInstalled: false });
  });

  it("applies each answer to the settings", async () => {
    const h = make();
    expect(await h.handler.save!("modo_dos_logs", "observe")).toBeUndefined();
    expect(await h.handler.save!("pastas_acompanhadas", [" C:/Dev ", "C:/Dev", ""])).toBeUndefined();
    expect(await h.handler.save!("registrar_eventos_dev", "nao")).toBeUndefined();
    expect(await h.handler.save!("ler_remoto", true)).toBeUndefined();
    expect(await h.handler.save!("pasta_dos_projetos", "Dev/Projetos/")).toBeUndefined();
    expect(h.settings).toMatchObject({ mode: "observe", trackedFolders: ["C:/Dev"], devEnabled: false, remoteEnabled: true, projectsRoot: "Dev/Projetos" });
    expect(h.saved()).toBe(5);
  });

  it("installs the hooks only on a yes", async () => {
    const h = make();
    await h.handler.save!("instalar_hooks", "false");
    expect(h.hooks()).toBe(0);
    await h.handler.save!("instalar_hooks", "sim");
    expect(h.hooks()).toBe(1);
  });

  it("refuses invalid values and unknown keys with a clear message", async () => {
    const { handler, settings } = make();
    expect(await handler.save!("modo_dos_logs", "x")).toMatch(/active.*observe/);
    expect(await handler.save!("pasta_dos_projetos", "../fora")).toMatch(/vault-relative/);
    expect(await handler.save!("ler_remoto", "talvez")).toMatch(/true or false/);
    expect(await handler.save!("outra", 1)).toContain(SETUP_KEYS[0]);
    expect(settings.mode).toBe("active");
  });

  it("validates", async () => {
    expect(await make().handler.validate!()).toEqual({ ok: true });
    expect(toBoolean("Não")).toBe(false);
  });
});
