import { App, TFile, normalizePath } from "obsidian";
import { PageStrokes } from "./types";

const VERSION = 1;
const SUFFIX = ".scoreannotator.json";

interface SidecarFile {
  version: number;
  pages: PageStrokes[];
}

function sidecarPath(pdfFile: TFile): string {
  return normalizePath(pdfFile.path + SUFFIX);
}

export async function readSidecar(
  app: App,
  pdfFile: TFile,
): Promise<PageStrokes[] | null> {
  const path = sidecarPath(pdfFile);
  const af = app.vault.getAbstractFileByPath(path);
  if (!(af instanceof TFile)) return null;
  try {
    const text = await app.vault.read(af);
    const parsed = JSON.parse(text) as SidecarFile;
    if (parsed.version !== VERSION || !Array.isArray(parsed.pages)) return null;
    return parsed.pages;
  } catch {
    return null;
  }
}

export async function writeSidecar(
  app: App,
  pdfFile: TFile,
  pages: PageStrokes[],
): Promise<void> {
  const path = sidecarPath(pdfFile);
  const body = JSON.stringify({ version: VERSION, pages } satisfies SidecarFile);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, body);
  } else {
    await app.vault.create(path, body);
  }
}

export async function deleteSidecar(app: App, pdfFile: TFile): Promise<void> {
  const path = sidecarPath(pdfFile);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.delete(existing);
  }
}
