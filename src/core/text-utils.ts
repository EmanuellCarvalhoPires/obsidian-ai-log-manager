// Small string helpers shared by the core modules (no Obsidian or Node imports).

/** Last segment of a Windows or POSIX path. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? "";
}

/** Removes characters that Windows does not accept in file names. */
export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/*?:"<>|]/g, "").trim();
}

/** Same comparison used for paths of different spellings (case, slashes, trailing slash). */
export function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when child is the folder itself or inside it. */
export function isInside(parent: string, child: string): boolean {
  const p = normalizePathKey(parent);
  const c = normalizePathKey(child);
  return c === p || c.startsWith(`${p}/`);
}

/** First characters of a text cut at a word boundary, at most maxLength long. */
export function shortenAtWord(text: string, maxLength: number): string {
  let out = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (out.length + word.length + 1 > maxLength) break;
    out = `${out} ${word}`.trim();
  }
  return out;
}

export function decodeUri(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Removes a byte order mark (Windows PowerShell adds one). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
