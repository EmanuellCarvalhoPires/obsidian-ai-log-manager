import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeGit } from "../../src/adapters/node-git";
import { CheckpointStore } from "../../src/core/checkpoints";
import { DevService } from "../../src/core/dev-service";
import { detectCommand, findPullRequestUrl, parseGraphBlock, renderEventNote, titleFromCommand } from "../../src/core/dev-events";
import { layout, parseLog, LOG_FORMAT, toSvg } from "../../src/core/graph";
import { DEFAULT_LOG_SETTINGS } from "../../src/core/ports";
import type { ProjectInfo, SecureHttp } from "../../src/core/ports";
import { RemoteSync, parseRemoteUrl } from "../../src/core/remote";
import { MemoryVault } from "../helpers/memory-ports";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Tester", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-git-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

function commit(dir: string, file: string, message: string): void {
  fs.writeFileSync(path.join(dir, file), `${message}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", message);
}

function harness(clone: string, over: Partial<typeof DEFAULT_LOG_SETTINGS> = {}, remote?: RemoteSync) {
  const vault = new MemoryVault();
  const store = new CheckpointStore({ load: async () => undefined, save: async () => undefined }, () => 1);
  const settings = { ...DEFAULT_LOG_SETTINGS, ...over };
  const dev = new DevService(createNodeGit(), vault, store, () => settings, () => remote);
  const project: ProjectInfo = { name: "App", folder: "Projetos/App", clonePath: clone };
  return { vault, store, dev, project };
}

describe("graph", () => {
  it("lays out a merge and draws an svg with the highlight", async () => {
    const dir = makeRepo();
    commit(dir, "a", "primeiro");
    git(dir, "checkout", "-q", "-b", "feature/x");
    commit(dir, "b", "na feature");
    git(dir, "checkout", "-q", "main");
    commit(dir, "c", "na main");
    git(dir, "merge", "-q", "--no-ff", "-m", "Merge feature", "feature/x");
    git(dir, "tag", "v1");
    const commits = parseLog(await createNodeGit()(dir, ["log", "--all", "--date-order", LOG_FORMAT]));
    expect(commits).toHaveLength(4);
    const { rows, lanes } = layout(commits);
    expect(lanes).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.refs).toContain("tag: v1");
    const svg = toSvg(rows, lanes, Date.now(), 320, { branch: "feature/x", hash: commits[3]!.hash.slice(0, 7) });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("na feature");
    expect(svg).toContain('class="hl"');
  });
});

describe("dev events", () => {
  it("stores a baseline first and records nothing", async () => {
    const dir = makeRepo();
    commit(dir, "a", "antigo");
    const h = harness(dir);
    const res = await h.dev.sync(h.project);
    expect(res.baseline).toBe(true);
    expect(h.vault.notes.size).toBe(0);
  });

  it("records new commits once, with the graph block, and a new branch", async () => {
    const dir = makeRepo();
    commit(dir, "a", "antigo");
    const h = harness(dir);
    await h.dev.sync(h.project);
    commit(dir, "b", "feat: primeira mudança");
    git(dir, "branch", "feature/nova");
    const res = await h.dev.sync(h.project);
    expect(res.errors).toEqual([]);
    const paths = [...h.vault.notes.keys()];
    const commitNote = paths.find((p) => p.includes("/Eventos/Commit ") && p.includes("mudança"))!;
    expect(commitNote).toBeDefined();
    expect(paths.filter((p) => p.includes("/Eventos/Commit "))).toHaveLength(1);
    const body = h.vault.notes.get(commitNote)!;
    expect(body).toContain("  - dev/commit");
    expect(body).toContain('up: "[[App - Eventos]]"');
    expect(body).toContain("```ai-log-graph");
    expect(body).toContain("hash: ");
    expect(paths.some((p) => p.endsWith("/Eventos/Branch feature-nova.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/Eventos/App - Eventos.md"))).toBe(true);
    const count = h.vault.notes.size;
    await h.dev.sync(h.project);
    expect(h.vault.notes.size).toBe(count);
  });

  it("rebuilds the notes of commits made while Obsidian was closed", async () => {
    const dir = makeRepo();
    commit(dir, "a", "antigo");
    const h = harness(dir);
    await h.dev.sync(h.project);
    commit(dir, "b", "um");
    commit(dir, "c", "dois");
    commit(dir, "d", "tres");
    await h.dev.sync(h.project);
    expect([...h.vault.notes.keys()].filter((p) => /\/Eventos\/Commit /.test(p))).toHaveLength(3);
  });

  it("detects a push by the remote-tracking branch moving", async () => {
    const dir = makeRepo();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ailm-bare-"));
    dirs.push(bare);
    git(bare, "init", "-q", "--bare", "-b", "main");
    commit(dir, "a", "antigo");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "-u", "origin", "main");
    const h = harness(dir);
    await h.dev.sync(h.project);
    commit(dir, "b", "novo");
    git(dir, "push", "-q");
    await h.dev.sync(h.project);
    const push = [...h.vault.notes.entries()].find(([p]) => /\/Eventos\/Push main/.test(p));
    expect(push).toBeDefined();
    expect(push![1]).toContain("  - dev/push");
    expect(push![1]).toContain("Commits enviados");
  });

  it("records the PR that gh pr create printed, and ignores other commands", async () => {
    const dir = makeRepo();
    commit(dir, "a", "x");
    const h = harness(dir);
    await h.dev.sync(h.project);
    const out = "Creating pull request\nhttps://github.com/o/r/pull/12\n";
    const cmd = 'gh pr create --title "Minha PR" --body x';
    const res = await h.dev.onCommand(h.project, cmd, out);
    expect(res.action).toBe("pr");
    const note = [...h.vault.notes.entries()].find(([p]) => p.includes("/Eventos/PR 12"));
    expect(note![1]).toContain("| Link | https://github.com/o/r/pull/12 |");
    expect((await h.dev.onCommand(h.project, cmd, out)).created).toEqual([]);
    expect((await h.dev.onCommand(h.project, "npm test", "")).action).toBe("ignored");
  });

  it("builds a changelog from the last tag", async () => {
    const dir = makeRepo();
    commit(dir, "a", "inicial");
    git(dir, "tag", "v1.0.0");
    commit(dir, "b", "corrige bug (#7)");
    commit(dir, "c", "nova função");
    const h = harness(dir);
    const res = await h.dev.changelog(h.project, { versao: "v1.1.0" });
    expect(res.commits).toBe(2);
    const body = h.vault.notes.get(res.path)!;
    expect(res.path).toBe("Projetos/App/Changelogs/App - v1.1.0.md");
    expect(body).toContain("  - dev/changelog");
    expect(body).toContain("- #7 corrige bug (#7)");
    expect(body).toContain("nova função");
    expect(body).not.toContain("inicial");
    expect((await h.dev.changelog(h.project, { versao: "v1.1.0" })).created).toBe(false);
  });

  it("graph() fails clearly for a project without a clone", async () => {
    const h = harness("C:/nao/existe");
    await expect(h.dev.graph({ name: "App", folder: "Projetos/App", clonePath: undefined })).rejects.toThrow(/no git clone/);
  });
});

describe("remote", () => {
  it("parses remote urls", () => {
    expect(parseRemoteUrl("git@github.com:o/r.git")).toEqual({ host: "github", repo: "o/r" });
    expect(parseRemoteUrl("https://user@bitbucket.org/ws/rp.git")).toEqual({ host: "bitbucket", repo: "ws/rp" });
    expect(parseRemoteUrl("https://example.com/x/y.git")).toBeUndefined();
  });

  it("reads GitHub PRs and deployments through the secure channel, and updates a PR state", async () => {
    const dir = makeRepo();
    commit(dir, "a", "x");
    git(dir, "remote", "add", "origin", "git@github.com:o/r.git");
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    let merged = false;
    const http: SecureHttp = async (req) => {
      seen.push({ url: req.url, auth: req.headers.Authorization });
      if (req.url.includes("/pulls"))
        return {
          status: 200,
          body: JSON.stringify([
            { number: 5, title: "Add x", state: merged ? "closed" : "open", merged_at: merged ? "2026-10-21T10:00:00Z" : null, html_url: "https://github.com/o/r/pull/5", head: { ref: "feat" }, user: { login: "ana" }, updated_at: "2026-10-21T09:00:00Z" },
          ]),
        };
      if (req.url.includes("/statuses")) return { status: 200, body: JSON.stringify([{ state: "success" }]) };
      return { status: 200, body: JSON.stringify([{ id: 9, environment: "production", sha: "abcdef1234", ref: "main", created_at: "2026-10-21T09:30:00Z", creator: { login: "ana" } }]) };
    };
    const remote = new RemoteSync(http, () => ({ github: "GITHUB_TOKEN", bitbucket: "BB" }));
    const h = harness(dir, { remoteEnabled: true }, remote);
    await h.dev.sync(h.project);
    const first = await h.dev.sync(h.project, { remote: true });
    expect(first.errors).toEqual([]);
    expect(first.created.some((p) => p.includes("/Eventos/PR 5"))).toBe(true);
    expect(first.created.some((p) => p.includes("/Eventos/Deploy production"))).toBe(true);
    expect(seen.every((s) => s.auth === "{{bearer:GITHUB_TOKEN}}")).toBe(true);
    merged = true;
    await h.dev.sync(h.project, { remote: true });
    const pr = [...h.vault.notes.entries()].find(([p]) => p.includes("/Eventos/PR 5"))![1];
    expect(pr).toContain('estado: "merged"');
    expect(pr).toContain("| Estado | merged |");
  });

  it("reports a remote failure without losing the local events", async () => {
    const dir = makeRepo();
    commit(dir, "a", "x");
    git(dir, "remote", "add", "origin", "git@github.com:o/r.git");
    const remote = new RemoteSync(async () => ({ status: 401, body: "" }), () => ({ github: "T", bitbucket: "B" }));
    const h = harness(dir, { remoteEnabled: true }, remote);
    await h.dev.sync(h.project);
    commit(dir, "b", "novo");
    const res = await h.dev.sync(h.project, { remote: true });
    expect(res.created.some((p) => p.includes("/Eventos/Commit "))).toBe(true);
    expect(res.errors[0]).toMatch(/remote:.*401/);
  });
});

describe("event helpers", () => {
  it("detects the commands that matter", () => {
    expect(detectCommand('git commit -m "x"')).toBe("commit");
    expect(detectCommand("git -C app push origin main")).toBe("push");
    expect(detectCommand("gh pr create --fill")).toBe("pr-create");
    expect(detectCommand("git checkout -b feature/x")).toBe("branch");
    expect(detectCommand("git status")).toBeUndefined();
    expect(detectCommand("npm test")).toBeUndefined();
  });

  it("finds PR urls and titles", () => {
    expect(findPullRequestUrl("ok https://bitbucket.org/ws/r/pull-requests/3 done")).toMatchObject({ host: "bitbucket", number: "3", repo: "ws/r" });
    expect(titleFromCommand("gh pr create -t 'Título aqui' --body y")).toBe("Título aqui");
  });

  it("round-trips the graph block", () => {
    const note = renderEventNote({ tipo: "commit", projeto: "App", id: "c1", titulo: "t", data: new Date(0), branch: "main", hash: "abcdef123456" }, "App - Eventos");
    const block = /```ai-log-graph\n([\s\S]*?)```/.exec(note)![1]!;
    expect(parseGraphBlock(block)).toEqual({ projeto: "App", branch: "main", hash: "abcdef123456" });
  });
});
