// What the archive needs from Obsidian (design 8-2, 8-3, 8-6) and from AWS. Kept apart from archive.ts so the
// command itself runs without Obsidian. Desktop only: the vault folder is read through the file system adapter.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { type App, type EventRef, FileSystemAdapter, TextFileView, TFile } from 'obsidian';
import { jobClients } from '../upload/clients';
import type { UploadHost } from '../upload/obsidianJob';
import type { ArchiveDeps, ArchivePlan, ArchiveVault } from './archive';
import { ARCHIVE_MARKER, MARKER_CONTENT } from './paths';
import type { ArchiveFs } from './scan';
import { ChangeWatch } from './watch';

const toLf = (s: string) => s.replace(/\r\n/g, '\n');

/** Every loaded text view (Markdown, Canvas) with a file, in every window. */
function textViews(app: App): TextFileView[] {
	const views: TextFileView[] = [];
	app.workspace.iterateAllLeaves((leaf) => {
		if (leaf.view instanceof TextFileView && leaf.view.file) views.push(leaf.view);
	});
	return views;
}

/** Design 8-2 step 3: every open view saved; false if one still differs from its file afterwards. */
async function saveAllViews(app: App): Promise<boolean> {
	for (const view of textViews(app)) {
		const file = view.file;
		if (!file) continue;
		try {
			await view.save();
			if (toLf(view.getViewData()) !== toLf(await app.vault.read(file))) return false;
		} catch {
			return false;
		}
	}
	return true;
}

function adapterFs(adapter: FileSystemAdapter): ArchiveFs {
	const relative = (p: string) => p.replace(/^\/+/, '');
	return {
		list: async (folder) => {
			const listed = await adapter.list(folder === '' ? '/' : folder);
			return { files: listed.files.map(relative), folders: listed.folders.map(relative) };
		},
		stat: async (path) => {
			const s = await adapter.stat(path);
			if (!s) throw new Error('not found');
			return { size: s.size, mtime: s.mtime };
		},
		read: async (path) => new Uint8Array(await adapter.readBinary(path)),
		readHead: async (path, bytes) => {
			const handle = await open(adapter.getFullPath(path), 'r');
			try {
				const buffer = new Uint8Array(bytes);
				const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
				return buffer.subarray(0, bytesRead);
			} finally {
				await handle.close();
			}
		},
	};
}

function hashFile(adapter: FileSystemAdapter, path: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const hash = createHash('sha256');
		createReadStream(adapter.getFullPath(path))
			.on('data', (chunk) => hash.update(chunk))
			.on('error', () => resolve(undefined))
			.on('end', () => resolve(hash.digest('hex')));
	});
}

/** The vault as the archive and restore see it. Undefined without a file system adapter (not desktop). */
export function archiveVault(app: App): ArchiveVault | undefined {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) return undefined;
	return {
		fs: adapterFs(adapter),
		configDir: app.vault.configDir,
		files: () => app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size })),
		editors: () => textViews(app).map((v) => ({ path: v.file!.path, text: v.getViewData() })),
		indexed: () => ({
			resolved: Object.values(app.metadataCache.resolvedLinks).flatMap((targets) => Object.keys(targets)),
			unresolved: Object.values(app.metadataCache.unresolvedLinks).flatMap((links) => Object.keys(links)),
		}),
		hash: (path) => hashFile(adapter, path),
		exists: (path) => adapter.exists(path),
		readMarker: async () => {
			try {
				return await adapter.read(ARCHIVE_MARKER);
			} catch {
				return undefined;
			}
		},
		writeMarker: async () => {
			if (!(await adapter.exists(ARCHIVE_MARKER))) await adapter.write(ARCHIVE_MARKER, MARKER_CONTENT);
		},
		createFolder: async (path) => {
			await app.vault.createFolder(path);
		},
		rename: async (from, to) => {
			const file = app.vault.getAbstractFileByPath(from);
			if (!(file instanceof TFile)) throw new Error('not a file');
			// D15: vault.rename, not fileManager.renameFile, so no note is rewritten.
			await app.vault.rename(file, to);
		},
	};
}

/** Design 8-6: Obsidian's events, counted from now until disposed. */
function watchVault(app: App): { watch: ChangeWatch; dispose(): void } {
	const watch = new ChangeWatch();
	const vaultRefs: EventRef[] = [
		app.vault.on('create', (f) => watch.created(f.path)),
		app.vault.on('delete', (f) => watch.deleted(f.path)),
		app.vault.on('rename', (f, oldPath) => watch.renamed(f.path, oldPath)),
		app.vault.on('modify', (f) => watch.modifiedPath(f.path)),
	];
	const cacheRef = app.metadataCache.on('changed', (f) => watch.modifiedPath(f.path));
	const editorRef = app.workspace.on('editor-change', (_editor, info) => {
		if (info.file) watch.modifiedPath(info.file.path);
	});
	return {
		watch,
		dispose: () => {
			for (const ref of vaultRefs) app.vault.offref(ref);
			app.metadataCache.offref(cacheRef);
			app.workspace.offref(editorRef);
		},
	};
}

export interface ArchiveUi {
	confirm(plan: ArchivePlan): Promise<readonly string[] | undefined>;
	stop: AbortSignal;
}

/** The archive command's dependencies; `dispose` releases the S3 clients made for it. */
export function archiveCommandDeps(host: UploadHost, vault: ArchiveVault, ui: ArchiveUi): { deps: ArchiveDeps; dispose(): void } {
	const { app, store } = host;
	const clients = new Map<string, ReturnType<typeof jobClients>>();
	const deps: ArchiveDeps = {
		lock: host.lock,
		settings: store,
		layoutReady: () => app.workspace.layoutReady,
		saveEditors: () => saveAllViews(app),
		watch: () => watchVault(app),
		vault,
		client: (connectionId, signal) => {
			let c = clients.get(connectionId);
			if (!c) clients.set(connectionId, (c = jobClients(store, connectionId)));
			return c.client(signal);
		},
		timeoutMs: store.current.network.timeoutMs,
		signal: AbortSignal.any([host.unload, ui.stop]),
		confirm: (plan) => ui.confirm(plan),
	};
	return {
		deps,
		dispose: () => {
			for (const c of clients.values()) c.destroy();
		},
	};
}
