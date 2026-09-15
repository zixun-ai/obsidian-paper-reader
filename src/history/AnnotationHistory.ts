import type { Annotation, InkStroke } from "../storage/annotationStore";

export type HistoryOp =
	| { kind: "add"; ann: Annotation }
	| { kind: "remove"; anns: Annotation[]; indexes: number[] }
	| { kind: "update"; before: Annotation; after: Annotation };

export type HistoryDirection = "undo" | "redo";

/**
 * Session-scoped undo/redo for annotation mutations of ONE document.
 * The apply callback mutates + persists; when persistence fails the stacks
 * stay untouched so history never drifts from data state.
 */
export class AnnotationHistory {
	private undoStack: HistoryOp[] = [];
	private redoStack: HistoryOp[] = [];

	constructor(
		private apply: (op: HistoryOp, dir: HistoryDirection) => Promise<boolean>,
		private onChange: () => void
	) {}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	push(op: HistoryOp): void {
		this.undoStack.push(op);
		this.redoStack = []; // new action clears the redo branch
		this.onChange();
	}

	async undo(): Promise<boolean> {
		const op = this.undoStack.pop();
		if (!op) return false;
		const ok = await this.apply(op, "undo");
		if (ok) this.redoStack.push(op);
		else this.undoStack.push(op); // keep pointers consistent with data
		this.onChange();
		return ok;
	}

	async redo(): Promise<boolean> {
		const op = this.redoStack.pop();
		if (!op) return false;
		const ok = await this.apply(op, "redo");
		if (ok) this.undoStack.push(op);
		else this.redoStack.push(op);
		this.onChange();
		return ok;
	}

	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
		this.onChange();
	}
}

/** deep clone helper for update ops */
export function cloneAnnotation(ann: Annotation): Annotation {
	return structuredClone(ann);
}

/** clone helper for ink point arrays */
export function cloneInk(ink: InkStroke): InkStroke {
	return { width: ink.width, points: [...ink.points] };
}
