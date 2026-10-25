// Design 8-8: listing archived files and moving them back where they were. Allowed while settings are read-only
// (I9): neither the storage nor the settings are used.
import type { JobLock } from '../upload/job';
import type { ArchiveVault } from './archive';
import { ARCHIVE_FOLDER, ARCHIVE_MARKER, isInArchive, nameKey, parseMarker, pathKey, restoredPathOf, type MarkerState } from './paths';

export type RestoreVault = Pick<ArchiveVault, 'files' | 'exists' | 'readMarker' | 'createFolder' | 'rename'>;

/** Whether the archive folder can be used: it exists and carries a marker of this version (8-1). */
export async function archiveMarker(vault: RestoreVault): Promise<'absent' | 'foreign' | MarkerState> {
	if (!(await vault.exists(ARCHIVE_FOLDER))) return 'absent';
	if (!(await vault.exists(ARCHIVE_MARKER))) return 'foreign';
	return parseMarker(await vault.readMarker());
}

/** The archived files that can go back (the marker is never listed: the vault does not list dot files). */
export function archivedFiles(vault: Pick<RestoreVault, 'files'>): { path: string; restoreTo: string; size: number }[] {
	return vault
		.files()
		.filter((f) => isInArchive(f.path))
		.flatMap((f) => {
			const restoreTo = restoredPathOf(f.path);
			return restoreTo ? [{ path: f.path, restoreTo, size: f.size }] : [];
		})
		.sort((a, b) => a.restoreTo.localeCompare(b.restoreTo));
}

export type RestoreSkip = 'unsafe' | 'occupied' | 'same-name' | 'failed';

export type RestoreResult =
	| { stop: 'busy' }
	| { stop: 'marker'; state: 'absent' | 'foreign' | Exclude<MarkerState, 'valid'> }
	| { restored: string[]; skipped: { path: string; reason: RestoreSkip }[] };

/**
 * Moves each chosen file back to its path outside the archive folder, only if that path is free and no file
 * outside the archive folder has the same name (I19 (5): a namesake decides where links resolve).
 */
export async function restoreFiles(lock: JobLock, vault: RestoreVault, paths: readonly string[]): Promise<RestoreResult> {
	const release = lock.acquire();
	if (!release) return { stop: 'busy' };
	try {
		const state = await archiveMarker(vault);
		if (state !== 'valid') return { stop: 'marker', state };
		const restored: string[] = [];
		const skipped: { path: string; reason: RestoreSkip }[] = [];
		for (const path of paths) {
			const to = restoredPathOf(path);
			if (!to) {
				skipped.push({ path, reason: 'unsafe' });
				continue;
			}
			const name = nameKey(path);
			if (vault.files().some((f) => !isInArchive(f.path) && pathKey(f.path) !== pathKey(path) && nameKey(f.path) === name)) {
				skipped.push({ path, reason: 'same-name' });
				continue;
			}
			try {
				if (await vault.exists(to)) {
					skipped.push({ path, reason: 'occupied' });
					continue;
				}
				const parts = to.split('/');
				for (let i = 1; i < parts.length; i++) {
					const folder = parts.slice(0, i).join('/');
					if (!(await vault.exists(folder))) await vault.createFolder(folder);
				}
				await vault.rename(path, to);
				restored.push(path);
			} catch {
				skipped.push({ path, reason: 'failed' });
			}
		}
		return { restored, skipped };
	} finally {
		release();
	}
}
