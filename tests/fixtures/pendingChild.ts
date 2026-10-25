// Child process for the kill tests in pending.test.ts. Runs a real PendingStore on Node's fs and
// SIGKILLs itself at a fixed point: node --import tsx tests/fixtures/pendingChild.ts <dir> <point> <ownId> [otherId]
// A point starting with `v1-` adds one item to a version 1 file the test wrote, and kills during that first write.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nodePendingIO, type PendingIO, PendingStore, pendingFileName } from '../../src/upload/pending';
import { newItem } from './pendingItems';

const [dir, point, ownId, otherId] = process.argv.slice(2) as [string, string, string, string | undefined];
const kill = (): never => {
	process.kill(process.pid, 'SIGKILL');
	throw new Error('unreachable');
};

const real = nodePendingIO(dir);
const migrating = point.startsWith('v1-');
const at = migrating ? point.slice(3) : point;
// The write that is cut: the second add, or the first write of a version 1 file (its migration).
const cut = migrating ? 1 : 2;
let writes = 0;
const io: PendingIO = {
	...real,
	async writeAtomic(name, text) {
		writes++;
		if (writes === cut && at === 'before-write') kill();
		if (writes === cut && at === 'tmp-left') {
			// What a kill between writing the temporary file and the rename leaves behind.
			await writeFile(join(dir, `${name}.tmp-deadbeef0000`), text.slice(0, text.length >> 1));
			kill();
		}
		await real.writeAtomic(name, text);
		if (writes === cut && at === 'after-write') kill();
	},
	async unlink(name) {
		if (point === 'takeover-before-cleanup') kill();
		await real.unlink(name);
	},
};

const store = new PendingStore(io, ownId);
await store.load();
if (point === 'takeover-before-cleanup') {
	await store.takeOver(otherId!);
} else if (migrating) {
	await store.add([newItem('b')]);
} else {
	await store.add([newItem('a')]);
	await store.add([newItem('b')]);
}
process.stdout.write(`finished ${pendingFileName(ownId)}\n`);
