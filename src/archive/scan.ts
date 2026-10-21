// Design 8-3: collecting references across the whole vault folder, dot folders and `.trash` included, and the
// snapshot that later checks compare against (8-6). The file system is passed in, so this runs without Obsidian.
import { createHash } from 'node:crypto';
import { extensionOf, looksBinary } from '../upload/fileType';
import { jsonStrings, NameMatcher, searchForms } from './decode';
import { ARCHIVE_MARKER, pathKey } from './paths';

const MB = 1024 * 1024;
/** Design 8-3: a text larger than this cannot be searched, so the collection is incomplete. */
export const MAX_TEXT_BYTES = 20 * MB;
/** Design 8-3: how much of a file of unknown kind is read to tell text from binary. */
export const SNIFF_BYTES = 8 * 1024;

/** Design 8-3: kinds that never hold Obsidian links, so they are not read (images, PDF, Office, archives, media). */
const BINARY_EXTENSIONS = new Set([
	...['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'ico', 'heic', 'heif', 'avif'],
	'pdf',
	...['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp'],
	...['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar'],
	...['mp3', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'flac', 'aac'],
	...['mp4', 'm4v', 'mov', 'ogv', 'webm', 'mkv', 'avi'],
]);
/** Design 8-3: kinds read whole and searched. */
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'canvas', 'html', 'htm', 'xhtml', 'txt', 'json', 'csv', 'xml', 'svg', 'css', 'js', 'yaml', 'yml', 'base']);

/** The vault folder as the adapter sees it. Paths are relative to the vault, `''` is its root. */
export interface ArchiveFs {
	list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	stat(path: string): Promise<{ size: number; mtime: number }>;
	read(path: string): Promise<Uint8Array>;
	/** The first `bytes` bytes, without reading the rest. */
	readHead(path: string, bytes: number): Promise<Uint8Array>;
}

/** text: searched; sniffed: of unknown kind and seen as binary; binary: a binary kind by its extension. */
export type ScannedKind = 'text' | 'sniffed' | 'binary';

export interface ScannedFile {
	/** As the adapter listed it, for later operations. Maps are keyed by `pathKey`. */
	path: string;
	size: number;
	mtime: number;
	kind: ScannedKind;
	/** SHA-256 of the bytes that were searched (text only). */
	sha256?: string;
	/** Inside a dot folder or itself a dot name: the vault reports no change for it (8-6). */
	unwatched: boolean;
}

/** Design 8-3 (measured for 8-6). */
export interface ScanSnapshot {
	folders: Set<string>;
	files: Map<string, ScannedFile>;
	/** SHA-256 of each open editor's content, by `pathKey` of its file. */
	editors: Map<string, string>;
}

/** not-listed: a file the vault lists was not found by walking the folder, so the walk cannot be trusted. */
export type IncompleteReason = 'too-large' | 'unreadable' | 'canvas' | 'not-listed';

/** Design 8-3 / I19: the collection could not be completed, so nothing may be archived. */
export class ScanIncomplete extends Error {
	constructor(
		readonly reason: IncompleteReason,
		readonly path: string,
	) {
		super(`reference collection incomplete: ${reason}`);
		this.name = 'ScanIncomplete';
	}
}

export interface ScanInput {
	fs: ArchiveFs;
	/** The configuration folder (`.obsidian`), never searched. */
	configDir: string;
	/** Files that may become candidates: id (`pathKey` of their path) → name with extension. */
	names: Iterable<readonly [string, string]>;
	/** Content of open text views (Markdown and Canvas), searched as well. */
	editors: readonly { path: string; text: string }[];
	signal?: AbortSignal;
}

export interface ScanResult {
	/** Ids of `names` that some text names. A file never counts as naming itself. */
	referenced: Set<string>;
	snapshot: ScanSnapshot;
}

export function sha256Hex(data: Uint8Array | string): string {
	return createHash('sha256').update(data).digest('hex');
}

/** Design 8-6: the vault reports nothing for a path with a dot segment (a dot folder, `.trash`, a dot file). */
export function isUnwatched(path: string): boolean {
	return path.split('/').some((s) => s.startsWith('.'));
}

/** Design 8-3: what is never searched nor compared: the configuration, `.git`, the archive marker. */
export function isOutOfScope(path: string, configDir: string): boolean {
	const key = pathKey(path);
	return key === pathKey(configDir) || key === '.git' || key === pathKey(ARCHIVE_MARKER);
}

/** How a file is treated, from its extension and, for an unknown kind, its first bytes. */
export async function kindOf(fs: ArchiveFs, path: string): Promise<ScannedKind> {
	const ext = extensionOf(path);
	if (BINARY_EXTENSIONS.has(ext)) return 'binary';
	if (TEXT_EXTENSIONS.has(ext)) return 'text';
	return looksBinary(await fs.readHead(path, SNIFF_BYTES)) ? 'sniffed' : 'text';
}

/** Walks the scope folder by folder: every folder and file in it, in listing order. */
export async function walk(fs: ArchiveFs, configDir: string, signal?: AbortSignal): Promise<{ folders: string[]; files: string[] }> {
	const folders: string[] = [];
	const files: string[] = [];
	const queue = [''];
	while (queue.length > 0) {
		signal?.throwIfAborted();
		const folder = queue.shift()!;
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await fs.list(folder);
		} catch {
			throw new ScanIncomplete('unreadable', folder);
		}
		for (const f of listed.folders) {
			if (isOutOfScope(f, configDir)) continue;
			folders.push(f);
			queue.push(f);
		}
		for (const f of listed.files) if (!isOutOfScope(f, configDir)) files.push(f);
	}
	return { folders, files };
}

/**
 * Design 8-3: reads every text in scope once, hashes its bytes, and looks for every candidate name in every
 * decoded form of it. Throws ScanIncomplete when a text cannot be searched (too large, unreadable, a Canvas
 * that is not JSON): the collection is then not complete and nothing may be archived (I19).
 */
export async function scanReferences(input: ScanInput): Promise<ScanResult> {
	const { fs, configDir, signal } = input;
	const matcher = new NameMatcher(input.names);
	const referenced = new Set<string>();
	const search = (text: string, own: string, parsed?: string) => {
		const found = new Set<string>();
		for (const form of searchForms(text, parsed)) matcher.find(form, found);
		found.delete(own);
		for (const id of found) referenced.add(id);
	};

	const { folders, files } = await walk(fs, configDir, signal);
	const snapshot: ScanSnapshot = { folders: new Set(folders.map(pathKey)), files: new Map(), editors: new Map() };
	for (const path of files) {
		signal?.throwIfAborted();
		let entry: ScannedFile;
		try {
			const { size, mtime } = await fs.stat(path);
			entry = { path, size, mtime, kind: await kindOf(fs, path), unwatched: isUnwatched(path) };
		} catch {
			throw new ScanIncomplete('unreadable', path);
		}
		if (entry.kind === 'text') {
			if (entry.size > MAX_TEXT_BYTES) throw new ScanIncomplete('too-large', path);
			let bytes: Uint8Array;
			try {
				bytes = await fs.read(path);
			} catch {
				throw new ScanIncomplete('unreadable', path);
			}
			if (bytes.length > MAX_TEXT_BYTES) throw new ScanIncomplete('too-large', path);
			// The bytes are hashed, not a decoded string: a text that is not UTF-8 compares equal when read again.
			entry.sha256 = sha256Hex(bytes);
			const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
			let parsed: string | undefined;
			if (extensionOf(path) === 'canvas') {
				try {
					parsed = jsonStrings(text);
				} catch {
					throw new ScanIncomplete('canvas', path);
				}
			}
			search(text, pathKey(path), parsed);
		}
		snapshot.files.set(pathKey(path), entry);
	}
	for (const editor of input.editors) {
		snapshot.editors.set(pathKey(editor.path), sha256Hex(editor.text));
		let parsed: string | undefined;
		if (extensionOf(editor.path) === 'canvas') {
			try {
				parsed = jsonStrings(editor.text);
			} catch {
				// An unsaved Canvas mid-edit: searched as written, with the JSON escapes decoded.
			}
		}
		search(editor.text, pathKey(editor.path), parsed);
	}
	return { referenced, snapshot };
}
