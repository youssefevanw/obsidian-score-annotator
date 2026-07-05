import { PlacedImage } from "./types";

// Screen/canvas-pixel-space math throughout this file — center, half-extents,
// and rotation are all handled in the same CSS-px space the overlay canvas
// already draws in, using canvas's own rotate() convention (x right, y down,
// positive angle = clockwise). Only `toPlacedImage()` converts to the
// normalized [0..1] page-fraction coordinates PlacedImage stores.

const HANDLE_HIT_RADIUS_PX = 12;
const HANDLE_VISUAL_SIZE_PX = 8;
const ROTATE_HANDLE_OFFSET_PX = 28;
const MIN_SIZE_PX = 16;

type Vec = { x: number; y: number };

// Local (unrotated) corner signs: x right/left, y down/up.
const CORNER_SIGNS: readonly [1 | -1, 1 | -1][] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

type DragState =
  | { kind: "move"; startPointer: Vec; startCenter: Vec }
  | {
      kind: "resize";
      sign: [1 | -1, 1 | -1];
      anchorWorld: Vec;
      grabbedWorld0: Vec;
      startWpx: number;
      startHpx: number;
      rotation: number;
    }
  | { kind: "rotate" };

export class ImagePlacement {
  rotation = 0;

  constructor(
    public readonly pageIndex: number,
    private readonly img: HTMLImageElement,
    private readonly mime: "image/png" | "image/jpeg",
    private readonly data: string,
    public cx: number,
    public cy: number,
    public w: number,
    public h: number,
  ) {}

  // Natural size capped at 60% of the page's on-screen width, centered.
  static create(
    pageIndex: number,
    img: HTMLImageElement,
    mime: "image/png" | "image/jpeg",
    data: string,
    pageW: number,
    pageH: number,
  ): ImagePlacement {
    const maxWpx = pageW * 0.6;
    const naturalW = img.naturalWidth || maxWpx;
    const naturalH = img.naturalHeight || maxWpx;
    const wPx = Math.min(naturalW, maxWpx);
    const hPx = wPx * (naturalH / naturalW);
    return new ImagePlacement(
      pageIndex,
      img,
      mime,
      data,
      0.5,
      0.5,
      wPx / pageW,
      hPx / pageH,
    );
  }

  private drag: DragState | null = null;

  // Exposes the already-decoded element so the caller can seed its image
  // cache after commit without re-decoding the same base64.
  get element(): HTMLImageElement {
    return this.img;
  }

  draw(ctx: CanvasRenderingContext2D, pageW: number, pageH: number): void {
    const Cx = this.cx * pageW;
    const Cy = this.cy * pageH;
    const Wpx = this.w * pageW;
    const Hpx = this.h * pageH;
    const hw = Wpx / 2;
    const hh = Hpx / 2;

    ctx.save();
    ctx.translate(Cx, Cy);
    ctx.rotate(this.rotation);
    ctx.drawImage(this.img, -hw, -hh, Wpx, Hpx);

    // Gizmo chrome, drawn in the same rotated frame so it tracks the box.
    ctx.strokeStyle = "#4f8dfd";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-hw, -hh, Wpx, Hpx);

    ctx.beginPath();
    ctx.moveTo(0, -hh);
    ctx.lineTo(0, -hh - ROTATE_HANDLE_OFFSET_PX);
    ctx.stroke();

    for (const [sx, sy] of CORNER_SIGNS) {
      drawHandle(ctx, sx * hw, sy * hh);
    }
    drawHandle(ctx, 0, -hh - ROTATE_HANDLE_OFFSET_PX);

    ctx.restore();
  }

  // Returns true if the pointer hit the gizmo and a drag started; false if
  // the pointer was outside everything (caller should commit/cancel).
  pointerDown(px: number, py: number, pageW: number, pageH: number): boolean {
    const center = { x: this.cx * pageW, y: this.cy * pageH };
    const hw = (this.w * pageW) / 2;
    const hh = (this.h * pageH) / 2;
    const local = toLocal({ x: px, y: py }, center, this.rotation);

    const rotateHandle = { x: 0, y: -hh - ROTATE_HANDLE_OFFSET_PX };
    if (dist(local, rotateHandle) <= HANDLE_HIT_RADIUS_PX) {
      this.drag = { kind: "rotate" };
      return true;
    }

    for (const [sx, sy] of CORNER_SIGNS) {
      const corner = { x: sx * hw, y: sy * hh };
      if (dist(local, corner) > HANDLE_HIT_RADIUS_PX) continue;
      const anchorSign: [1 | -1, 1 | -1] = [-sx as 1 | -1, -sy as 1 | -1];
      const anchorLocal = { x: anchorSign[0] * hw, y: anchorSign[1] * hh };
      this.drag = {
        kind: "resize",
        sign: [sx, sy],
        anchorWorld: fromLocal(anchorLocal, center, this.rotation),
        grabbedWorld0: fromLocal(corner, center, this.rotation),
        startWpx: this.w * pageW,
        startHpx: this.h * pageH,
        rotation: this.rotation,
      };
      return true;
    }

    if (Math.abs(local.x) <= hw && Math.abs(local.y) <= hh) {
      this.drag = { kind: "move", startPointer: { x: px, y: py }, startCenter: center };
      return true;
    }

    return false;
  }

  pointerMove(px: number, py: number, pageW: number, pageH: number, shiftKey: boolean): void {
    if (!this.drag) return;
    const p = { x: px, y: py };

    if (this.drag.kind === "move") {
      const dx = px - this.drag.startPointer.x;
      const dy = py - this.drag.startPointer.y;
      this.cx = (this.drag.startCenter.x + dx) / pageW;
      this.cy = (this.drag.startCenter.y + dy) / pageH;
      return;
    }

    if (this.drag.kind === "rotate") {
      const center = { x: this.cx * pageW, y: this.cy * pageH };
      this.rotation = Math.atan2(p.y - center.y, p.x - center.x) + Math.PI / 2;
      return;
    }

    // resize
    const { sign, anchorWorld, grabbedWorld0, startWpx, startHpx, rotation } = this.drag;
    const dWorld = { x: p.x - anchorWorld.x, y: p.y - anchorWorld.y };
    const dLocal = rotateVec(dWorld, -rotation);

    let wPx: number;
    let hPx: number;
    if (shiftKey) {
      // Free aspect ratio: each axis follows the pointer independently.
      wPx = Math.max(MIN_SIZE_PX, Math.abs(dLocal.x));
      hPx = Math.max(MIN_SIZE_PX, Math.abs(dLocal.y));
    } else {
      // Aspect-locked (default): uniform scale from the anchor-to-pointer
      // distance vs. the anchor-to-grabbed-corner distance at drag start.
      const dist0 = dist(anchorWorld, grabbedWorld0) || 1;
      const distNow = dist(anchorWorld, p);
      const scale = distNow / dist0;
      wPx = Math.max(MIN_SIZE_PX, startWpx * scale);
      hPx = Math.max(MIN_SIZE_PX, startHpx * scale);
    }

    const hw = wPx / 2;
    const hh = hPx / 2;
    const newCenterLocal = { x: sign[0] * hw, y: sign[1] * hh };
    const newCenter = fromLocal(newCenterLocal, anchorWorld, rotation);

    this.cx = newCenter.x / pageW;
    this.cy = newCenter.y / pageH;
    this.w = wPx / pageW;
    this.h = hPx / pageH;
  }

  pointerUp(): void {
    this.drag = null;
  }

  toPlacedImage(): PlacedImage {
    return {
      id: generateId(),
      pageIndex: this.pageIndex,
      cx: this.cx,
      cy: this.cy,
      w: this.w,
      h: this.h,
      rotation: this.rotation,
      mime: this.mime,
      data: this.data,
    };
  }
}

function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const s = HANDLE_VISUAL_SIZE_PX / 2;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#4f8dfd";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function toLocal(p: Vec, center: Vec, rotation: number): Vec {
  return rotateVec({ x: p.x - center.x, y: p.y - center.y }, -rotation);
}

function fromLocal(local: Vec, center: Vec, rotation: number): Vec {
  const r = rotateVec(local, rotation);
  return { x: center.x + r.x, y: center.y + r.y };
}

function rotateVec(v: Vec, angle: number): Vec {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: cos * v.x - sin * v.y, y: sin * v.x + cos * v.y };
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function generateId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
