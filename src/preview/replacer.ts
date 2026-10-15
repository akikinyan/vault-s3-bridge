import { REFERENCE_SCHEME } from '../reference/reference';
import { PreviewError } from './errors';
import type { Lease } from './service';

export interface LeaseSource {
	acquire(src: string): Lease;
}

export type PlaceholderRenderer = (error: PreviewError, reference: string) => HTMLElement;

const LOADING = 'vault-s3-bridge-loading';
const HIDDEN = 'vault-s3-bridge-hidden';

function imagesIn(node: Node): HTMLImageElement[] {
	// instanceOf (from Obsidian) also works for nodes of popout windows.
	if (node.instanceOf(HTMLImageElement)) return [node];
	if (node.instanceOf(Element)) return Array.from(node.querySelectorAll('img'));
	return [];
}

/**
 * Replaces `<img src="s3-bridge://…">` with authenticated previews, shared by reading view and live preview.
 * - The `src` attribute is removed before the browser can try to load the unknown scheme.
 * - Changes the replacer made itself are recognized and ignored (no observer loops).
 * - Any other `src` change releases the previous lease first, whatever the new scheme is.
 */
export class ImageReplacer {
	private readonly leases = new Map<HTMLImageElement, Lease>();
	private readonly ownSrc = new WeakMap<HTMLImageElement, string | null>();
	private readonly placeholders = new WeakMap<HTMLImageElement, HTMLElement>();
	/** Images seen attached to a document at least once. */
	private readonly connectedOnce = new WeakSet<HTMLImageElement>();
	/** Never-attached images found detached by the previous sweep. */
	private readonly detachedLastSweep = new WeakSet<HTMLImageElement>();

	constructor(
		private readonly source: () => LeaseSource,
		private readonly renderPlaceholder: PlaceholderRenderer,
	) {}

	/** Handles every image in a newly added or rendered subtree. */
	processTree(root: Node): void {
		for (const img of imagesIn(root)) this.process(img);
	}

	/** Handles one image whose `src` may have changed. */
	process(img: HTMLImageElement): void {
		const src = img.getAttribute('src');
		if (this.ownSrc.has(img) && this.ownSrc.get(img) === src) return; // our own change
		if (this.ownSrc.has(img)) this.release(img); // changed by someone else
		if (src?.startsWith(REFERENCE_SCHEME)) this.start(img, src);
	}

	private start(img: HTMLImageElement, src: string): void {
		if (img.isConnected) this.connectedOnce.add(img);
		img.dataset.s3BridgeRef = src;
		this.ownSrc.set(img, null);
		img.removeAttribute('src');
		img.addClass(LOADING);
		const lease = this.source().acquire(src);
		this.leases.set(img, lease);
		const current = () => !lease.released && this.leases.get(img) === lease;
		lease.result.then(
			(image) => {
				if (!current()) return;
				// Someone replaced the (removed) src before the observer noticed: their value wins.
				if (img.getAttribute('src') !== null) {
					this.process(img);
					return;
				}
				img.removeClass(LOADING);
				this.ownSrc.set(img, image.url);
				img.setAttribute('src', image.url);
			},
			(error: unknown) => {
				if (!current()) return;
				img.removeClass(LOADING);
				if (!(error instanceof PreviewError) || error.code === 'aborted') return;
				const placeholder = this.renderPlaceholder(error, src);
				img.addClass(HIDDEN);
				img.insertAdjacentElement('afterend', placeholder);
				this.placeholders.set(img, placeholder);
			},
		);
	}

	/** Releases the image's lease and undoes everything the replacer added. */
	release(img: HTMLImageElement): void {
		this.leases.get(img)?.release();
		this.leases.delete(img);
		this.ownSrc.delete(img);
		this.placeholders.get(img)?.remove();
		this.placeholders.delete(img);
		img.removeClass(LOADING);
		img.removeClass(HIDDEN);
		delete img.dataset.s3BridgeRef;
	}

	/** Releases every image in an unloaded subtree (the images themselves are not listed in removedNodes). */
	releaseTree(root: Node): void {
		for (const img of imagesIn(root)) if (this.leases.has(img)) this.release(img);
	}

	/**
	 * Releases images in subtrees removed during one mutation batch, but only if they are still detached
	 * after the whole batch: CodeMirror may detach and re-insert the same DOM.
	 */
	releaseDetached(roots: Iterable<Node>): void {
		for (const root of roots) {
			for (const img of imagesIn(root)) if (this.leases.has(img) && !img.isConnected) this.release(img);
		}
	}

	/**
	 * Safety net for missed removals. Images that were never attached yet (rendered before insertion)
	 * are released only if they are still detached at the next sweep.
	 */
	sweep(): void {
		for (const img of [...this.leases.keys()]) {
			if (img.isConnected) {
				this.connectedOnce.add(img);
				this.detachedLastSweep.delete(img);
			} else if (this.connectedOnce.has(img) || this.detachedLastSweep.has(img)) {
				this.release(img);
			} else {
				this.detachedLastSweep.add(img);
			}
		}
	}

	/** Re-acquires every connected image, e.g. after settings changed. */
	refresh(): void {
		for (const img of [...this.leases.keys()]) {
			const ref = img.dataset.s3BridgeRef;
			this.release(img);
			if (img.isConnected && ref) this.start(img, ref);
		}
	}

	releaseAll(): void {
		for (const img of [...this.leases.keys()]) this.release(img);
	}

	get size(): number {
		return this.leases.size;
	}
}
