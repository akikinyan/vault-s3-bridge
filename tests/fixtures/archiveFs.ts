// An in-memory vault folder for the archive tests.
import type { ArchiveFs } from '../../src/archive/scan';

/** A file whose stat and reads fail. */
export const UNREADABLE = { unreadable: true } as const;
export type Entry = Uint8Array | { size: number } | typeof UNREADABLE;

/** A vault folder in memory: file path → bytes (or only a size, or a read that fails). */
export function memoryFs(files: Record<string, Entry | string>, failList: string[] = []) {
	const data = new Map<string, Entry>(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? new TextEncoder().encode(v) : v]));
	const reads: string[] = [];
	const folders = () => {
		const set = new Set<string>();
		for (const p of data.keys()) {
			const parts = p.split('/');
			for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
		}
		return set;
	};
	const childrenOf = (folder: string, all: Iterable<string>) => [...all].filter((p) => p.lastIndexOf('/') === (folder === '' ? -1 : folder.length) && (folder === '' || p.startsWith(`${folder}/`)));
	const fs: ArchiveFs = {
		list: async (folder) => {
			if (failList.includes(folder)) throw new Error('EACCES');
			return { files: childrenOf(folder, data.keys()), folders: childrenOf(folder, folders()) };
		},
		stat: async (path) => {
			const e = data.get(path);
			if (!e || e === UNREADABLE) throw new Error('ENOENT');
			return { size: e instanceof Uint8Array ? e.length : (e as { size: number }).size, mtime: 1 };
		},
		read: async (path) => {
			reads.push(path);
			const e = data.get(path);
			if (!(e instanceof Uint8Array)) throw new Error('EIO');
			return e;
		},
		readHead: async (path, bytes) => {
			const e = data.get(path);
			if (!(e instanceof Uint8Array)) throw new Error('EIO');
			return e.slice(0, bytes);
		},
	};
	return { fs, reads, data };
}
