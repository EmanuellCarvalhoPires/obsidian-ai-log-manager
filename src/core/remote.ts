// Pull requests and deployments of the remote repository (GitHub or Bitbucket), read through
// Environment Keys: the token is only a placeholder here ({{bearer:NAME}}), never a value.
import type { DevEvent } from "./dev-events";
import type { SecureHttp } from "./ports";

export interface RemoteRepo {
  host: "github" | "bitbucket";
  /** owner/repo (GitHub) or workspace/repo (Bitbucket). */
  repo: string;
}

/** `git@github.com:o/r.git`, `https://github.com/o/r.git`, `https://u@bitbucket.org/w/r.git`. */
export function parseRemoteUrl(url: string): RemoteRepo | undefined {
  const m = /(github\.com|bitbucket\.org)[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m) return undefined;
  return { host: (m[1] ?? "").toLowerCase().startsWith("github") ? "github" : "bitbucket", repo: `${m[2]}/${m[3]}` };
}

export interface RemoteSecrets {
  github: string;
  bitbucket: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
/** A number or string id as text. */
const idText = (v: unknown): string => (typeof v === "number" || typeof v === "string" ? String(v) : "");
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);

export class RemoteError extends Error {}

export class RemoteSync {
  constructor(
    private readonly http: SecureHttp,
    private readonly secrets: () => RemoteSecrets,
  ) {}

  async events(project: string, repo: RemoteRepo): Promise<DevEvent[]> {
    return repo.host === "github" ? this.github(project, repo.repo) : this.bitbucket(project, repo.repo);
  }

  private async get(url: string, tokenName: string, extra: Record<string, string> = {}): Promise<Json> {
    if (!tokenName) throw new RemoteError("No secret name configured for this host.");
    const res = await this.http({
      method: "GET",
      url,
      headers: { Authorization: `{{bearer:${tokenName}}}`, "User-Agent": "obsidian-ai-log-manager", ...extra },
    });
    if (res.status < 200 || res.status >= 300) throw new RemoteError(`${url} answered ${res.status}`);
    try {
      const parsed: unknown = JSON.parse(res.body);
      return Array.isArray(parsed) ? { values: parsed } : obj(parsed);
    } catch {
      throw new RemoteError(`${url} did not return JSON`);
    }
  }

  private async github(project: string, repo: string): Promise<DevEvent[]> {
    const token = this.secrets().github;
    const accept = { Accept: "application/vnd.github+json" };
    const out: DevEvent[] = [];
    const prs = await this.get(`https://api.github.com/repos/${repo}/pulls?state=all&per_page=30&sort=updated&direction=desc`, token, accept);
    for (const pr of list(prs.values)) {
      const n = idText(pr.number);
      if (!n) continue;
      const merged = str(pr.merged_at);
      out.push({
        tipo: "pr",
        projeto: project,
        id: `pr-github-${repo}-${n}`,
        titulo: str(pr.title) ?? `PR ${n}`,
        data: new Date(str(pr.updated_at) ?? Date.now()),
        branch: str(obj(pr.head).ref),
        hash: str(merged ? pr.merge_commit_sha : obj(pr.head).sha),
        url: str(pr.html_url),
        autor: str(obj(pr.user).login),
        estado: merged ? "merged" : str(pr.state) === "open" ? "open" : "declined",
      });
    }
    const deployments = await this.get(`https://api.github.com/repos/${repo}/deployments?per_page=10`, token, accept);
    for (const d of list(deployments.values)) {
      const id = idText(d.id);
      if (!id) continue;
      let state: string | undefined;
      try {
        const statuses = await this.get(`https://api.github.com/repos/${repo}/deployments/${id}/statuses?per_page=1`, token, accept);
        state = str(list(statuses.values)[0]?.state);
      } catch {
        state = undefined;
      }
      out.push({
        tipo: "deploy",
        projeto: project,
        id: `deploy-github-${repo}-${id}`,
        titulo: `${str(d.environment) ?? "ambiente"} ${str(d.sha)?.slice(0, 7) ?? ""}`.trim(),
        data: new Date(str(d.created_at) ?? Date.now()),
        branch: str(d.ref),
        hash: str(d.sha),
        autor: str(obj(d.creator).login),
        ambiente: str(d.environment),
        estado: state,
        url: `https://github.com/${repo}/deployments`,
      });
    }
    return out;
  }

  private async bitbucket(project: string, repo: string): Promise<DevEvent[]> {
    const token = this.secrets().bitbucket;
    const out: DevEvent[] = [];
    const prs = await this.get(`https://api.bitbucket.org/2.0/repositories/${repo}/pullrequests?state=ALL&pagelen=30&sort=-updated_on`, token);
    for (const pr of list(prs.values)) {
      const n = idText(pr.id);
      if (!n) continue;
      const state = (str(pr.state) ?? "").toLowerCase();
      out.push({
        tipo: "pr",
        projeto: project,
        id: `pr-bitbucket-${repo}-${n}`,
        titulo: str(pr.title) ?? `PR ${n}`,
        data: new Date(str(pr.updated_on) ?? Date.now()),
        branch: str(obj(obj(pr.source).branch).name),
        hash: str(obj(pr.merge_commit).hash),
        url: str(obj(obj(pr.links).html).href),
        autor: str(obj(pr.author).display_name),
        estado: state === "open" ? "open" : state === "merged" ? "merged" : "declined",
      });
    }
    const deployments = await this.get(`https://api.bitbucket.org/2.0/repositories/${repo}/deployments/?pagelen=10&sort=-state.started_on`, token);
    for (const d of list(deployments.values)) {
      const uuid = str(d.uuid)?.replace(/[{}]/g, "");
      if (!uuid) continue;
      const state = obj(d.state);
      const env = str(obj(d.environment).name) ?? str(obj(d.environment).uuid);
      out.push({
        tipo: "deploy",
        projeto: project,
        id: `deploy-bitbucket-${repo}-${uuid}`,
        titulo: `${env ?? "ambiente"} ${str(obj(obj(d.release).commit).hash)?.slice(0, 7) ?? ""}`.trim(),
        data: new Date(str(state.started_on) ?? Date.now()),
        hash: str(obj(obj(d.release).commit).hash),
        ambiente: env,
        estado: str(obj(state.status).name) ?? str(state.name),
        url: `https://bitbucket.org/${repo}/deployments`,
      });
    }
    return out;
  }
}
