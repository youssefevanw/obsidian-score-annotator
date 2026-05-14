import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
} from "pdf-lib";
import { isOwnInkAnnotation } from "./pdf-writer";
import { PageStrokes, Point, Stroke } from "./types";

const DEFAULT_COLOR = "#000000";
const DEFAULT_WIDTH = 2;
const DEFAULT_OPACITY = 1;

export async function readStrokesFromPdf(
  bytes: ArrayBuffer,
): Promise<PageStrokes[]> {
  const pdfDoc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  const pdfPages = pdfDoc.getPages();
  const ctx = pdfDoc.context;
  const out: PageStrokes[] = [];

  for (let pageIndex = 0; pageIndex < pdfPages.length; pageIndex++) {
    const page = pdfPages[pageIndex];
    const annots = page.node.Annots();
    if (!annots) continue;

    const { width: mediaWidth, height: mediaHeight } = page.getSize();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;

    const strokes: Stroke[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const dict = ctx.lookupMaybe(annots.get(i), PDFDict);
      if (!dict) continue;
      if (!isOwnInkAnnotation(dict)) continue;

      const inkList = ctx.lookupMaybe(dict.get(PDFName.of("InkList")), PDFArray);
      if (!inkList) continue;

      const color = readColor(ctx, dict);
      const opacity = readNumber(ctx, dict, "CA", DEFAULT_OPACITY);
      const width = readBorderWidth(ctx, dict);

      for (let pi = 0; pi < inkList.size(); pi++) {
        const path = ctx.lookupMaybe(inkList.get(pi), PDFArray);
        if (!path) continue;
        const points = pathToNormalizedPoints(
          ctx,
          path,
          mediaWidth,
          mediaHeight,
          rotation,
        );
        if (points.length < 2) continue;
        strokes.push({ tool: "pen", color, width, opacity, points });
      }
    }

    if (strokes.length > 0) out.push({ pageIndex, strokes });
  }

  return out;
}

function pathToNormalizedPoints(
  ctx: PDFContext,
  path: PDFArray,
  mediaWidth: number,
  mediaHeight: number,
  rotation: number,
): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 1 < path.size(); i += 2) {
    const xn = ctx.lookupMaybe(path.get(i), PDFNumber);
    const yn = ctx.lookupMaybe(path.get(i + 1), PDFNumber);
    if (!xn || !yn) continue;
    points.push(
      nativeToNormalized(
        xn.value(),
        yn.value(),
        mediaWidth,
        mediaHeight,
        rotation,
      ),
    );
  }
  return points;
}

export function nativeToNormalized(
  x: number,
  y: number,
  mediaWidth: number,
  mediaHeight: number,
  rotation: number,
): Point {
  switch (rotation) {
    case 90:
      return { x: y / mediaHeight, y: x / mediaWidth };
    case 180:
      return {
        x: (mediaWidth - x) / mediaWidth,
        y: y / mediaHeight,
      };
    case 270:
      return {
        x: (mediaHeight - y) / mediaHeight,
        y: x / mediaWidth,
      };
    default:
      return { x: x / mediaWidth, y: 1 - y / mediaHeight };
  }
}

function readNumber(
  ctx: PDFContext,
  dict: PDFDict,
  key: string,
  fallback: number,
): number {
  const v = ctx.lookupMaybe(dict.get(PDFName.of(key)), PDFNumber);
  return v ? v.value() : fallback;
}

function readColor(ctx: PDFContext, dict: PDFDict): string {
  const arr = ctx.lookupMaybe(dict.get(PDFName.of("C")), PDFArray);
  if (!arr) return DEFAULT_COLOR;
  if (arr.size() >= 3) {
    const r = ctx.lookupMaybe(arr.get(0), PDFNumber)?.value() ?? 0;
    const g = ctx.lookupMaybe(arr.get(1), PDFNumber)?.value() ?? 0;
    const b = ctx.lookupMaybe(arr.get(2), PDFNumber)?.value() ?? 0;
    return rgbToHex(r, g, b);
  }
  if (arr.size() === 1) {
    const k = ctx.lookupMaybe(arr.get(0), PDFNumber)?.value() ?? 0;
    return rgbToHex(k, k, k);
  }
  return DEFAULT_COLOR;
}

function readBorderWidth(ctx: PDFContext, dict: PDFDict): number {
  const bs = ctx.lookupMaybe(dict.get(PDFName.of("BS")), PDFDict);
  if (bs) {
    const w = ctx.lookupMaybe(bs.get(PDFName.of("W")), PDFNumber);
    if (w) return w.value();
  }
  const border = ctx.lookupMaybe(dict.get(PDFName.of("Border")), PDFArray);
  if (border && border.size() >= 3) {
    const w = ctx.lookupMaybe(border.get(2), PDFNumber);
    if (w) return w.value();
  }
  return DEFAULT_WIDTH;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
