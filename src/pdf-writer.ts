import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { PageStrokes, Stroke } from "./types";

// Marker used to identify InkAnnotations created by this plugin so we can
// strip + rewrite them idempotently on each save. /T also shows up as the
// annotation author in viewers.
export const ANNOT_TAG = "ScoreAnnotator";
export const ANNOT_MARKER_KEY = "SAv";
const ANNOT_VERSION = 1;

export async function writeStrokesIntoPdf(
  bytes: ArrayBuffer,
  pages: PageStrokes[],
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(bytes);
  const pdfPages = pdfDoc.getPages();

  const pagesByIndex = new Map<number, Stroke[]>();
  for (const p of pages) pagesByIndex.set(p.pageIndex, p.strokes);

  for (let i = 0; i < pdfPages.length; i++) {
    const pdfPage = pdfPages[i];
    stripOwnInkAnnotations(pdfPage);
    const strokes = pagesByIndex.get(i);
    if (!strokes || strokes.length === 0) continue;
    addInkAnnotations(pdfDoc, pdfPage, strokes);
  }

  return pdfDoc.save();
}

function stripOwnInkAnnotations(page: PDFPage): void {
  const annots = page.node.Annots();
  if (!annots) return;
  const ctx = page.doc.context;
  const removeIndices: number[] = [];
  const refsToFree: PDFRef[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const entry = annots.get(i);
    const dict = ctx.lookupMaybe(entry, PDFDict);
    if (!dict) continue;
    if (!isOwnInkAnnotation(dict)) continue;
    removeIndices.push(i);
    if (entry instanceof PDFRef) refsToFree.push(entry);
  }
  for (let j = removeIndices.length - 1; j >= 0; j--) {
    annots.remove(removeIndices[j]);
  }
  for (const ref of refsToFree) ctx.delete(ref);
}

export function isOwnInkAnnotation(dict: PDFDict): boolean {
  const subtype = dict.get(PDFName.of("Subtype"));
  if (!(subtype instanceof PDFName)) return false;
  if (subtype.decodeText() !== "Ink") return false;
  if (dict.has(PDFName.of(ANNOT_MARKER_KEY))) return true;
  const t = dict.get(PDFName.of("T"));
  if (t instanceof PDFString || t instanceof PDFHexString) {
    return t.decodeText() === ANNOT_TAG;
  }
  return false;
}

function addInkAnnotations(
  pdfDoc: PDFDocument,
  page: PDFPage,
  strokes: Stroke[],
): void {
  const { width, height } = page.getSize();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;

  let annots = page.node.Annots();
  if (!annots) {
    annots = pdfDoc.context.obj([]) as PDFArray;
    page.node.set(PDFName.of("Annots"), annots);
  }

  for (const stroke of strokes) {
    if (stroke.tool !== "pen" || stroke.points.length < 2) continue;
    const color = hexToRgb(stroke.color);
    const native = stroke.points.map((p) =>
      normalizedToNative(p.x, p.y, width, height, rotation),
    );

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const flatPath: number[] = [];
    for (const pt of native) {
      flatPath.push(pt.x, pt.y);
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    const pad = Math.max(stroke.width, 1);
    const rect: [number, number, number, number] = [
      minX - pad,
      minY - pad,
      maxX + pad,
      maxY + pad,
    ];

    const apRef = buildInkAppearance(
      pdfDoc,
      native,
      rect,
      color,
      stroke.width,
      stroke.opacity,
    );

    const annotDict = pdfDoc.context.obj({
      Type: "Annot",
      Subtype: "Ink",
      Rect: rect,
      InkList: [flatPath],
      C: [color.r, color.g, color.b],
      CA: stroke.opacity,
      BS: { Type: "Border", W: stroke.width, S: "S" },
      F: 4,
      AP: { N: apRef },
      T: PDFString.of(ANNOT_TAG),
      [ANNOT_MARKER_KEY]: ANNOT_VERSION,
    });
    annots.push(pdfDoc.context.register(annotDict));
  }
}

// Acrobat does not synthesize a default appearance for third-party Ink
// annotations — without an /AP /N Form XObject, the stroke renders blank.
// Preview is similarly inconsistent. Bake the path into an appearance stream
// in page user space so every viewer renders identically.
function buildInkAppearance(
  pdfDoc: PDFDocument,
  points: { x: number; y: number }[],
  bbox: [number, number, number, number],
  color: { r: number; g: number; b: number },
  width: number,
  opacity: number,
): PDFRef {
  const useExtState = opacity < 1;
  const ops: string[] = ["q"];
  if (useExtState) ops.push("/G0 gs");
  ops.push(`${fmtNum(color.r)} ${fmtNum(color.g)} ${fmtNum(color.b)} RG`);
  ops.push(`${fmtNum(width)} w`);
  ops.push("1 J"); // round caps
  ops.push("1 j"); // round joins
  ops.push(`${fmtNum(points[0].x)} ${fmtNum(points[0].y)} m`);
  for (let i = 1; i < points.length; i++) {
    ops.push(`${fmtNum(points[i].x)} ${fmtNum(points[i].y)} l`);
  }
  ops.push("S");
  ops.push("Q");

  const contentBytes = new TextEncoder().encode(ops.join("\n"));

  const resources = useExtState
    ? {
        ProcSet: ["PDF"],
        ExtGState: {
          G0: { Type: "ExtGState", CA: opacity, ca: opacity },
        },
      }
    : { ProcSet: ["PDF"] };

  const stream = pdfDoc.context.stream(contentBytes, {
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: bbox,
    Resources: resources,
  });
  return pdfDoc.context.register(stream);
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/\.?0+$/, "");
}

export function normalizedToNative(
  nx: number,
  ny: number,
  mediaWidth: number,
  mediaHeight: number,
  rotation: number,
): { x: number; y: number } {
  const rotated = rotation === 90 || rotation === 270;
  const visualW = rotated ? mediaHeight : mediaWidth;
  const visualH = rotated ? mediaWidth : mediaHeight;
  const u = nx * visualW;
  const v = (1 - ny) * visualH;
  switch (rotation) {
    case 90:
      return { x: mediaWidth - v, y: u };
    case 180:
      return { x: mediaWidth - u, y: mediaHeight - v };
    case 270:
      return { x: v, y: mediaHeight - u };
    default:
      return { x: u, y: v };
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const v = parseInt(m[1], 16);
  return {
    r: ((v >> 16) & 0xff) / 255,
    g: ((v >> 8) & 0xff) / 255,
    b: (v & 0xff) / 255,
  };
}
