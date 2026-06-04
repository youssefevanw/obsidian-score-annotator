export type Tool = "pen" | "highlighter" | "eraser";

export interface Point {
  // Normalized [0..1] relative to the displayed page rect.
  x: number;
  y: number;
}

export interface Stroke {
  tool: Tool;
  color: string;
  // PDF points (1pt = 1/72 inch). Also used directly as CSS-pixel thickness
  // when rendering the overlay.
  width: number;
  opacity: number;
  points: Point[];
}

export interface PageStrokes {
  pageIndex: number;
  strokes: Stroke[];
}
