import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeGit } from "../../src/adapters/node-git";
import { CheckpointStore } from "../../src/core/checkpoints";
import { DevService } from "../../src/core/dev-service";
import { DEFAULT_LOG_SETTINGS } from "../../src/core/ports";
import { ProjectTracker } from "../../src/core/project-tracker";
import { buildDevTools } from "../../src/tools/dev-tools";
import type { HubCallContext, HubTool } from "../../src/ecosystem/types";
import { MemoryDisk, MemoryVault } from "../helpers/memory-ports";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function run(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Tester", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-tools-"));
  dirs.push(dir);
  run(dir, "init", "-q", "-b", "main");
  const commit = (file: string, message: string): void => {
    fs.writeFileSync(path.join(dir, file), `${message}\n`);
    run(dir, "add", ".");
    run(dir, "commit", "-q", "-m", message);
  };
  commit("a", "primeiro");
  run(dir, "checkout", "-q", "-b", "feature/x");
  commit("b", "na feature");
  run(dir, "checkout", "-q", "main");
  commit("c", "na main");
  return dir;
}

const CTX = { client: { id: "c", name: "Claude Code" }, moduleId: "ai-log-manager" } as HubCallContext;

function setup() {
  const clone = repo();
  const vault = new MemoryVault();
  vault.projectList = [{ name: "App", folder: "Projetos/App", clonePath: clone }];
  const settings = { ...DEFAULT_LOG_SETTINGS };
  const store = new CheckpointStore({ load: async () => undefined, save: async () => undefined }, () => 1);
  const dev = new DevService(createNodeGit(), vault, store, () => settings, () => undefined);
  const tracker = new ProjectTracker(vault, new MemoryDisk(), () => settings);
  const tools = buildDevTools({ dev, tracker });
  const graph = tools.find((t) => t.name === "dev_graph") as HubTool;
  return { vault, graph };
}

describe("dev_graph", () => {
  it("saves the svg in the vault by default and returns only path, commits and lanes", async () => {
    const { vault, graph } = setup();
    const res = await graph.handler({ projeto: "App" }, CTX);
    expect(res.isError).toBe(false);
    const out = JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["commits", "lanes", "path"]);
    expect(out.path).toBe("Projetos/App/Eventos/Grafos/App - grafo.svg");
    expect(out.commits).toBe(3);
    expect(vault.notes.get(out.path as string)!.startsWith("<svg")).toBe(true);
    expect(JSON.stringify(res)).not.toContain("<svg");
  });

  it("replaces the saved file on the next call instead of failing", async () => {
    const { vault, graph } = setup();
    await graph.handler({ projeto: "App" }, CTX);
    const again = await graph.handler({ projeto: "App", branch: "main" }, CTX);
    expect(again.isError).toBe(false);
    expect(vault.notes.size).toBe(1);
  });

  it('formato "svg" keeps the old behavior and returns the document', async () => {
    const { vault, graph } = setup();
    const res = await graph.handler({ projeto: "App", formato: "svg" }, CTX);
    const out = JSON.parse((res.content[0] as { text: string }).text) as { svg: string; commits: number };
    expect(out.svg.startsWith("<svg")).toBe(true);
    expect(out.commits).toBe(3);
    expect(vault.notes.size).toBe(0);
  });

  it('formato "texto" lists one line per commit with hash, branch and subject', async () => {
    const { vault, graph } = setup();
    const res = await graph.handler({ projeto: "App", formato: "texto" }, CTX);
    const lines = (res.content[0] as { text: string }).text.split("\n");
    expect(lines[0]).toBe("App: 3 commits, 2 lanes");
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toMatch(/[0-9a-f]{7} main na main/);
    expect(lines.join("\n")).toMatch(/[0-9a-f]{7} feature\/x na feature/);
    expect(lines.join("\n")).toMatch(/[0-9a-f]{7} \S+ primeiro/);
    expect(vault.notes.size).toBe(0);
  });

  it("rejects an unknown formato", async () => {
    const { graph } = setup();
    const res = await graph.handler({ projeto: "App", formato: "png" }, CTX);
    expect(res.isError).toBe(true);
  });
});
