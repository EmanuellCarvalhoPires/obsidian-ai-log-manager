// Creates the vault side of a new development project (decision D7, only after the user said yes):
// the project note, the Logs and Changelog indexes, the Branches folder and the project CLAUDE.md.
// Same structure as `log_desenvolvimento.py projeto` for a project without Jira.
import type { LogSettings, VaultPort } from "./ports";
import { sanitizeFilename } from "./text-utils";

/** Part of the AI Templates service that is used here; the service may not offer it. */
export interface TemplateNoteCreator {
  createNote?(args: { templateId: string; data: Record<string, unknown> }): Promise<{ filePath: string }>;
}

export interface NewProject {
  name: string;
  clonePath: string;
  summary?: string;
}

function projectNote(p: NewProject): string {
  return [
    "---",
    "tags:",
    "  - dev/projeto",
    'up: "[[Projetos]]"',
    "---",
    `# ${p.name}`,
    "",
    p.summary?.trim() || `Projeto de desenvolvimento ${p.name} (desenvolvimento comum, sem Jira).`,
    "",
    "## Acesso",
    `- **Clone local:** \`${p.clonePath}\``,
    "- **Hospedagem:** git local (sem repositório remoto cadastrado)",
    "- **Branch de integração:** `main`",
    "",
    "## Registros",
    `- [[${p.name} - Logs]]`,
    `- [[${p.name} - Changelog]]`,
    "",
  ].join("\n");
}

function indexNote(name: string, suffix: string, description: string): string {
  return (
    `---\ntags:\n  - moc\nup: "[[${name}]]"\n---\n# ${name} - ${suffix}\n\n${description}\n\n` +
    '```dataview\nTABLE WITHOUT ID file.link AS "Nota", file.ctime AS "Criada em"\nFROM [[]]\n' +
    "WHERE contains(flat(list(up)), this.file.link)\nSORT file.ctime DESC\n```\n"
  );
}

function claudeMd(p: NewProject): string {
  return [
    `# CLAUDE.md — ${p.name} (desenvolvimento comum)`,
    "",
    `Regras do fluxo para o projeto **${p.name}**. Complementam o CLAUDE.md do cofre e só vencem em caso de conflito.`,
    "",
    "## Onde estão as coisas",
    `- **Nota principal:** [[${p.name}]]`,
    `- **Clone local:** \`${p.clonePath}\`. As regras de código ficam no \`CLAUDE.md\` ou \`README\` da raiz do repositório, se existirem: leia antes de mexer no código.`,
    "",
    "## Regras",
    "1. O Claude não cria repositório remoto sem pedido explícito.",
    "2. Commit e push só quando o usuário pedir. Merge é sempre do usuário.",
    "3. Rode os testes ou o build do projeto e diga o que foi verificado e o que não foi.",
    "4. Segredos só por placeholder; confirme antes de gravar fora do cofre.",
    "",
  ].join("\n");
}

export class ProjectCreator {
  constructor(
    private readonly vault: VaultPort,
    private readonly settings: () => LogSettings,
    private readonly templates: () => TemplateNoteCreator | undefined,
  ) {}

  /** Folder of the project in the vault. */
  folderOf(name: string): string {
    return `${this.settings().projectsRoot}/${sanitizeFilename(name)}`;
  }

  async create(project: NewProject): Promise<{ folder: string; notes: string[] }> {
    const folder = this.folderOf(project.name);
    const notes: string[] = [];
    const write = async (path: string, content: string): Promise<void> => {
      if (this.vault.exists(path)) return;
      await this.vault.create(path, content);
      notes.push(path);
    };

    const mainPath = `${folder}/${sanitizeFilename(project.name)}.md`;
    if (!this.vault.exists(mainPath)) {
      let done = false;
      const creator = this.templates();
      if (creator?.createNote) {
        try {
          const res = await creator.createNote({
            templateId: "projeto_desenvolvimento",
            data: {
              projeto: project.name,
              clone_local: project.clonePath,
              resumo: project.summary?.trim() || `Projeto de desenvolvimento ${project.name}.`,
              hospedagem: "local",
              acesso: `- **Clone local:** \`${project.clonePath}\``,
            },
          });
          notes.push(res.filePath);
          done = true;
        } catch {
          // The template is optional: fall back to the built-in note below.
        }
      }
      if (!done) await write(mainPath, projectNote(project));
    }

    await write(
      `${folder}/Logs/${project.name} - Logs.md`,
      indexNote(project.name, "Logs", "Logs das conversas com o Claude sobre este projeto (também listados na [[Memória Claude]])."),
    );
    await write(
      `${folder}/Changelogs/${project.name} - Changelog.md`,
      indexNote(project.name, "Changelog", "Uma nota por release, gerada pelo `scripts/changelog_desenvolvimento.py`."),
    );
    await this.vault.ensureFolder(`${folder}/Branches`);
    await write(`${folder}/CLAUDE.md`, claudeMd(project));
    return { folder, notes };
  }
}
