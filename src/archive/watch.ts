// Design 8-6 (I20): what changed in the vault since references were collected. Obsidian's events are fed in by
// the caller; this only counts them.
import { pathKey } from './paths';

/**
 * Additions, deletions and renames advance the epoch: they can change what a link resolves to even when no note
 * changes. Modifications only mark the path: its content is compared later, since a save reports `modify` about
 * two seconds after it happened, with nothing changed. Events on paths the archive is about to create or move
 * itself are ignored, however many arrive (the exact events of a create or rename are Obsidian's to choose).
 */
export class ChangeWatch {
	private count = 0;
	private readonly modified = new Set<string>();
	private readonly own = new Set<string>();

	get epoch(): number {
		return this.count;
	}

	/** Paths whose content may have changed, as `pathKey`. */
	get changed(): ReadonlySet<string> {
		return this.modified;
	}

	/** Registers paths the archive is about to create or move from and to. */
	expect(...paths: string[]): void {
		for (const p of paths) this.own.add(pathKey(p));
	}

	created(path: string): void {
		if (!this.own.has(pathKey(path))) this.count++;
	}

	deleted(path: string): void {
		if (!this.own.has(pathKey(path))) this.count++;
	}

	renamed(path: string, oldPath: string): void {
		if (!this.own.has(pathKey(path)) || !this.own.has(pathKey(oldPath))) this.count++;
	}

	/** `modify`, the metadata cache's `changed`, or an editor's change. */
	modifiedPath(path: string): void {
		const key = pathKey(path);
		if (!this.own.has(key)) this.modified.add(key);
	}
}
