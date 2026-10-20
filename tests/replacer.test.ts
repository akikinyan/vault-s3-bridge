// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { PreviewError } from '../src/preview/errors';
import { ImageReplacer, type LeaseSource } from '../src/preview/replacer';
import type { Lease, PreviewImage } from '../src/preview/service';
import { installObsidianDomHelpers } from './fixtures/obsidianDom';

beforeAll(installObsidianDomHelpers);

interface FakeLease extends Lease {
	src: string;
	resolve(image: PreviewImage): void;
	reject(error: unknown): void;
}

function source() {
	const leases: FakeLease[] = [];
	const s: LeaseSource = {
		acquire(src) {
			let resolve!: (i: PreviewImage) => void;
			let reject!: (e: unknown) => void;
			const result = new Promise<PreviewImage>((res, rej) => {
				resolve = res;
				reject = rej;
			});
			result.catch(() => undefined);
			const lease: FakeLease = {
				src,
				result,
				released: false,
				release() {
					(lease as { released: boolean }).released = true;
				},
				resolve,
				reject,
			};
			leases.push(lease);
			return lease;
		},
	};
	return { s, leases };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const placeholder = (e: PreviewError) => {
	const span = document.createElement('span');
	span.className = 'ph';
	span.textContent = e.code;
	return span;
};

function setup() {
	const { s, leases } = source();
	const replacer = new ImageReplacer(() => s, placeholder);
	const root = document.createElement('div');
	document.body.appendChild(root);
	const img = document.createElement('img');
	img.setAttribute('src', 's3-bridge://work/a.png');
	root.appendChild(img);
	return { replacer, leases, root, img };
}

describe('ImageReplacer', () => {
	it('removes the unknown-scheme src immediately and shows the blob when ready', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		expect(img.getAttribute('src')).toBeNull();
		expect(img.dataset.s3BridgeRef).toBe('s3-bridge://work/a.png');
		leases[0]!.resolve({ url: 'blob:1', width: 1, height: 1 });
		await flush();
		expect(img.getAttribute('src')).toBe('blob:1');
	});

	it('ignores its own src changes (no observer loop)', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		replacer.process(img); // mutation record for removing src
		leases[0]!.resolve({ url: 'blob:1', width: 1, height: 1 });
		await flush();
		replacer.process(img); // mutation record for setting the blob URL
		expect(leases).toHaveLength(1);
		expect(leases[0]!.released).toBe(false);
	});

	it('releases the old lease when src changes to a normal URL, and never overwrites it later', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		img.setAttribute('src', 'app://vault/local.png');
		replacer.process(img);
		expect(leases[0]!.released).toBe(true);
		expect(img.dataset.s3BridgeRef).toBeUndefined();
		leases[0]!.resolve({ url: 'blob:old', width: 1, height: 1 });
		await flush();
		expect(img.getAttribute('src')).toBe('app://vault/local.png');
		expect(replacer.size).toBe(0);
	});

	it('switches to a new lease when src changes to another reference', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		img.setAttribute('src', 's3-bridge://work/b.png');
		replacer.process(img);
		expect(leases[0]!.released).toBe(true);
		expect(leases[1]!.src).toBe('s3-bridge://work/b.png');
		leases[0]!.resolve({ url: 'blob:old', width: 1, height: 1 });
		leases[1]!.resolve({ url: 'blob:new', width: 1, height: 1 });
		await flush();
		expect(img.getAttribute('src')).toBe('blob:new');
	});

	it('shows a placeholder on failure and removes it on release', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		leases[0]!.reject(new PreviewError('not-found'));
		await flush();
		const ph = root.querySelector('.ph');
		expect(ph?.textContent).toBe('not-found');
		expect(img.nextElementSibling).toBe(ph);
		expect(img.classList.contains('vault-s3-bridge-hidden')).toBe(true);
		replacer.release(img);
		expect(root.querySelector('.ph')).toBeNull();
		expect(img.classList.contains('vault-s3-bridge-hidden')).toBe(false);
	});

	it('shows nothing for aborted loads', async () => {
		const { replacer, leases, root } = setup();
		replacer.processTree(root);
		leases[0]!.reject(new PreviewError('aborted'));
		await flush();
		expect(root.querySelector('.ph')).toBeNull();
	});

	it('releases images inside a removed ancestor', () => {
		const { replacer, leases, root } = setup();
		replacer.processTree(root);
		root.remove();
		replacer.releaseTree(root);
		expect(leases[0]!.released).toBe(true);
		expect(replacer.size).toBe(0);
	});

	it('sweeps images that left the document without a removal record', () => {
		const { replacer, leases, root } = setup();
		replacer.processTree(root);
		root.remove();
		replacer.sweep();
		expect(leases[0]!.released).toBe(true);
	});

	it('keeps an image that is removed and re-added in the same mutation batch', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		const parent = img.parentElement!;
		img.remove();
		parent.appendChild(img); // CodeMirror moved the node
		replacer.processTree(img);
		replacer.releaseDetached([img]);
		expect(leases[0]!.released).toBe(false);
		leases[0]!.resolve({ url: 'blob:1', width: 1, height: 1 });
		await flush();
		expect(img.getAttribute('src')).toBe('blob:1');
		// Later eviction is still possible because the image is still tracked.
		expect(replacer.size).toBe(1);
	});

	it('an image released while detached is loaded again when it is attached in a later batch (still loading)', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		img.remove();
		replacer.releaseDetached([img]); // CodeMirror took the line out of the viewport
		expect(leases[0]!.released).toBe(true);
		root.appendChild(img); // ...and put the same DOM back later
		replacer.processTree(img);
		expect(leases).toHaveLength(2);
		expect(leases[1]!.src).toBe('s3-bridge://work/a.png');
		leases[1]!.resolve({ url: 'blob:2', width: 1, height: 1 });
		await flush();
		expect(img.getAttribute('src')).toBe('blob:2');
	});

	it('an image released while detached is loaded again when it is attached in a later batch (already shown)', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		leases[0]!.resolve({ url: 'blob:1', width: 1, height: 1 });
		await flush();
		img.remove();
		replacer.releaseDetached([img]); // the blob URL may be revoked now
		root.appendChild(img);
		replacer.processTree(img);
		expect(leases).toHaveLength(2);
		leases[1]!.resolve({ url: 'blob:2', width: 1, height: 1 });
		await flush();
		expect(img.getAttribute('src')).toBe('blob:2');
	});

	it('releases images that stay detached after the batch', () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		img.remove();
		replacer.releaseDetached([img]);
		expect(leases[0]!.released).toBe(true);
	});

	it('does not release an image rendered before insertion if it is attached before the next sweep', async () => {
		const { s, leases } = source();
		const replacer = new ImageReplacer(() => s, placeholder);
		const detached = document.createElement('div');
		const img = document.createElement('img');
		img.setAttribute('src', 's3-bridge://work/a.png');
		detached.appendChild(img);
		replacer.processTree(detached); // post-processor ran before Obsidian attached the element
		replacer.sweep();
		expect(leases[0]!.released).toBe(false);
		document.body.appendChild(detached);
		replacer.sweep();
		leases[0]!.resolve({ url: 'blob:1', width: 1, height: 1 });
		await flush();
		expect(img.getAttribute('src')).toBe('blob:1');
	});

	it('releases a never-attached image only after two sweeps', () => {
		const { s, leases } = source();
		const replacer = new ImageReplacer(() => s, placeholder);
		const img = document.createElement('img');
		img.setAttribute('src', 's3-bridge://work/a.png');
		replacer.processTree(img);
		replacer.sweep();
		expect(leases[0]!.released).toBe(false);
		replacer.sweep();
		expect(leases[0]!.released).toBe(true);
	});

	it('re-acquires connected images on refresh', () => {
		const { replacer, leases, root } = setup();
		replacer.processTree(root);
		replacer.refresh();
		expect(leases[0]!.released).toBe(true);
		expect(leases[1]!.src).toBe('s3-bridge://work/a.png');
	});

	it('leaves ordinary images alone', () => {
		const { replacer, leases, root, img } = setup();
		img.setAttribute('src', 'https://example.com/x.png');
		replacer.processTree(root);
		expect(leases).toHaveLength(0);
		expect(img.getAttribute('src')).toBe('https://example.com/x.png');
	});

	it('keeps an external src set right before the fetch result arrives, and releases the lease', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		img.setAttribute('src', 'https://example.com/x.png'); // changed before the observer ran
		leases[0]!.resolve({ url: 'blob:old', width: 1, height: 1 });
		await flush();
		expect(img.getAttribute('src')).toBe('https://example.com/x.png');
		expect(leases[0]!.released).toBe(true);
		expect(replacer.size).toBe(0);
	});

	it('starts over when the external src is another reference', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		img.setAttribute('src', 's3-bridge://work/b.png');
		leases[0]!.resolve({ url: 'blob:old', width: 1, height: 1 });
		await flush();
		expect(leases[0]!.released).toBe(true);
		expect(leases[1]!.src).toBe('s3-bridge://work/b.png');
		expect(img.getAttribute('src')).toBeNull();
	});

	it('keeps an external src set right before the fetch fails, and releases the lease', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		img.setAttribute('src', 'https://example.com/x.png'); // changed before the observer ran
		leases[0]!.reject(new PreviewError('not-found'));
		await flush();
		expect(img.getAttribute('src')).toBe('https://example.com/x.png');
		expect(img.classList.contains('vault-s3-bridge-hidden')).toBe(false);
		expect(root.querySelector('.ph')).toBeNull();
		expect(leases[0]!.released).toBe(true);
		expect(replacer.size).toBe(0);
	});

	it('starts over when the external src is another reference and the old fetch fails', async () => {
		const { replacer, leases, root, img } = setup();
		replacer.processTree(root);
		img.setAttribute('src', 's3-bridge://work/b.png');
		leases[0]!.reject(new PreviewError('not-found'));
		await flush();
		expect(leases[0]!.released).toBe(true);
		expect(leases[1]!.src).toBe('s3-bridge://work/b.png');
		expect(root.querySelector('.ph')).toBeNull();
		leases[1]!.resolve({ url: 'blob:new', width: 1, height: 1 });
		await flush();
		expect(img.getAttribute('src')).toBe('blob:new');
	});
});

describe('ImageReplacer — other displays (design 7-2, 7-7)', () => {
	it('an SVG goes into the img; text and information go after the hidden img and leave with it', async () => {
		const svg = setup();
		svg.replacer.process(svg.img);
		svg.leases[0]!.resolve({ kind: 'svg', url: 'blob:x/1' } as never);
		await flush();
		expect(svg.img.getAttribute('src')).toBe('blob:x/1');

		const t = setup();
		t.replacer.process(t.img);
		t.leases[0]!.resolve({ kind: 'text', text: '<b>not markup</b>', truncated: true } as never);
		await flush();
		expect(t.img.hasClass('vault-s3-bridge-hidden')).toBe(true);
		const pre = t.root.querySelector('pre.vault-s3-bridge-text')!;
		expect(pre.textContent).toBe('<b>not markup</b>');
		expect(pre.children).toHaveLength(0);
		t.replacer.release(t.img);
		expect(t.root.querySelector('pre')).toBeNull();
		expect(t.img.hasClass('vault-s3-bridge-hidden')).toBe(false);

		const i = setup();
		i.replacer.process(i.img);
		i.leases[0]!.resolve({ kind: 'info', name: 'a.pdf', size: 2048, type: 'pdf' } as never);
		await flush();
		expect(i.root.querySelector('.vault-s3-bridge-info-name')?.textContent).toBe('a.pdf');
	});
});
