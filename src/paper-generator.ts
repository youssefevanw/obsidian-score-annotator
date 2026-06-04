import { PDFDocument, PDFPage, rgb } from "pdf-lib";

export type PaperTemplate = "blank" | "staff" | "dot-grid" | "graph";

export interface PaperOptions {
  template: PaperTemplate;
  stavesPerPage?: number;
  pageCount?: number;
}

export const DEFAULT_STAVES_PER_PAGE = 12;
export const PAPER_TEMPLATES: PaperTemplate[] = [
  "blank",
  "staff",
  "dot-grid",
  "graph",
];

// US Letter, in PDF points.
const PAGE_W_PT = 612;
const PAGE_H_PT = 792;

const STAFF_LEFT_MARGIN_PT = 54.25;
const STAFF_TOP_MARGIN_PT = 65.05;
const STAFF_LINE_SPACING_PT = 7.07;
const STAFF_SPAN_PT = 28.3;
const STAFF_GAP_PT = 29.3;
const STAFF_LINE_WIDTH_PT = 0.5;
const STAFF_LINES_PER_STAFF = 5;

const GRID_SPACING_PT = 20;
const GRID_DOT_RADIUS_PT = 0.7;
const GRID_LINE_WIDTH_PT = 0.5;
const GRID_MARGIN_PT = 54.25;

export interface PaperSubjectInfo {
  template: PaperTemplate;
  stavesPerPage?: number;
}

// PDF Subject is encoded as `template[|stavesPerPage]` so that "Add Page"
// can rebuild the same layout (including a custom staff count) without
// storing anything outside the PDF itself.
export function parsePaperSubject(
  subject: string | undefined,
): PaperSubjectInfo | null {
  if (!subject) return null;
  const [tpl, extra] = subject.split("|", 2);
  if (!(PAPER_TEMPLATES as string[]).includes(tpl)) return null;
  const info: PaperSubjectInfo = { template: tpl as PaperTemplate };
  if (tpl === "staff" && extra) {
    const n = parseInt(extra, 10);
    if (Number.isFinite(n) && n > 0) info.stavesPerPage = n;
  }
  return info;
}

function encodeSubject(opts: PaperOptions): string {
  if (opts.template === "staff" && opts.stavesPerPage) {
    return `staff|${opts.stavesPerPage}`;
  }
  return opts.template;
}

export async function generatePaperPdf(
  opts: PaperOptions,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  // Subject doubles as the "this is one of our generated canvases" flag —
  // overlay reads it to decide whether to expose the Add Page button.
  pdfDoc.setSubject(encodeSubject(opts));
  const pageCount = Math.max(1, opts.pageCount ?? 1);
  for (let i = 0; i < pageCount; i++) {
    addTemplatePage(pdfDoc, opts);
  }
  return pdfDoc.save();
}

export function addTemplatePage(
  pdfDoc: PDFDocument,
  opts: PaperOptions,
): PDFPage {
  const page = pdfDoc.addPage([PAGE_W_PT, PAGE_H_PT]);
  drawTemplate(page, opts);
  return page;
}

function drawTemplate(page: PDFPage, opts: PaperOptions): void {
  switch (opts.template) {
    case "blank":
      return;
    case "staff":
      drawStaff(page, opts.stavesPerPage ?? DEFAULT_STAVES_PER_PAGE);
      return;
    case "dot-grid":
      drawDotGrid(page);
      return;
    case "graph":
      drawGraph(page);
      return;
  }
}

function drawStaff(page: PDFPage, stavesPerPage: number): void {
  const x0 = STAFF_LEFT_MARGIN_PT;
  const x1 = PAGE_W_PT - STAFF_LEFT_MARGIN_PT;
  const color = rgb(0, 0, 0);
  for (let i = 0; i < stavesPerPage; i++) {
    const staffTopY = STAFF_TOP_MARGIN_PT + i * (STAFF_SPAN_PT + STAFF_GAP_PT);
    for (let j = 0; j < STAFF_LINES_PER_STAFF; j++) {
      const yDown = staffTopY + j * STAFF_LINE_SPACING_PT;
      const yPdf = PAGE_H_PT - yDown;
      page.drawLine({
        start: { x: x0, y: yPdf },
        end: { x: x1, y: yPdf },
        thickness: STAFF_LINE_WIDTH_PT,
        color,
      });
    }
  }
}

function drawDotGrid(page: PDFPage): void {
  const color = rgb(0.8, 0.8, 0.8);
  const x1 = PAGE_W_PT - GRID_MARGIN_PT;
  const y1 = PAGE_H_PT - GRID_MARGIN_PT;
  for (let x = GRID_MARGIN_PT; x <= x1 + 1e-6; x += GRID_SPACING_PT) {
    for (let y = GRID_MARGIN_PT; y <= y1 + 1e-6; y += GRID_SPACING_PT) {
      page.drawCircle({
        x,
        y: PAGE_H_PT - y,
        size: GRID_DOT_RADIUS_PT,
        color,
      });
    }
  }
}

function drawGraph(page: PDFPage): void {
  const color = rgb(0.87, 0.87, 0.87);
  const x0 = GRID_MARGIN_PT;
  const x1 = PAGE_W_PT - GRID_MARGIN_PT;
  const y0 = GRID_MARGIN_PT;
  const y1 = PAGE_H_PT - GRID_MARGIN_PT;
  for (let x = x0; x <= x1 + 1e-6; x += GRID_SPACING_PT) {
    page.drawLine({
      start: { x, y: PAGE_H_PT - y0 },
      end: { x, y: PAGE_H_PT - y1 },
      thickness: GRID_LINE_WIDTH_PT,
      color,
    });
  }
  for (let y = y0; y <= y1 + 1e-6; y += GRID_SPACING_PT) {
    const yPdf = PAGE_H_PT - y;
    page.drawLine({
      start: { x: x0, y: yPdf },
      end: { x: x1, y: yPdf },
      thickness: GRID_LINE_WIDTH_PT,
      color,
    });
  }
}
