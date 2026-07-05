import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  PDFHexString,
} from "pdf-lib";
import { isOwnInkAnnotation, isOwnStampAnnotation } from "./pdf-writer";
import { PageStrokes, PlacedImage, Point, Stroke } from "./types";

const DEFAULT_COLOR = "#000000";
const DEFAULT_WIDTH = 2;
const DEFAULT_OPACITY = 1;

export interface ReadAnnotationsResult {
  pages: PageStrokes[];
  images: PlacedImage[];
}

export async function readStrokesFromPdf(
  bytes: ArrayBuffer,
): Promise<ReadAnnotationsResult> {
  const pdfDoc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  const pdfPages = pdfDoc.getPages();
  const ctx = pdfDoc.context;
  const pages: PageStrokes[] = [];
  const images: PlacedImage[] = [];

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

      if (isOwnStampAnnotation(dict)) {
        const image = readPlacedImage(ctx, dict, pageIndex);
        if (image) images.push(image);
        continue;
      }

      if (!isOwnInkAnnotation(dict)) continue;

      const inkList = ctx.lookupMaybe(dict.get(PDFName.of("InkList")), PDFArray);
      if (!inkList) continue;

      const color = readColor(ctx, dict);
      const opacity = readNumber(ctx, dict, "CA", DEFAULT_OPACITY);
      const width = readBorderWidth(ctx, dict);
      const kind = readKind(ctx, dict);
      const pressures = readPressures(ctx, dict);

      for (let pi = 0; pi < inkList.size(); pi++) {
        const path = ctx.lookupMaybe(inkList.get(pi), PDFArray);
        if (!path) continue;
        const points = pathToNormalizedPoints(
          ctx,
          path,
          mediaWidth,
          mediaHeight,
          rotation,
          pressures,
        );
        if (points.length < 2) continue;
        const stroke: Stroke = { tool: "pen", color, width, opacity, points };
        if (kind) stroke.kind = kind;
        strokes.push(stroke);
      }
    }

    if (strokes.length > 0) pages.push({ pageIndex, strokes });
  }

  return { pages, images };
}

// Reads a plugin-authored Stamp annotation back into a PlacedImage. The
// transform (cx/cy/w/h/rotation) and image bytes are read from plugin keys
// rather than re-derived from the /AP appearance stream — see the write-side
// comment in pdf-writer.ts (SAData) for why the bytes are duplicated there
// instead of extracted from the embedded XObject.
function readPlacedImage(
  ctx: PDFContext,
  dict: PDFDict,
  pageIndex: number,
): PlacedImage | null {
  const id = readString(ctx, dict, "SAId");
  const mimeRaw = readString(ctx, dict, "SAMime");
  const data = readString(ctx, dict, "SAData");
  if (!id || !data) return null;
  const mime = mimeRaw === "image/jpeg" ? "image/jpeg" : "image/png";
  return {
    id,
    pageIndex,
    cx: readNumber(ctx, dict, "SACx", 0.5),
    cy: readNumber(ctx, dict, "SACy", 0.5),
    w: readNumber(ctx, dict, "SAW", 0.5),
    h: readNumber(ctx, dict, "SAH", 0.5),
    rotation: readNumber(ctx, dict, "SARot", 0),
    mime,
    data,
  };
}

function readString(
  ctx: PDFContext,
  dict: PDFDict,
  key: string,
): string | null {
  const raw = dict.get(PDFName.of(key));
  const str = ctx.lookupMaybe(raw, PDFString) ?? ctx.lookupMaybe(raw, PDFHexString);
  return str ? str.decodeText() : null;
}

function pathToNormalizedPoints(
  ctx: PDFContext,
  path: PDFArray,
  mediaWidth: number,
  mediaHeight: number,
  rotation: number,
  pressures: number[] | null,
): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 1 < path.size(); i += 2) {
    const xn = ctx.lookupMaybe(path.get(i), PDFNumber);
    const yn = ctx.lookupMaybe(path.get(i + 1), PDFNumber);
    if (!xn || !yn) continue;
    const pt = nativeToNormalized(
      xn.value(),
      yn.value(),
      mediaWidth,
      mediaHeight,
      rotation,
    );
    const pointIndex = points.length;
    if (pressures && pointIndex < pressures.length) {
      pt.p = pressures[pointIndex];
    }
    points.push(pt);
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

function readKind(
  ctx: PDFContext,
  dict: PDFDict,
): "pen" | "highlighter" | undefined {
  const raw = dict.get(PDFName.of("SAKind"));
  const str = ctx.lookupMaybe(raw, PDFString) ?? ctx.lookupMaybe(raw, PDFHexString);
  if (!str) return undefined;
  const text = str.decodeText();
  if (text === "pen" || text === "highlighter") return text;
  return undefined;
}

function readPressures(ctx: PDFContext, dict: PDFDict): number[] | null {
  const raw = ctx.lookupMaybe(dict.get(PDFName.of("SAPress")), PDFArray);
  if (!raw) return null;
  const pressures: number[] = [];
  for (let i = 0; i < raw.size(); i++) {
    const n = ctx.lookupMaybe(raw.get(i), PDFNumber);
    pressures.push(n ? Math.max(0, Math.min(1, n.value())) : 0.5);
  }
  return pressures.length > 0 ? pressures : null;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
