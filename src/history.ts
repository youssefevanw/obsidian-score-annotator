import { PlacedImage, Stroke } from "./types";

export type HistoryAction =
  | { type: "add"; pageIndex: number; stroke: Stroke }
  | {
      type: "erase";
      pageIndex: number;
      removed: Stroke[];
      added: Stroke[];
      anyBaked: boolean;
    }
  | { type: "addImage"; image: PlacedImage };

const MAX_HISTORY = 100;

export class History {
  private undoStack: HistoryAction[] = [];
  private redoStack: HistoryAction[] = [];

  push(action: HistoryAction): void {
    this.undoStack.push(action);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): HistoryAction | undefined {
    const action = this.undoStack.pop();
    if (action) this.redoStack.push(action);
    return action;
  }

  redo(): HistoryAction | undefined {
    const action = this.redoStack.pop();
    if (action) this.undoStack.push(action);
    return action;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
