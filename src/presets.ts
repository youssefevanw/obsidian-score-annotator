// Width/radius presets, shared between the toolbar's width-dot row and the
// Q/W/E/R/T keyboard shortcuts (overlay.ts) so the two can't drift apart —
// preset index i always maps to the same key label (see toolbar.ts).
export const PEN_WIDTHS = [0.5, 1, 2, 3.5, 6] as const;
export const HIGHLIGHTER_WIDTHS = [6, 12, 20] as const;
export const ERASER_RADII = [8, 16, 32] as const;
