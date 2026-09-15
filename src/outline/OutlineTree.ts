import { setIcon } from "obsidian";

export interface OutlineNode {
	title: string;
	/** 1-based page number, null when the destination cannot be resolved */
	page: number | null;
	children: OutlineNode[];
}

interface OutlineRow {
	node: OutlineNode;
	rowEl: HTMLElement;
	childrenEl: HTMLElement | null;
	parent: OutlineRow | null;
}

/**
 * Collapsible outline tree shown in the sidebar. Tracks the current page
 * by highlighting the deepest entry whose page <= current page.
 */
export class OutlineTree {
	readonly el: HTMLElement;
	private rows: OutlineRow[] = [];
	private currentRow: OutlineRow | null = null;

	constructor(private onSelect: (page: number) => void) {
		this.el = createDiv({ cls: "pr-outline" });
	}

	build(nodes: OutlineNode[]): void {
		this.el.empty();
		this.rows = [];
		this.currentRow = null;
		for (const node of nodes) {
			this.buildNode(node, this.el, null);
		}
	}

	private buildNode(
		node: OutlineNode,
		parentEl: HTMLElement,
		parent: OutlineRow | null
	): void {
		const wrap = parentEl.createDiv({ cls: "pr-outline-node" });
		const row: OutlineRow = { node, rowEl: null as never, childrenEl: null, parent };

		const rowEl = wrap.createDiv({ cls: "pr-outline-row" });
		row.rowEl = rowEl;
		const chevron = rowEl.createSpan({ cls: "pr-outline-chevron" });
		const title = rowEl.createSpan({ cls: "pr-outline-title" });
		title.setText(node.title);
		const pageEl = rowEl.createSpan({ cls: "pr-outline-page" });
		if (node.page !== null) pageEl.setText(String(node.page));

		if (node.children.length > 0) {
			setIcon(chevron, "chevron-down");
			chevron.addEventListener("click", (e) => {
				e.stopPropagation();
				wrap.toggleClass("pr-outline-collapsed", !wrap.hasClass("pr-outline-collapsed"));
				setIcon(chevron, wrap.hasClass("pr-outline-collapsed") ? "chevron-right" : "chevron-down");
			});
		}
		rowEl.addEventListener("click", () => {
			if (node.page !== null) this.onSelect(node.page);
		});

		if (node.children.length > 0) {
			const childrenEl = wrap.createDiv({ cls: "pr-outline-children" });
			row.childrenEl = childrenEl;
			for (const child of node.children) {
				this.buildNode(child, childrenEl, row);
			}
		}
		this.rows.push(row);
	}

	/** Highlight the deepest outline entry covering `page` and expand its ancestors. */
	setCurrentPage(page: number): void {
		let best: OutlineRow | null = null;
		for (const row of this.rows) {
			if (row.node.page !== null && row.node.page <= page) best = row;
		}
		if (best === this.currentRow) return;
		this.currentRow?.rowEl.removeClass("pr-outline-current");
		this.currentRow = best;
		if (best) {
			best.rowEl.addClass("pr-outline-current");
			// expand ancestors so the current entry is visible
			let p = best.parent;
			while (p) {
				const wrap = p.rowEl.parentElement;
				if (wrap?.hasClass("pr-outline-collapsed")) {
					wrap.removeClass("pr-outline-collapsed");
					const chevron = p.rowEl.querySelector(".pr-outline-chevron");
					if (chevron) setIcon(chevron as HTMLElement, "chevron-down");
				}
				p = p.parent;
			}
		}
	}
}
