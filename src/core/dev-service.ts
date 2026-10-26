// Development events of a project: reads the git repository of its clone, records commits,
// pushes and new branches as notes, adds pull requests and deploys from the remote, builds
// changelogs and draws the repository graph.
import { CheckpointStore } from "./checkpoints";
import type { DevState } from "./checkpoints";
import { detectCommand, eventPath, findPullRequestUrl, renderEventNote, titleFromCommand } from "./dev-events";
import type { DevEvent } from "./dev-events";
import { LOG_FORMAT, layout, parseLog, toSvg, toText } from "./graph";
import type { Highlight, Row } from "./graph";
import type { GitRunner, LogSettings, ProjectInfo, VaultPort } from "./ports";
import { RemoteSync, parseRemoteUrl } from "./remote";
import { sanitizeFilename } from "./text-utils";

export interface DevSyncResult {
  project: string;
  /** First time seen: only the baseline was stored, nothing was recorded. */
  baseline: boolean;
  created: string[];
  errors: string[];
}

export interface GraphResult {
  svg: string;
  rows: Row[];
  lanes: number;
}

const branchOf = (ref: string): string => ref.replace(/^refs\/(heads|remotes\/[^/]+)\//, "");

export class DevService {
  constructor(
    private readonly git: GitRunner,
    private readonly vault: VaultPort,
    private readonly store: CheckpointStore,
    private readonly settings: () => LogSettings,
    private readonly remote: () => RemoteSync | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  eventsFolder(project: ProjectInfo): string {
    return `${project.folder}/${this.settings().eventsFolder}`;
  }

  /** Records one event as a note, once. Returns the path and whether it was created now. */
  async record(project: ProjectInfo, ev: DevEvent): Promise<{ path: string; created: boolean }> {
    const known = this.store.eventNote(ev.id);
    if (known && this.vault.exists(known)) return { path: known, created: false };
    const folder = this.eventsFolder(project);
    const indexName = `${project.name} - Eventos`;
    const indexPath = `${folder}/${sanitizeFilename(indexName)}.md`;
    if (!this.vault.exists(indexPath)) {
      await this.vault.create(
        indexPath,
        `---\ntags:\n  - moc\nup: "[[${project.name}]]"\n---\n# ${indexName}\n\nEventos de desenvolvimento do projeto (commits, pushes, branches, PRs e deploys), um por nota.\n\n` +
          '```dataview\nTABLE WITHOUT ID file.link AS "Evento", evento AS "Tipo", branch AS "Branch", data AS "Data"\nFROM [[]]\n' +
          "WHERE contains(flat(list(up)), this.file.link)\nSORT data DESC\n```\n",
      );
    }
    let path = eventPath(folder, ev);
    if (this.vault.exists(path)) path = path.replace(/\.md$/, ` ${ev.id.slice(-6)}.md`);
    await this.vault.create(path, renderEventNote(ev, indexName));
    this.store.setEventNote(ev.id, path);
    return { path, created: true };
  }

  /** Projects whose clone is a git repository. */
  async repoOf(project: ProjectInfo): Promise<string | undefined> {
    if (!project.clonePath) return undefined;
    try {
      await this.git(project.clonePath, ["rev-parse", "--git-dir"]);
      return project.clonePath;
    } catch {
      return undefined;
    }
  }

  /** Looks at the repository and records what is new since the last sync (also what happened while Obsidian was closed). */
  async sync(project: ProjectInfo, options: { remote?: boolean } = {}): Promise<DevSyncResult> {
    const result: DevSyncResult = { project: project.name, baseline: false, created: [], errors: [] };
    const cwd = await this.repoOf(project);
    if (!cwd) return result;
    const started = this.now();

    try {
      const refsOut = await this.git(cwd, ["for-each-ref", "--format=%(refname)%1f%(objectname)", "refs/heads", "refs/remotes"]);
      const locals: Record<string, string> = {};
      const tips: Record<string, string> = {};
      for (const line of refsOut.split("\n")) {
        const [ref = "", hash = ""] = line.trim().split("\x1f");
        if (!ref || !hash || ref.endsWith("/HEAD")) continue;
        if (ref.startsWith("refs/heads/")) locals[branchOf(ref)] = hash;
        else if (ref.startsWith("refs/remotes/")) tips[ref.slice("refs/remotes/".length)] = hash;
      }

      const state = this.store.getDev(project.name);
      if (!state) {
        this.store.setDev(project.name, { cursorMs: started, tips, branches: Object.keys(locals), prStates: {} });
        result.baseline = true;
        // Commits of the last seconds already exist: they are not events (the next sync overlaps by 2 s).
        try {
          const recent = parseLog(await this.git(cwd, ["log", "--all", LOG_FORMAT, `--since=${new Date(started - 10_000).toISOString()}`, "-n", "50"]));
          for (const c of recent) if (!this.store.eventNote(`commit-${c.hash}`)) this.store.setEventNote(`commit-${c.hash}`, "-");
        } catch {
          // An empty repository has no log yet.
        }
      } else {
        const events: DevEvent[] = [];
        await this.commitEvents(project, cwd, state, events);
        await this.pushEvents(project, cwd, state, tips, events);
        for (const [name, hash] of Object.entries(locals)) {
          if (state.branches.includes(name)) continue;
          events.push({ tipo: "branch", projeto: project.name, id: `branch-${name}-${hash.slice(0, 7)}`, titulo: name, data: new Date(started), branch: name, hash });
        }
        for (const ev of events) {
          const r = await this.record(project, ev);
          if (r.created) result.created.push(r.path);
        }
        this.store.setDev(project.name, { ...state, cursorMs: started, tips, branches: Object.keys(locals) });
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }

    if (options.remote && this.settings().remoteEnabled) {
      try {
        result.created.push(...(await this.syncRemote(project, cwd)));
      } catch (err) {
        result.errors.push(`remote: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  private async commitEvents(project: ProjectInfo, cwd: string, state: DevState, events: DevEvent[]): Promise<void> {
    const since = new Date(Math.max(0, state.cursorMs - 2000)).toISOString();
    const commits = parseLog(await this.git(cwd, ["log", "--all", LOG_FORMAT, `--since=${since}`, "-n", "200"])).reverse();
    for (const c of commits) {
      if (this.store.eventNote(`commit-${c.hash}`)) continue;
      let branch = c.refs.find((r) => !r.startsWith("tag: ") && !/^(origin|upstream)\//.test(r) && r !== "HEAD");
      if (!branch) {
        try {
          branch = (await this.git(cwd, ["name-rev", "--name-only", "--refs=refs/heads/*", c.hash])).trim().replace(/[~^].*$/, "") || undefined;
        } catch {
          branch = undefined;
        }
        if (branch === "undefined") branch = undefined;
      }
      events.push({ tipo: "commit", projeto: project.name, id: `commit-${c.hash}`, titulo: c.subject, data: new Date(c.time * 1000), branch, hash: c.hash, autor: c.author });
    }
  }

  private async pushEvents(project: ProjectInfo, cwd: string, state: DevState, tips: Record<string, string>, events: DevEvent[]): Promise<void> {
    for (const [key, tip] of Object.entries(tips)) {
      const old = state.tips[key];
      if (old === tip) continue;
      const branch = key.slice(key.indexOf("/") + 1);
      let details: string | undefined;
      let count: number | undefined;
      if (old) {
        try {
          count = Number((await this.git(cwd, ["rev-list", "--count", `${old}..${tip}`])).trim());
          const lines = (await this.git(cwd, ["log", `${old}..${tip}`, "--format=- `%h` %s", "-n", "20"])).trim();
          details = lines ? `Commits enviados:\n\n${lines}` : undefined;
        } catch {
          count = undefined;
        }
      }
      events.push({
        tipo: "push",
        projeto: project.name,
        id: `push-${key}-${tip.slice(0, 7)}`,
        titulo: `${branch}${count ? ` (${count} commit${count === 1 ? "" : "s"})` : ""}`,
        data: new Date(this.now()),
        branch,
        hash: tip,
        detalhes: details,
      });
    }
  }

  /** Pull requests and deployments of the remote (needs remoteEnabled and a configured secret). */
  async syncRemote(project: ProjectInfo, cwd: string): Promise<string[]> {
    const remote = this.remote();
    if (!remote) return [];
    const url = (await this.git(cwd, ["remote", "get-url", "origin"])).trim();
    const repo = parseRemoteUrl(url);
    if (!repo) return [];
    const state = this.store.getDev(project.name);
    const prStates = { ...(state?.prStates ?? {}) };
    const created: string[] = [];
    for (const ev of await remote.events(project.name, repo)) {
      if (ev.tipo === "pr" && ev.estado) {
        const known = this.store.eventNote(ev.id);
        if (known && this.vault.exists(known) && prStates[ev.id] && prStates[ev.id] !== ev.estado) {
          await this.vault.process(known, (c) => c.replace(/^estado: ".*"$/m, `estado: "${ev.estado}"`).replace(/^\| Estado \| .* \|$/m, `| Estado | ${ev.estado} |`));
        }
        prStates[ev.id] = ev.estado;
      }
      const r = await this.record(project, ev);
      if (r.created) created.push(r.path);
    }
    if (state) this.store.setDev(project.name, { ...state, prStates });
    return created;
  }

  /** A PostToolUse command of Claude Code: records what it did. */
  async onCommand(project: ProjectInfo, command: string | undefined, output: string | undefined): Promise<{ action: string; created: string[] }> {
    const kind = detectCommand(command);
    if (!kind) return { action: "ignored", created: [] };
    if (kind === "pr-create") {
      const pr = findPullRequestUrl(output);
      if (!pr) return { action: "pr-without-url", created: [] };
      const r = await this.record(project, {
        tipo: "pr",
        projeto: project.name,
        id: `pr-${pr.host}-${pr.repo}-${pr.number}`,
        titulo: titleFromCommand(command) ?? `PR ${pr.number}`,
        data: new Date(this.now()),
        url: pr.url,
        estado: "open",
      });
      return { action: "pr", created: r.created ? [r.path] : [] };
    }
    if (kind === "init") return { action: "init", created: [] };
    const res = await this.sync(project, { remote: kind === "pr-merge" });
    return { action: kind, created: res.created };
  }

  /** The repository graph of a project (newest commits of all branches). */
  async graph(project: ProjectInfo, options: { limit?: number; highlight?: Highlight; width?: number } = {}): Promise<GraphResult> {
    const cwd = await this.repoOf(project);
    if (!cwd) throw new Error(`The project "${project.name}" has no git clone.`);
    const limit = options.limit ?? this.settings().graphLimit;
    const commits = parseLog(await this.git(cwd, ["log", "--all", "--date-order", LOG_FORMAT, "-n", String(limit)]));
    const { rows, lanes } = layout(commits);
    return { svg: toSvg(rows, lanes, this.now(), options.width ?? 320, options.highlight ?? {}), rows, lanes };
  }

  /**
   * Draws the repository graph and saves it as an SVG file in the events folder of the project
   * (`Grafos/<project> - grafo.svg`, replaced on every call), so the SVG never travels in the answer.
   */
  async saveGraph(project: ProjectInfo, options: { limit?: number; highlight?: Highlight; width?: number } = {}): Promise<{ path: string; commits: number; lanes: number }> {
    const g = await this.graph(project, options);
    const folder = `${this.eventsFolder(project)}/Grafos`;
    const path = `${folder}/${sanitizeFilename(`${project.name} - grafo`)}.svg`;
    if (this.vault.exists(path)) await this.vault.process(path, () => g.svg);
    else await this.vault.create(path, g.svg);
    return { path, commits: g.rows.length, lanes: g.lanes };
  }

  /** The graph as one line per commit (`hash7 branch subject`), for a cheap look at the history. */
  async graphText(project: ProjectInfo, options: { limit?: number } = {}): Promise<{ lines: string[]; commits: number; lanes: number }> {
    const g = await this.graph(project, { limit: options.limit });
    return { lines: toText(g.rows), commits: g.rows.length, lanes: g.lanes };
  }

  /** Changelog note of a release, from the git history between two refs (default: last tag to HEAD). */
  async changelog(project: ProjectInfo, options: { desde?: string; ate?: string; versao?: string } = {}): Promise<{ path: string; commits: number; created: boolean }> {
    const cwd = await this.repoOf(project);
    if (!cwd) throw new Error(`The project "${project.name}" has no git clone.`);
    const ate = options.ate ?? "HEAD";
    let desde = options.desde;
    if (!desde) {
      try {
        desde = (await this.git(cwd, ["describe", "--tags", "--abbrev=0", ate === "HEAD" ? "HEAD" : ate])).trim() || undefined;
      } catch {
        desde = undefined;
      }
    }
    const range = desde ? `${desde}..${ate}` : ate;
    const commits = parseLog(await this.git(cwd, ["log", range, LOG_FORMAT, "-n", "500"]));
    let versao = options.versao;
    if (!versao) {
      try {
        versao = (await this.git(cwd, ["describe", "--tags", "--abbrev=0", ate])).trim();
      } catch {
        versao = undefined;
      }
      versao = versao && versao !== desde ? versao : new Date(this.now()).toISOString().slice(0, 10);
    }
    const prs = new Map<string, string>();
    for (const c of commits) {
      const m = /\(#(\d+)\)\s*$/.exec(c.subject) ?? /^Merge pull request #(\d+)/.exec(c.subject);
      if (m?.[1]) prs.set(m[1], c.subject);
    }
    const folder = `${project.folder}/Changelogs`;
    const name = `${project.name} - ${versao}`;
    const path = `${folder}/${sanitizeFilename(name)}.md`;
    if (this.vault.exists(path)) return { path, commits: commits.length, created: false };
    const body = [
      "---",
      "tags:",
      "  - dev/changelog",
      `up: "[[${project.name} - Changelog]]"`,
      `projeto: "[[${project.name}]]"`,
      `versao: "${versao}"`,
      "---",
      `# ${name}`,
      "",
      `Alterações ${desde ? `de \`${desde}\` até \`${ate}\`` : `até \`${ate}\``} (${commits.length} commit${commits.length === 1 ? "" : "s"}).`,
      "",
      ...(prs.size > 0 ? ["## Pull requests", "", ...[...prs].map(([n, s]) => `- #${n} ${s}`), ""] : []),
      "## Commits",
      "",
      ...(commits.length > 0 ? commits.map((c) => `- \`${c.hash.slice(0, 7)}\` ${c.subject} (${c.author})`) : ["- Nenhum commit no intervalo."]),
      "",
      "## Grafo do repositório",
      "",
      "```ai-log-graph",
      `projeto: ${project.name}`,
      "```",
      "",
    ].join("\n");
    await this.vault.create(path, body);
    return { path, commits: commits.length, created: true };
  }
}
