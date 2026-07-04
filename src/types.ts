export type Tool = "pen" | "highlighter" | "eraser";

export interface Point {
  // Normalized [0..1] relative to the displayed page rect.
  x: number;
  y: number;
  // Stylus pressure [0..1]. Absent on legacy strokes and mouse strokes.
  p?: number;
}

export interface Stroke {
  tool: Tool;
  color: string;
  // PDF points (1pt = 1/72 inch). Also used directly as CSS-pixel thickness
  // when rendering the overlay.
  width: number;
  opacity: number;
  points: Point[];
  // Explicit rendering kind. Absent on legacy strokes (infer from opacity).
  kind?: "pen" | "highlighter";
}

export interface PageStrokes {
  pageIndex: number;
  strokes: Stroke[];
}
