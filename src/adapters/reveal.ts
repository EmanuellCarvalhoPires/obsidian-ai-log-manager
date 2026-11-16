// Desktop-only helpers that touch the operating system: show a file in its folder.
import * as path from "node:path";

interface ElectronShell {
  showItemInFolder(fullPath: string): void;
}

/** Opens the folder of a file with the file selected (File Explorer, Finder...). Returns false when it cannot. */
export function revealInFolder(absolutePath: string): boolean {
  try {
    const req = (window as unknown as { require?: (id: string) => { shell?: ElectronShell } }).require;
    const shell = req?.("electron").shell;
    if (!shell) return false;
    shell.showItemInFolder(path.normalize(absolutePath));
    return true;
  } catch {
    return false;
  }
}
