// Small files that must survive a process kill: write a temporary file, fsync it, then rename it over
// the target. The rename either happens completely or not at all; a crash leaves the previous file.
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';

export async function writeFileAtomic(path: string, data: string): Promise<void> {
	const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
	const handle = await open(tmp, 'w');
	try {
		await handle.writeFile(data, 'utf8');
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await unlink(tmp).catch(() => undefined);
		throw error;
	}
	await handle.close();
	try {
		await rename(tmp, path);
	} catch (error) {
		await unlink(tmp).catch(() => undefined);
		throw error;
	}
}

/** Parsed JSON, or undefined when the file is missing or not valid JSON. */
export async function readJsonFile(path: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}
