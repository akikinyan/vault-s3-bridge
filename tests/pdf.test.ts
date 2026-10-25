// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { contentRenderer } from '../src/preview/display';
import { PAGE_PIXELS, pageScale, PixelBudget, renderPdf, type PdfDeps, type PdfJs, type PdfLoadingTask, type PixelHolder } from '../src/preview/pdf';
import { ImageReplacer, type LeaseSource } from '../src/preview/replacer';
import type { Lease, PreviewContent, PreviewPdf } from '../src/preview/service';
import { installObsidianDomHelpers } from './fixtures/obsidianDom';

beforeAll(() => {
	installObsidianDomHelpers();
	// happy-dom has no 2D context; drawing itself is pdf.js's work and is faked below.
	HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement['getContext'];
});

const flush = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface FakeOptions {
	pages?: number;
	size?: { width: number; height: number };
	/** 'password' calls onPassword and then rejects like pdf.js; 'broken' rejects. */
	outcome?: 'ok' | 'password' | 'broken';
	/** Holds getDocument's promise until released. */
	holdLoad?: boolean;
	/** Holds every render until released. */
	holdRender?: boolean;
	/** A cancelled render settles only when the test says so. */
	holdCancel?: boolean;
}

function fakePdfJs(o: FakeOptions = {}) {
	const log = {
		sources: [] as Record<string, unknown>[],
		received: [] as number[],
		renders: [] as { page: number; width: number; height: number; annotationMode: number }[],
		cancelled: 0,
		destroyed: 0,
		releaseLoad: () => undefined as void,
		releaseRenders: [] as (() => void)[],
		settleCancels: [] as (() => void)[],
	};
	const size = o.size ?? { width: 600, height: 800 };
	const pdfjs: PdfJs = {
		AnnotationMode: { DISABLE: 0 },
		getDocument(source) {
			log.sources.push({ ...source });
			log.received.push(source.data.byteLength);
			// As in Electron (O2): the buffer handed to pdf.js is transferred to its worker.
			structuredClone(source.data.buffer, { transfer: [source.data.buffer] });
			const load = deferred<void>();
			log.releaseLoad = () => load.resolve();
			if (!o.holdLoad) load.resolve();
			const task: PdfLoadingTask = {
				onPassword: undefined,
				destroy: async () => {
					log.destroyed++;
				},
				promise: Promise.resolve() as unknown as PdfLoadingTask['promise'],
			};
			task.promise = (async () => {
					await load.promise;
					if (o.outcome === 'password') {
						task.onPassword?.(() => undefined, 1);
						throw Object.assign(new Error('No password given'), { name: 'PasswordException' });
					}
					if (o.outcome === 'broken') throw Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' });
					return {
						numPages: o.pages ?? 2,
						getPage: async (n: number) => ({
							getViewport: ({ scale }: { scale: number }) => ({ width: size.width * scale, height: size.height * scale }),
							render: ({ viewport, annotationMode }: { viewport: { width: number; height: number }; annotationMode: number }) => {
								log.renders.push({ page: n, width: viewport.width, height: viewport.height, annotationMode });
								const done = deferred<void>();
								if (o.holdRender) log.releaseRenders.push(() => done.resolve());
								else done.resolve();
								return {
									promise: done.promise,
									cancel: () => {
										log.cancelled++;
										const settle = () => done.reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
										if (o.holdCancel) log.settleCancels.push(settle);
										else settle();
									},
								};
							},
						}),
					};
				})();
			return task;
		},
	};
	return { pdfjs, log };
}

/** An IntersectionObserver stand-in driven by the test. */
function fakeObserver() {
	let notify: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | undefined;
	const observed: Element[] = [];
	let disconnected = false;
	const observe: NonNullable<PdfDeps['observe']> = (_el, onChange) => {
		notify = onChange;
		return {
			observe: (el) => observed.push(el),
			disconnect: () => {
				disconnected = true;
			},
		};
	};
	return {
		observe,
		show: (indexes: number[], visible = true) => notify?.(indexes.map((i) => ({ target: observed[i]!, isIntersecting: visible }))),
		get disconnected() {
			return disconnected;
		},
	};
}

const pdfContent = (bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4])): PreviewPdf => ({ kind: 'pdf', name: 'a.pdf', size: bytes.length, bytes });

function setup(o: FakeOptions = {}, budget = new PixelBudget()) {
	const { pdfjs, log } = fakePdfJs(o);
	const io = fakeObserver();
	const deps: PdfDeps = { loadPdfJs: async () => pdfjs, budget: () => budget, observe: io.observe };
	return { deps, log, io, budget };
}

const holder = (pixels: number, visible = false) => {
	const h = { pixels, freed: 0, visible: () => visible, free: () => void h.freed++ };
	return h satisfies PixelHolder;
};

describe('pageScale (7-3)', () => {
	it('fits the width times the pixel ratio', () => {
		expect(pageScale(600, 800, 300, 2)).toBe(1);
	});

	it('never draws a page above 16 million pixels', () => {
		const s = pageScale(14400, 14400, 800, 2);
		expect(14400 * 14400 * s * s).toBeLessThanOrEqual(PAGE_PIXELS + 1);
		expect(pageScale(600, 800, 20_000, 1)).toBeCloseTo(Math.sqrt(PAGE_PIXELS / (600 * 800)));
	});
});

describe('PixelBudget (7-3)', () => {
	it('frees pages out of view, oldest first, and only as many as needed', () => {
		const b = new PixelBudget(100);
		const a = holder(40);
		const c = holder(40);
		expect(b.take(a)).toBe(true);
		expect(b.take(c)).toBe(true);
		expect(b.take(holder(50))).toBe(true);
		expect([a.freed, c.freed]).toEqual([1, 0]);
		expect(b.used).toBe(90);
	});

	it('takes nothing when the pages in view already use it', () => {
		const b = new PixelBudget(100);
		b.take(holder(80, true));
		const big = holder(30);
		expect(b.take(big)).toBe(false);
		expect(b.take(holder(101))).toBe(false);
		expect(b.used).toBe(80);
	});
});

describe('renderPdf (7-2)', () => {
	it('hands pdf.js its own copy: the cached bytes stay whole and can be drawn again', async () => {
		const t = setup();
		const content = pdfContent();
		renderPdf(content, t.deps);
		renderPdf(content, t.deps);
		await flush();
		expect(content.bytes.byteLength).toBe(8);
		expect(t.log.received).toEqual([8, 8]);
		expect(t.log.sources[0]).toMatchObject({ isEvalSupported: false, enableXfa: false, disableFontFace: false, ownerDocument: document });
		// Obsidian's bundled data files, as its own viewer uses them: without the CMaps CID fonts have no glyphs.
		expect(t.log.sources[0]).toMatchObject({ cMapUrl: '/lib/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/lib/pdfjs/standard_fonts/' });
	});

	it('draws only pages in view, without annotations, within the page limit', async () => {
		const t = setup({ pages: 3 });
		const display = renderPdf(pdfContent(), t.deps);
		document.body.appendChild(display.el);
		await flush();
		expect(display.el.querySelectorAll('.vault-s3-bridge-pdf-page')).toHaveLength(3);
		expect(t.log.renders).toEqual([]);
		t.io.show([1]);
		await flush();
		expect(t.log.renders).toEqual([{ page: 2, width: 800, height: 800 * (800 / 600), annotationMode: 0 }]);
		const canvas = display.el.querySelectorAll('canvas');
		expect(canvas).toHaveLength(1);
		expect(t.budget.used).toBe(canvas[0]!.width * canvas[0]!.height);
		display.dispose?.();
		expect(t.budget.used).toBe(0);
		expect(canvas[0]!.width).toBe(0);
		expect(t.io.disconnected).toBe(true);
		expect(t.log.destroyed).toBe(1);
	});

	it('a page needing more than the whole budget is not drawn: the memory note is shown', async () => {
		const t = setup({ pages: 1 }, new PixelBudget(1000));
		const display = renderPdf(pdfContent(), t.deps);
		await flush();
		t.io.show([0]);
		await flush();
		expect(t.log.renders).toEqual([]);
		expect(display.el.querySelector('.vault-s3-bridge-pdf-note')?.textContent).toBe('Not shown: the memory limit for previews was reached.');
	});

	it('pages out of view of another PDF are freed to draw a page in view, and drawn again when seen', async () => {
		const budget = new PixelBudget(800 * 1067 + 10);
		const first = setup({ pages: 1 }, budget);
		const a = renderPdf(pdfContent(), first.deps);
		await flush();
		first.io.show([0]);
		await flush();
		expect(a.el.querySelector('canvas')?.width).toBe(800);
		first.io.show([0], false);
		const second = setup({ pages: 1 }, budget);
		const b = renderPdf(pdfContent(), second.deps);
		await flush();
		second.io.show([0]);
		await flush();
		expect(a.el.querySelector('canvas')).toBeNull();
		expect(b.el.querySelector('canvas')?.width).toBe(800);
		b.dispose?.();
		first.io.show([0]);
		await flush();
		expect(a.el.querySelector('canvas')?.width).toBe(800);
		expect(first.log.renders).toHaveLength(2);
	});

	it('a page freed while drawing and seen again before the cancel settles is drawn again', async () => {
		const budget = new PixelBudget(800 * 1067 + 10);
		const first = setup({ pages: 1, holdRender: true, holdCancel: true }, budget);
		const a = renderPdf(pdfContent(), first.deps);
		await flush();
		first.io.show([0]);
		await flush();
		first.io.show([0], false);
		const second = setup({ pages: 1 }, budget);
		const b = renderPdf(pdfContent(), second.deps);
		await flush();
		second.io.show([0]);
		await flush();
		// The page of the first PDF is cancelled, but its drawing has not settled when it is seen again.
		expect(first.log.cancelled).toBe(1);
		b.dispose?.();
		first.io.show([0]);
		await flush();
		expect(first.log.renders).toHaveLength(1);
		first.log.settleCancels.forEach((settle) => settle());
		await flush();
		expect(first.log.renders).toHaveLength(2);
		expect(a.el.querySelector('canvas')?.width).toBe(800);
	});

	it('a password closes the document and shows the information card, with no field to type into', async () => {
		const t = setup({ outcome: 'password' });
		const display = renderPdf(pdfContent(), t.deps);
		await flush();
		expect(t.log.destroyed).toBe(1);
		expect(display.el.querySelector('input')).toBeNull();
		expect(display.el.querySelector('.vault-s3-bridge-info')?.textContent).toContain('PDFs with a password cannot be previewed.');
	});

	it('a broken PDF shows the information card', async () => {
		const t = setup({ outcome: 'broken' });
		const display = renderPdf(pdfContent(), t.deps);
		await flush();
		expect(display.el.querySelector('.vault-s3-bridge-info')?.textContent).toContain('This PDF could not be read.');
		expect(t.log.destroyed).toBe(1);
	});

	it('released while loading: the document is destroyed and nothing is drawn', async () => {
		const t = setup({ holdLoad: true });
		const display = renderPdf(pdfContent(), t.deps);
		await flush();
		display.dispose?.();
		t.log.releaseLoad();
		await flush();
		expect(t.log.destroyed).toBe(1);
		expect(display.el.querySelector('.vault-s3-bridge-pdf-page')).toBeNull();
		expect(display.el.querySelector('.vault-s3-bridge-info')).toBeNull();
	});

	it('released while drawing: the drawing is cancelled and its pixels given back', async () => {
		const t = setup({ holdRender: true });
		const display = renderPdf(pdfContent(), t.deps);
		await flush();
		t.io.show([0, 1]);
		await flush();
		expect(t.budget.used).toBeGreaterThan(0);
		display.dispose?.();
		await flush();
		expect(t.log.cancelled).toBe(2);
		expect(t.budget.used).toBe(0);
		expect(display.el.querySelector('canvas')).toBeNull();
	});
});

describe('the replacer and a PDF (7-7)', () => {
	function leaseOf(content: PreviewContent): LeaseSource {
		return {
			acquire(): Lease {
				const lease = { result: Promise.resolve(content), released: false, release: () => void (lease.released = true) };
				return lease;
			},
		};
	}

	it('the PDF goes after the hidden img; releasing the img disposes of it', async () => {
		const t = setup();
		const replacer = new ImageReplacer(() => leaseOf(pdfContent()), () => createDiv(), contentRenderer(t.deps));
		const img = document.createElement('img');
		img.setAttribute('src', 's3-bridge://work/a.pdf');
		document.body.appendChild(img);
		replacer.process(img);
		await flush();
		t.io.show([0]);
		await flush();
		expect(img.nextElementSibling?.className).toBe('vault-s3-bridge-pdf');
		// The editor's image menu (copy fetches the s3-bridge URL, remove edits the note) never sees a right-click.
		let reached = 0;
		document.body.addEventListener('contextmenu', () => reached++);
		const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		img.nextElementSibling!.dispatchEvent(menu);
		expect([reached, menu.defaultPrevented]).toEqual([0, true]);
		expect(t.budget.used).toBeGreaterThan(0);
		replacer.release(img);
		expect(img.nextElementSibling).toBeNull();
		expect(t.budget.used).toBe(0);
		expect(t.log.destroyed).toBe(1);
	});

	it('without pdf.js a PDF is shown as its information card', async () => {
		const display = contentRenderer()(pdfContent(), 's3-bridge://work/a.pdf');
		expect(display.el.className).toBe('vault-s3-bridge-info');
		expect(display.dispose).toBeUndefined();
	});
});
