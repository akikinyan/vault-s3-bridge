// Design 7-2・7-3: a PDF drawn page by page on canvases and nothing else (I17). No text or annotation layer, so
// links, scripts and attachments inside the PDF do nothing (O2); no save, print or download action (I16).
import { t } from '../i18n';
import { renderInfo } from './content';
import type { Display } from './display';
import type { PreviewInfo, PreviewPdf } from './service';

/** Design 7-3: one page is drawn with at most this many pixels; larger pages are scaled down. */
export const PAGE_PIXELS = 16_000_000;
/** Design 7-3: pixels of drawn pages kept by all PDF previews together. */
export const TOTAL_PIXELS = 48_000_000;
/** Used when the page has no width yet (not laid out). */
const FALLBACK_WIDTH = 800;

/** The part of pdf.js (from Obsidian's `loadPdfJs()`) that is used. */
export interface PdfJs {
	getDocument(source: { data: Uint8Array; isEvalSupported: false; enableXfa: false; disableFontFace: false; ownerDocument: Document }): PdfLoadingTask;
	AnnotationMode?: { DISABLE: number };
}

export interface PdfLoadingTask {
	promise: Promise<PdfDocument>;
	onPassword?: (update: unknown, reason: number) => void;
	destroy(): Promise<void>;
}

export interface PdfDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPage>;
}

export interface PdfViewport {
	width: number;
	height: number;
}

export interface PdfPage {
	getViewport(options: { scale: number }): PdfViewport;
	render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; annotationMode: number }): PdfRenderTask;
}

export interface PdfRenderTask {
	promise: Promise<void>;
	cancel(): void;
}

/** Pixels held by one drawn page, and how to give them back. */
export interface PixelHolder {
	readonly pixels: number;
	/** Whether the page is in view; pages out of view are freed first. */
	visible(): boolean;
	/** Clears the page's canvas. Called by the budget, which has already stopped counting it. */
	free(): void;
}

/** Design 7-3: one per preview service, shared by every PDF preview. */
export class PixelBudget {
	private readonly held = new Set<PixelHolder>();

	constructor(readonly limit = TOTAL_PIXELS) {}

	get used(): number {
		let sum = 0;
		for (const h of this.held) sum += h.pixels;
		return sum;
	}

	/** Takes the holder's pixels, freeing pages out of view (oldest first) when needed. False: nothing was taken. */
	take(holder: PixelHolder): boolean {
		let used = this.used;
		if (holder.pixels > this.limit) return false;
		for (const h of [...this.held]) {
			if (used + holder.pixels <= this.limit) break;
			if (h.visible()) continue;
			this.held.delete(h);
			used -= h.pixels;
			h.free();
		}
		if (used + holder.pixels > this.limit) return false;
		this.held.add(holder);
		return true;
	}

	give(holder: PixelHolder): void {
		this.held.delete(holder);
	}
}

/** Design 7-3: fits the display width (times the device pixel ratio), but never above PAGE_PIXELS. */
export function pageScale(width: number, height: number, cssWidth: number, pixelRatio: number): number {
	const scale = (cssWidth / width) * pixelRatio;
	return width * height * scale * scale > PAGE_PIXELS ? Math.sqrt(PAGE_PIXELS / (width * height)) : scale;
}

export interface PdfDeps {
	loadPdfJs(): Promise<PdfJs>;
	/** Read when a preview starts: the budget the preview takes from is the one it gives back to. */
	budget(): PixelBudget;
	/** Defaults to an IntersectionObserver of the window the element is in (popouts included). */
	observe?(el: HTMLElement, onChange: (entries: readonly { target: Element; isIntersecting: boolean }[]) => void): { observe(el: Element): void; disconnect(): void };
}

interface PageView {
	readonly number: number;
	readonly el: HTMLElement;
	visible: boolean;
	drawing: boolean;
	canvas?: HTMLCanvasElement;
	holder?: PixelHolder;
	task?: PdfRenderTask;
	note?: HTMLElement;
}

function defaultObserve(el: HTMLElement, onChange: (entries: readonly IntersectionObserverEntry[]) => void) {
	const win = el.ownerDocument.defaultView ?? window;
	return new win.IntersectionObserver((entries) => onChange(entries), { rootMargin: '200px' });
}

/**
 * Draws pages as they come into view. The cached bytes are copied for pdf.js, which takes the buffer it is
 * given (O2): the copy is the only reference to it. `dispose` cancels drawing, clears the canvases, gives the
 * pixels back and destroys the document, whatever state the preview is in.
 */
export function renderPdf(content: PreviewPdf, deps: PdfDeps): Display {
	const box = createDiv({ cls: 'vault-s3-bridge-pdf' });
	// The canvas menu has no save item, but nothing is offered at all (I16).
	box.addEventListener('contextmenu', (e) => e.preventDefault());
	const budget = deps.budget();
	const pages = new Map<Element, PageView>();
	let disposed = false;
	let task: PdfLoadingTask | undefined;
	let observer: { observe(el: Element): void; disconnect(): void } | undefined;
	let document: PdfDocument | undefined;
	let annotationMode = 0;

	const showInfo = (reason?: PreviewInfo['reason']) => {
		if (disposed) return;
		clearAll();
		box.empty();
		box.appendChild(renderInfo({ kind: 'info', name: content.name, size: content.size, type: 'pdf', ...(reason ? { reason } : {}) }));
	};

	const clearPage = (page: PageView) => {
		page.task?.cancel();
		page.task = undefined;
		if (page.holder) budget.give(page.holder);
		page.holder = undefined;
		if (page.canvas) {
			page.canvas.width = 0;
			page.canvas.height = 0;
			page.canvas.remove();
		}
		page.canvas = undefined;
	};

	function clearAll(): void {
		observer?.disconnect();
		observer = undefined;
		for (const page of pages.values()) clearPage(page);
	}

	const draw = async (page: PageView) => {
		if (!document) return;
		page.drawing = true;
		page.note?.remove();
		page.note = undefined;
		let holder: PixelHolder | undefined;
		let freed = false;
		try {
			const p = await document.getPage(page.number);
			if (disposed || !page.visible || page.canvas) return;
			const base = p.getViewport({ scale: 1 });
			page.el.setCssProps({ '--vault-s3-bridge-page-ratio': `${base.width} / ${base.height}` });
			const win = page.el.ownerDocument.defaultView;
			const scale = pageScale(base.width, base.height, page.el.clientWidth || FALLBACK_WIDTH, win?.devicePixelRatio || 1);
			const viewport = p.getViewport({ scale });
			const width = Math.max(1, Math.floor(viewport.width));
			const height = Math.max(1, Math.floor(viewport.height));
			const current: PixelHolder = { pixels: width * height, visible: () => page.visible, free: () => clearPage(page) };
			if (!budget.take(current)) {
				page.note = page.el.createDiv({ cls: 'vault-s3-bridge-pdf-note', text: t('preview.pdf.memory') });
				return;
			}
			holder = current;
			page.holder = current;
			const canvas = page.el.createEl('canvas');
			canvas.width = width;
			canvas.height = height;
			page.canvas = canvas;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('no 2d context');
			page.task = p.render({ canvasContext: context, viewport, annotationMode });
			await page.task.promise;
		} catch {
			// Cancelled, or this page failed: whatever it still holds goes back.
			if (holder && page.holder === holder) clearPage(page);
			// Freed by the budget while out of view; it may have come back into view before the cancel settled.
			else freed = holder !== undefined;
		} finally {
			page.drawing = false;
			page.task = undefined;
		}
		if (freed && page.visible && !page.canvas && !disposed) void draw(page);
	};

	const onChange = (entries: readonly { target: Element; isIntersecting: boolean }[]) => {
		for (const entry of entries) {
			const page = pages.get(entry.target);
			if (!page) continue;
			page.visible = entry.isIntersecting;
			if (page.visible && !page.canvas && !page.drawing && !disposed) void draw(page);
		}
	};

	void (async () => {
		let password = false;
		let loaded = false;
		try {
			const pdfjs = await deps.loadPdfJs();
			if (disposed) return;
			annotationMode = pdfjs.AnnotationMode?.DISABLE ?? 0;
			loaded = true;
			// Fonts are loaded into the document the canvases are in, so a popout draws embedded fonts too.
			const current = pdfjs.getDocument({
				data: content.bytes.slice(),
				isEvalSupported: false,
				enableXfa: false,
				disableFontFace: false,
				ownerDocument: box.ownerDocument,
			});
			task = current;
			// No password field is ever shown (O2): the document is closed and the information card is shown.
			current.onPassword = () => {
				password = true;
				void current.destroy().catch(() => undefined);
			};
			const doc = await current.promise;
			if (disposed) return;
			document = doc;
			const first = (await doc.getPage(1)).getViewport({ scale: 1 });
			if (disposed) return;
			// Pages are laid out with the first page's shape until each one is drawn.
			for (let n = 1; n <= doc.numPages; n++) {
				const el = box.createDiv({ cls: 'vault-s3-bridge-pdf-page' });
				el.setCssProps({ '--vault-s3-bridge-page-ratio': `${first.width} / ${first.height}` });
				pages.set(el, { number: n, el, visible: false, drawing: false });
			}
			observer = (deps.observe ?? defaultObserve)(box, onChange);
			for (const el of pages.keys()) observer.observe(el);
		} catch {
			if (disposed) return;
			// The worker and its copy of the bytes are not kept for a card (a password has closed them already).
			if (!password) void task?.destroy().catch(() => undefined);
			showInfo(password ? 'password' : loaded ? 'broken' : undefined);
		}
	})();

	return {
		el: box,
		dispose() {
			if (disposed) return;
			disposed = true;
			clearAll();
			document = undefined;
			void task?.destroy().catch(() => undefined);
		},
	};
}
