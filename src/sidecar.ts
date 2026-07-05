import { App, TFile, normalizePath } from "obsidian";
import { PageStrokes, PlacedImage } from "./types";

const VERSION = 1;
const SUFFIX = ".scoreannotator.json";

interface SidecarFile {
  version: number;
  pages: PageStrokes[];
  // Optional: absent in sidecars written before the image feature, and in
  // any session with no uncommitted-to-PDF images. Base64 in JSON is fine
  // here — the sidecar is temporary and deleted on save.
  images?: PlacedImage[];
}

export interface SidecarContents {
  pages: PageStrokes[];
  images: PlacedImage[];
}

function sidecarPath(pdfFile: TFile): string {
  return normalizePath(pdfFile.path + SUFFIX);
}

export async function readSidecar(
  app: App,
  pdfFile: TFile,
): Promise<SidecarContents | null> {
  const path = sidecarPath(pdfFile);
  const af = app.vault.getAbstractFileByPath(path);
  if (!(af instanceof TFile)) return null;
  try {
    const text = await app.vault.read(af);
    const parsed = JSON.parse(text) as SidecarFile;
    if (parsed.version !== VERSION || !Array.isArray(parsed.pages)) return null;
    return { pages: parsed.pages, images: Array.isArray(parsed.images) ? parsed.images : [] };
  } catch {
    return null;
  }
}

export async function writeSidecar(
  app: App,
  pdfFile: TFile,
  pages: PageStrokes[],
  images: PlacedImage[],
): Promise<void> {
  const path = sidecarPath(pdfFile);
  const body = JSON.stringify({
    version: VERSION,
    pages,
    images,
  } satisfies SidecarFile);
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
