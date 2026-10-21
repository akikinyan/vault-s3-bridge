// Design 8-2 to 8-7: "Archive uploaded originals". A file moves into the archive folder only if no text in the
// vault names it, its bytes are in the upload history, the object holds those bytes, the user chose it, and
// nothing changed in the vault since all this was found out (I19, I20). Moving never deletes, and nothing on
// the storage changes. Obsidian stays outside: everything it provides is passed in.
import type { S3Client } from '@aws-sdk/client-s3';
import { classifyError, type ErrorCategory } from '../aws/errors';
import { connectionState, connectionTarget } from '../settings/registry';
import type { SettingsStore } from '../settings/store';
import type { HistoryEntry, PluginSettings } from '../settings/types';
import type { DeepReadonly } from '../util/deepReadonly';
import { extensionOf } from '../upload/fileType';
import { inExcludedFolder, type JobLock } from '../upload/job';
import { compareHead, headCommand } from '../upload/s3';
import { NameMatcher, normalizeForSearch } from './decode';
import { ARCHIVE_FOLDER, ARCHIVE_MARKER, archivedPathOf, isInArchive, nameKey, parseMarker, pathKey, type MarkerState } from './paths';
import { type ArchiveFs, type IncompleteReason, isUnwatched, kindOf, type ScannedFile, type ScanSnapshot, ScanIncomplete, scanReferences, sha256Hex, walk } from './scan';
import { archiveMarker } from './restore';
import type { ChangeWatch } from './watch';

const MB = 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/** What the vault offers the archive. Paths are vault paths as Obsidian gives them. */
export interface ArchiveVault {
	fs: ArchiveFs;
	configDir: string;
	/** `vault.getFiles()`: every file the vault lists (no dot folders). */
	files(): { path: string; size: number }[];
	/** Content of every open text view (Markdown and Canvas) in every window. */
	editors(): { path: string; text: string }[];
	/** The metadata cache: paths links resolve to, and the text of links that resolve to nothing. */
	indexed(): { resolved: Iterable<string>; unresolved: Iterable<string> };
	/** SHA-256 of a file's bytes, read as a stream. Undefined when it cannot be read. */
	hash(path: string): Promise<string | undefined>;
	exists(path: string): Promise<boolean>;
	readMarker(): Promise<string | undefined>;
	/** Writes the marker only if there is none (an existing one is never replaced). */
	writeMarker(): Promise<void>;
	createFolder(path: string): Promise<void>;
	/** `vault.rename`: links are not rewritten (D15). */
	rename(from: string, to: string): Promise<void>;
}

export interface ArchiveDeps {
	lock: JobLock;
	settings: Pick<SettingsStore, 'current' | 'checkpoint' | 'readOnly'>;
	layoutReady(): boolean;
	/** Saves every open text view; false if one could not be saved. */
	saveEditors(): Promise<boolean>;
	/** Starts watching the vault (8-6); disposed when the command ends. */
	watch(): { watch: ChangeWatch; dispose(): void };
	vault: ArchiveVault;
	client(connectionId: string, signal: AbortSignal): Promise<Pick<S3Client, 'send'>>;
	timeoutMs: number;
	signal: AbortSignal;
	/** Design 8-7: the paths the user chose, or undefined when cancelled. */
	confirm(plan: ArchivePlan): Promise<readonly string[] | undefined>;
}

/** Why a file that is not referenced is still not offered (8-4, 8-5). */
export type ExcludedReason = 'same-name' | 'too-large' | 'unreadable' | 'not-in-history' | 'not-on-storage' | 'unverified';

export interface ArchiveCandidate {
	path: string;
	size: number;
	sourceSha256: string;
	connectionId: string;
	alias: string;
	key: string;
	/** Design 8-5: the object holds the converted bytes (a public image without its metadata). */
	converted: boolean;
}

export interface ArchivePlan {
	candidates: ArchiveCandidate[];
	/** Counts only: there may be many (8-7). `referenced` counts files some text names. */
	excluded: Partial<Record<ExcludedReason | 'referenced', number>>;
}

/** Why one file was not moved and the files after it were not tried (8-6, last row). */
export type MoveStop = 'read-only' | 'changed' | 'source-changed' | 'occupied' | 'same-name' | 'marker' | 'unsafe' | 'failed';

export type ArchiveStop =
	| { stop: 'busy' | 'read-only' | 'not-ready' | 'save-failed' | 'changed' | 'cancelled' }
	| { stop: 'foreign-folder' }
	| { stop: 'marker'; state: Exclude<MarkerState, 'valid'> }
	| { stop: 'incomplete'; reason: IncompleteReason; path: string }
	| { stop: 'auth'; category: ErrorCategory }
	| { stop: 'nothing'; excluded: ArchivePlan['excluded'] };

export interface ArchiveDone {
	moved: string[];
	/** The file that stopped the moves, and why; the files after it were not tried. */
	stopped?: { path: string; reason: MoveStop };
	notTried: string[];
}

function activeConnectionOf(settings: DeepReadonly<PluginSettings>, entry: DeepReadonly<HistoryEntry>) {
	return settings.connections.find((c) => connectionState(settings, c) === 'active' && connectionTarget(c) === entry.target && c.classification === entry.classification);
}

class AuthStop extends Error {
	constructor(readonly category: ErrorCategory) {
		super('authentication failed');
	}
}

const isAuth = (category: ErrorCategory) => category === 'sso-login-required' || category === 'profile-config';

/**
 * Design 8-6: the content of every path reported modified, and of every open view, is still what was searched. Open
 * views are always compared: a Canvas edited in memory reports nothing until it is saved. A path the scan did not
 * see counts as changed.
 */
export async function contentsUnchanged(vault: ArchiveVault, snapshot: ScanSnapshot, paths: Iterable<string>): Promise<boolean> {
	const editors = new Map(vault.editors().map((e) => [pathKey(e.path), e.text]));
	for (const key of new Set([...paths, ...editors.keys()])) {
		const before = snapshot.files.get(key);
		const text = editors.get(key);
		if (!before) return false;
		if (text !== undefined) {
			const searched = snapshot.editors.get(key);
			// A view opened after the scan shows its file: compared as text, since line endings and a BOM may differ.
			if (searched !== undefined ? sha256Hex(text) !== searched : !(await viewShowsFile(vault.fs, before, text))) return false;
		}
		if (!(await sameContent(vault.fs, before))) return false;
	}
	return true;
}

const toLf = (s: string) => s.replace(/\r\n/g, '\n');

/** The view's text is the file's text, line endings and a leading BOM aside. */
async function viewShowsFile(fs: ArchiveFs, file: ScannedFile, text: string): Promise<boolean> {
	if (file.kind !== 'text') return false;
	try {
		const disk = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(await fs.read(file.path));
		return toLf(disk) === toLf(text);
	} catch {
		return false;
	}
}

/** A searched text has the same bytes; a file seen as binary is still binary; a binary kind is not compared. */
async function sameContent(fs: ArchiveFs, before: ScannedFile): Promise<boolean> {
	try {
		if (before.kind === 'text') return sha256Hex(await fs.read(before.path)) === before.sha256;
		if (before.kind === 'sniffed') return (await kindOf(fs, before.path)) === 'sniffed';
		return true;
	} catch {
		return false;
	}
}

/**
 * Design 8-6: walks the scope again and compares it with the snapshot. `all`: every folder and file, watched
 * files by size and time, the others by content. Otherwise only what the vault reports nothing about (dot names).
 */
export async function scopeUnchanged(vault: ArchiveVault, snapshot: ScanSnapshot, all: boolean): Promise<boolean> {
	let listed: { folders: string[]; files: string[] };
	try {
		listed = await walk(vault.fs, vault.configDir);
	} catch {
		return false;
	}
	const inScope = (p: string) => all || isUnwatched(p);
	const folders = new Set(listed.folders.map(pathKey).filter(inScope));
	const before = new Set([...snapshot.folders].filter(inScope));
	if (folders.size !== before.size || [...folders].some((f) => !before.has(f))) return false;
	const files = listed.files.filter((p) => inScope(pathKey(p)));
	if (files.length !== [...snapshot.files.keys()].filter(inScope).length) return false;
	for (const path of files) {
		const entry = snapshot.files.get(pathKey(path));
		if (!entry) return false;
		if (entry.unwatched) {
			if (!(await sameContent(vault.fs, entry))) return false;
		} else {
			try {
				const now = await vault.fs.stat(entry.path);
				if (now.size !== entry.size || now.mtime !== entry.mtime) return false;
			} catch {
				return false;
			}
		}
	}
	return true;
}

/** Design 8-4 step 3: every path by name (`nameKey` → `pathKey`s), built once for all candidates. */
function nameIndex(paths: Iterable<string>): Map<string, Set<string>> {
	const index = new Map<string, Set<string>>();
	for (const p of paths) {
		const name = nameKey(p);
		let set = index.get(name);
		if (!set) index.set(name, (set = new Set()));
		set.add(pathKey(p));
	}
	return index;
}

/** Another file in the index has the same name. */
function hasNamesake(path: string, index: Map<string, Set<string>>): boolean {
	const same = index.get(nameKey(path));
	return same !== undefined && [...same].some((p) => p !== pathKey(path));
}

/** The archive command (8-2). */
export async function archiveCommand(deps: ArchiveDeps): Promise<ArchiveStop | { done: ArchiveDone }> {
	const release = deps.lock.acquire();
	if (!release) return { stop: 'busy' };
	try {
		if (deps.settings.readOnly !== undefined) return { stop: 'read-only' };
		if (!deps.layoutReady()) return { stop: 'not-ready' };
		const state = await archiveMarker(deps.vault);
		if (state === 'foreign') return { stop: 'foreign-folder' };
		if (state === 'newer' || state === 'invalid') return { stop: 'marker', state };
		// Saved before watching, so the save's own late `modify` is compared, not taken as a change (8-2 step 3).
		if (!(await deps.saveEditors())) return { stop: 'save-failed' };
		const watching = deps.watch();
		try {
			return await run(deps, watching.watch);
		} finally {
			watching.dispose();
		}
	} finally {
		release();
	}
}

async function run(deps: ArchiveDeps, watch: ChangeWatch): Promise<ArchiveStop | { done: ArchiveDone }> {
	const { vault } = deps;
	const settings = deps.settings.current;
	const epoch = watch.epoch;

	// 8-4 step 1: what may be archived at all.
	const pool = vault
		.files()
		.filter((f) => !['md', 'canvas'].includes(extensionOf(f.path)) && !isInArchive(f.path) && !inExcludedFolder(f.path, settings.upload.excludeFolders));
	const names = pool.map((f) => [pathKey(f.path), f.path.slice(f.path.lastIndexOf('/') + 1)] as const);

	// 8-3: references.
	let referenced: Set<string>;
	let snapshot: ScanSnapshot;
	try {
		({ referenced, snapshot } = await scanReferences({ fs: vault.fs, configDir: vault.configDir, names, editors: vault.editors(), signal: deps.signal }));
	} catch (error) {
		if (error instanceof ScanIncomplete) return { stop: 'incomplete', reason: error.reason, path: error.path };
		throw error;
	}
	const unchanged = async () => watch.epoch === epoch && (await contentsUnchanged(vault, snapshot, watch.changed));
	// The walk must have found every file the vault lists: otherwise texts may have gone unsearched (I19).
	const missing = vault.files().find((f) => !snapshot.files.has(pathKey(f.path)));
	if (missing) return { stop: 'incomplete', reason: 'not-listed', path: missing.path };
	const indexed = vault.indexed();
	for (const p of indexed.resolved) referenced.add(pathKey(p));
	const unresolved = normalizeForSearch([...indexed.unresolved].join('\n'));
	new NameMatcher(names).find(unresolved, referenced);

	// 8-4 steps 2 to 5 and 8-5.
	const excluded: ArchivePlan['excluded'] = {};
	const exclude = (reason: ExcludedReason | 'referenced') => (excluded[reason] = (excluded[reason] ?? 0) + 1);
	const candidates: ArchiveCandidate[] = [];
	const namesakes = nameIndex([...[...snapshot.files.values()].map((f) => f.path), ...vault.files().map((f) => f.path)]);
	try {
		for (const file of pool) {
			deps.signal.throwIfAborted();
			if (referenced.has(pathKey(file.path))) {
				exclude('referenced');
				continue;
			}
			if (hasNamesake(file.path, namesakes)) {
				exclude('same-name');
				continue;
			}
			const limit = (IMAGE_EXTENSIONS.has(extensionOf(file.path)) ? settings.upload.maxFileMB : settings.upload.maxOtherFileMB) * MB;
			if (file.size > limit) {
				exclude('too-large');
				continue;
			}
			const sourceSha256 = await vault.hash(file.path);
			if (sourceSha256 === undefined) {
				exclude('unreadable');
				continue;
			}
			const entries = settings.history.filter((h) => h.sourceSha256 === sourceSha256).sort((a, b) => b.at.localeCompare(a.at));
			if (entries.length === 0) {
				exclude('not-in-history');
				continue;
			}
			const found = await onStorage(deps, entries);
			if (found === 'unverified' || found === 'absent') {
				exclude(found === 'absent' ? 'not-on-storage' : 'unverified');
				continue;
			}
			candidates.push({ path: file.path, size: file.size, sourceSha256, ...found });
		}
	} catch (error) {
		if (error instanceof AuthStop) return { stop: 'auth', category: error.category };
		throw error;
	}

	if (!(await unchanged())) return { stop: 'changed' };
	if (candidates.length === 0) return { stop: 'nothing', excluded };
	const chosen = await deps.confirm({ candidates, excluded });
	if (!chosen || chosen.length === 0) return { stop: 'cancelled' };
	const selected = candidates.filter((c) => chosen.includes(c.path));

	// 8-6, second row: before anything moves, the whole scope is as it was.
	if (deps.settings.readOnly !== undefined) return { stop: 'read-only' };
	if (!(await unchanged()) || !(await scopeUnchanged(vault, snapshot, true))) return { stop: 'changed' };

	const moved: string[] = [];
	for (const [i, c] of selected.entries()) {
		const reason = await moveOne(deps, watch, c, snapshot, unchanged);
		if (reason) return { done: { moved, stopped: { path: c.path, reason }, notTried: selected.slice(i + 1).map((x) => x.path) } };
		moved.push(c.path);
	}
	return { done: { moved, notTried: [] } };
}

/**
 * Design 8-5: the newest record of these bytes whose connection is active and still points to the recorded
 * storage, and whose object holds the bytes sent. An authentication failure stops the whole command.
 */
async function onStorage(deps: ArchiveDeps, entries: readonly DeepReadonly<HistoryEntry>[]): Promise<Omit<ArchiveCandidate, 'path' | 'size' | 'sourceSha256'> | 'absent' | 'unverified'> {
	let unverified = false;
	for (const entry of entries) {
		const c = activeConnectionOf(deps.settings.current, entry);
		if (!c) continue;
		let client: Pick<S3Client, 'send'>;
		try {
			client = await deps.client(c.id, deps.signal);
		} catch (error) {
			throw new AuthStop(classifyError(error).category);
		}
		// Started inside a checkpoint: the connection is still the one the record names, and nothing is read-only.
		const started = await deps.settings.checkpoint((s) => {
			if (deps.settings.readOnly !== undefined) return undefined;
			const now = activeConnectionOf(s, entry);
			if (!now || now.id !== c.id) return undefined;
			return { response: client.send(headCommand(now.bucket, entry.key), { abortSignal: deps.signal, requestTimeout: deps.timeoutMs }) };
		});
		if (!started) {
			unverified = true;
			continue;
		}
		try {
			if (compareHead(await started.response, entry.sentSha256) === 'match') {
				return { connectionId: c.id, alias: c.alias, key: entry.key, converted: entry.sentSha256 !== entry.sourceSha256 };
			}
		} catch (error) {
			const category = classifyError(error).category;
			if (isAuth(category)) throw new AuthStop(category);
			if (category === 'aborted') throw error;
			if (category !== 'not-found') unverified = true;
		}
	}
	return unverified ? 'unverified' : 'absent';
}

/** Design 8-6, last row, and 8-7: the checks right before one file moves, then the move. */
async function moveOne(deps: ArchiveDeps, watch: ChangeWatch, c: ArchiveCandidate, snapshot: ScanSnapshot, unchanged: () => Promise<boolean>): Promise<MoveStop | undefined> {
	const { vault } = deps;
	const to = archivedPathOf(c.path);
	if (!to) return 'unsafe';
	if (deps.settings.readOnly !== undefined) return 'read-only';
	if (!(await unchanged()) || !(await scopeUnchanged(vault, snapshot, false))) return 'changed';
	if ((await vault.hash(c.path)) !== c.sourceSha256) return 'source-changed';
	// What the vault lists now, and what it does not report (unchanged since the scan, as just checked).
	const unwatched = [...snapshot.files.values()].filter((f) => f.unwatched).map((f) => f.path);
	if (hasNamesake(c.path, nameIndex([...vault.files().map((f) => f.path), ...unwatched]))) return 'same-name';
	if (await vault.exists(to)) return 'occupied';
	try {
		// 8-1: the folder and its marker, made with the first move. An existing marker is never replaced.
		if (!(await vault.exists(ARCHIVE_FOLDER))) {
			watch.expect(ARCHIVE_FOLDER, ARCHIVE_MARKER);
			await vault.createFolder(ARCHIVE_FOLDER);
			await vault.writeMarker();
		}
		if (parseMarker(await vault.readMarker()) !== 'valid') return 'marker';
		const parts = to.split('/');
		for (let i = 2; i < parts.length; i++) {
			const folder = parts.slice(0, i).join('/');
			if (await vault.exists(folder)) continue;
			watch.expect(folder);
			await vault.createFolder(folder);
		}
		watch.expect(c.path, to);
		await vault.rename(c.path, to);
	} catch {
		return 'failed';
	}
	return undefined;
}
