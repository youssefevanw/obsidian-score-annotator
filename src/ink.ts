import getStroke from "perfect-freehand";
import { Stroke } from "./types";

function hasPressureData(stroke: Stroke): boolean {
  return stroke.points.some((p) => p.p !== undefined && p.p > 0);
}

// Returns the outline polygon for a pen stroke in canvas pixel space.
// Callers use this for both live drawing and the final committed stroke.
function strokeOutline(stroke: Stroke, w: number, h: number): number[][] {
  const pts = stroke.points.map((p) => [p.x * w, p.y * h, p.p ?? 0.5]);
  return getStroke(pts, {
    size: stroke.width * 2,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !hasPressureData(stroke),
  });
}

// Returns the outline polygon for a pen stroke in arbitrary coordinate space
// (used by pdf-writer, which works in native PDF points).
export function strokeOutlineCoords(
  pts: { x: number; y: number; p?: number }[],
  width: number,
): number[][] {
  const mapped = pts.map((p) => [p.x, p.y, p.p ?? 0.5]);
  const hasPressure = pts.some((p) => p.p !== undefined && p.p > 0);
  return getStroke(mapped, {
    size: width * 2,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !hasPressure,
  });
}

// Infer whether a stroke should render as a pen (filled outline) or
// highlighter (stroked polyline). Explicit kind takes priority; for legacy
// strokes (no kind) the heuristic is: opacity < 1 → highlighter.
export function strokeKind(stroke: Stroke): "pen" | "highlighter" {
  if (stroke.kind !== undefined) return stroke.kind;
  return stroke.opacity < 1 ? "highlighter" : "pen";
}

// Render a pen stroke using a filled perfect-freehand outline.
export function paintPenStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  w: number,
  h: number,
): void {
  const outline = strokeOutline(stroke, w, h);
  if (outline.length < 3) return;
  ctx.save();
  ctx.globalAlpha = stroke.opacity;
  ctx.fillStyle = stroke.color || "#000";
  const path = new Path2D();
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    path.lineTo(outline[i][0], outline[i][1]);
  }
  path.closePath();
  ctx.fill(path);
  ctx.restore();
}

// Render a highlighter stroke as a uniform-width semi-transparent polyline.
// Markers should not thin with pressure — full-width is the highlighter look.
export function paintHighlighterStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  w: number,
  h: number,
): void {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = stroke.width;
  ctx.globalAlpha = stroke.opacity;
  ctx.strokeStyle = stroke.color || "#000";
  ctx.beginPath();
  const [first, ...rest] = stroke.points;
  ctx.moveTo(first.x * w, first.y * h);
  for (const p of rest) ctx.lineTo(p.x * w, p.y * h);
  ctx.stroke();
  ctx.restore();
}
