// What the upload job needs from Obsidian (design 8-1, 8-4, 9-2, 10-2, 4-3) and from AWS, built for one note.
// Kept apart from job.ts so the job itself runs without Obsidian.
import { type App, type EventRef, MarkdownView, type TFile } from 'obsidian';
import { profileOf } from '../settings/device';
import type { SettingsStore } from '../settings/store';
import type { StorageConnection } from '../settings/types';
import type { DeepReadonly } from '../util/deepReadonly';
import type { DecodedImage, Encoder } from './convert';
import { type CacheView, type DetectSource, type Detection, detectEmbeds } from './detect';
import { type CommandDeps, type JobLock, type JobPlan, type ResumeCommandDeps, resumeJob, type ResumeTarget, runJob, type SourceFile } from './job';
import type { PendingStore } from './pending';
import { jobClients } from './clients';
import type { EditorLike, NoteAccess } from './rewrite';

const toLf = (s: string) => s.replace(/\r\n/g, '\n');

/** 9-2: loaded Markdown views of this file, wherever their tabs are. A tab not loaded yet has no MarkdownView. */
export function openViews(app: App, file: TFile): MarkdownView[] {
	return app.workspace
		.getLeavesOfType('markdown')
		.map((l) => l.view)
		.filter((v): v is MarkdownView => v instanceof MarkdownView && v.file === file);
}

/**
 * 8-1 step 2 (D1): when an open editor holds text that is not on disk yet, save it first, then read again.
 * False if the editor and the disk still differ afterwards.
 */
export async function saveOpenEditors(app: App, file: TFile): Promise<boolean> {
	for (const view of openViews(app, file)) {
		const disk = await app.vault.read(file);
		if (toLf(view.editor.getValue()) === toLf(disk)) continue;
		try {
			await view.save();
		} catch {
			return false;
		}
		if (toLf(view.editor.getValue()) !== toLf(await app.vault.read(file))) return false;
	}
	return true;
}

/** 8-3: the note on disk and its metadataCache entry. */
export function detectSource(app: App, file: TFile): DetectSource {
	return {
		read: () => app.vault.read(file),
		cache: (): CacheView | undefined => {
			const c = app.metadataCache.getFileCache(file);
			if (!c) return undefined;
			const ranges = (type: string) =>
				(c.sections ?? []).filter((s) => s.type === type).map((s) => ({ startLine: s.position.start.line, endLine: s.position.end.line }));
			return {
				embeds: (c.embeds ?? []).map((e) => ({ offset: e.position.start.offset, original: e.original })),
				tables: ranges('table'),
				comments: ranges('comment'),
			};
		},
		waitForChange: (ms) =>
			new Promise<void>((resolve) => {
				let ref: EventRef | undefined;
				const done = () => {
					window.clearTimeout(timer);
					if (ref) app.metadataCache.offref(ref);
					resolve();
				};
				const timer = window.setTimeout(done, ms);
				ref = app.metadataCache.on('changed', (f) => {
					if (f === file) done();
				});
			}),
	};
}

/** 8-4: a link resolved from the note to a file in the vault. */
export function resolveLink(app: App, notePath: string, linkpath: string): SourceFile | undefined {
	const file = app.metadataCache.getFirstLinkpathDest(linkpath, notePath);
	if (!file) return undefined;
	return {
		path: file.path,
		basename: file.basename,
		size: file.stat.size,
		read: async () => new Uint8Array(await app.vault.readBinary(file)),
	};
}

/** 9-2 for the note; `wasOpenAtStart` uses the same test as `openEditors`. */
export function noteAccess(app: App, file: TFile): NoteAccess {
	const editors = (): EditorLike[] => openViews(app, file).map((v) => v.editor);
	return {
		openEditors: editors,
		wasOpenAtStart: editors().length > 0,
		exists: () => app.vault.getFileByPath(file.path) === file,
		process: (fn) => app.vault.process(file, fn),
		read: () => app.vault.read(file),
	};
}

/** 10-2: paths modified, deleted or renamed (old and new path) since it was created. */
export function watchSources(app: App): { changed(path: string): boolean; dispose(): void } {
	const paths = new Set<string>();
	const refs = [
		app.vault.on('modify', (f) => void paths.add(f.path)),
		app.vault.on('delete', (f) => void paths.add(f.path)),
		app.vault.on('rename', (f, oldPath) => {
			paths.add(f.path);
			paths.add(oldPath);
		}),
	];
	return {
		changed: (path) => paths.has(path),
		dispose: () => {
			for (const ref of refs) app.vault.offref(ref);
		},
	};
}

/** 4-3 with the renderer's decoder and an OffscreenCanvas. */
export const canvasEncoder: Encoder = {
	electronVersion: (process.versions as Record<string, string | undefined>).electron ?? 'unknown',
	async decode(bytes, mime): Promise<DecodedImage> {
		const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), { imageOrientation: 'from-image' });
		let canvas: OffscreenCanvas;
		try {
			canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('no 2d context');
			ctx.drawImage(bitmap, 0, 0);
		} finally {
			bitmap.close();
		}
		return {
			width: canvas.width,
			height: canvas.height,
			encode: async (type, quality) => new Uint8Array(await (await canvas.convertToBlob(quality === undefined ? { type } : { type, quality })).arrayBuffer()),
			close: () => {
				canvas.width = 0;
				canvas.height = 0;
			},
		};
	},
};

export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

export interface UploadHost {
	app: App;
	store: SettingsStore;
	/** Undefined where the plugin folder is not on the file system (the job then never starts). */
	pending: PendingStore | undefined;
	lock: JobLock;
	/** Aborted when the plugin unloads. */
	unload: AbortSignal;
}

export interface UploadUi {
	pickConnection(): Promise<DeepReadonly<StorageConnection> | undefined>;
	confirm(plan: JobPlan, preview: boolean): Promise<'replace' | 'copy' | undefined>;
	/** The stop button of the progress notice (10-4). */
	stop: AbortSignal;
}

/**
 * Everything uploadCommand needs for the note in `file`. Source changes are watched from now on (10-2: from
 * preparing until the job ends); call dispose() when the command has finished.
 */
export function uploadCommandDeps(host: UploadHost, file: TFile, ui: UploadUi): { deps: CommandDeps; dispose(): void } {
	const { app, store } = host;
	const watch = watchSources(app);
	// 9-2: "open when the job started" is decided now, not when the links are applied after confirming.
	const note = noteAccess(app, file);
	const authGeneration = (id: string) => profileOf(store.device, id)?.generation;
	const deps: CommandDeps = {
		lock: host.lock,
		pending: host.pending ?? { status: 'unloaded' },
		settings: store,
		notePath: file.path,
		pickConnection: () => ui.pickConnection(),
		detect: async (): Promise<Detection> => {
			if (!(await saveOpenEditors(app, file))) return { ok: false, reason: 'changed' };
			return detectEmbeds(detectSource(app, file));
		},
		prepare: {
			resolveLink: (linkpath) => resolveLink(app, file.path, linkpath),
			encoder: canvasEncoder,
			now: () => new Date(),
			newId: () => crypto.randomUUID(),
		},
		authGeneration,
		confirm: (plan, preview) => ui.confirm(plan, preview),
		run: async (plan, confirmed) => {
			const pending = host.pending;
			if (!pending) throw new Error('no record store');
			const clients = jobClients(store, plan.target.connectionId);
			const stop = AbortSignal.any([host.unload, ui.stop]);
			try {
				return await runJob(plan, confirmed, {
					settings: store,
					pending,
					client: (signal) => clients.client(signal),
					timeoutMs: store.current.network.timeoutMs,
					signal: stop,
					authGeneration,
					sourceChanged: (path) => watch.changed(path),
					readSource: (path) => readVaultFile(app, path),
					note,
					copy: copyToClipboard,
					sleep: abortableSleep,
					random: () => Math.random(),
					now: () => new Date(),
					newId: () => crypto.randomUUID(),
				});
			} finally {
				clients.destroy();
			}
		},
	};
	return { deps, dispose: () => watch.dispose() };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(new Error('aborted'));
		const timer = window.setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			window.clearTimeout(timer);
			reject(new Error('aborted'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

async function readVaultFile(app: App, path: string): Promise<Uint8Array | undefined> {
	const f = app.vault.getFileByPath(path);
	return f ? new Uint8Array(await app.vault.readBinary(f)) : undefined;
}

export interface ResumeUi {
	confirm(targets: readonly ResumeTarget[], mismatched: number): Promise<boolean>;
	stop: AbortSignal;
}

/** Everything resumeCommand needs. Source changes are watched from now on; call dispose() when it has finished. */
export function resumeCommandDeps(host: UploadHost, pending: PendingStore, ui: ResumeUi): { deps: ResumeCommandDeps; dispose(): void } {
	const { app, store } = host;
	const watch = watchSources(app);
	const authGeneration = (id: string) => profileOf(store.device, id)?.generation;
	const deps: ResumeCommandDeps = {
		lock: host.lock,
		pending,
		settings: store,
		authGeneration,
		confirm: (targets, mismatched) => ui.confirm(targets, mismatched),
		run: async (target, confirmed) => {
			const clients = jobClients(store, target.connection.id);
			try {
				return await resumeJob(target, confirmed, {
					settings: store,
					pending,
					client: (signal) => clients.client(signal),
					timeoutMs: store.current.network.timeoutMs,
					signal: AbortSignal.any([host.unload, ui.stop]),
					authGeneration,
					sourceChanged: (path) => watch.changed(path),
					readSource: (path) => readVaultFile(app, path),
					encoder: canvasEncoder,
					sleep: abortableSleep,
					random: () => Math.random(),
					now: () => new Date(),
					newId: () => crypto.randomUUID(),
				});
			} finally {
				clients.destroy();
			}
		},
	};
	return { deps, dispose: () => watch.dispose() };
}
