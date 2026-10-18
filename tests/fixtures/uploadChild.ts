// Child process for the 7-3 kill tests in uploadKill.test.ts: a real PendingStore and SettingsStore on Node's fs,
// and a bucket kept as files in a directory, so objects and records survive the kill.
//   node --import tsx tests/fixtures/uploadChild.ts <dir> send <point> <one|two|alt>   (SIGKILLs itself at <point>)
// two: two source files with different prepared keys and the same bytes; alt: k/a.png already holds other content.
//   node --import tsx tests/fixtures/uploadChild.ts <dir> resume                    (prints the outcome as JSON)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveConnectionOp } from '../../src/settings/ops';
import { SettingsStore, type StoreIO } from '../../src/settings/store';
import type { StorageConnection } from '../../src/settings/types';
import { resumableGroups } from '../../src/upload/job';
import { nodePendingIO, type PendingIO, PendingStore } from '../../src/upload/pending';
import { resumeGroup, sendGroup, type UploaderDeps } from '../../src/upload/uploader';
import { newItem, OWN } from './pendingItems';

const [dir, mode, point, count] = process.argv.slice(2) as [string, 'send' | 'resume', string | undefined, 'one' | 'two' | 'alt' | undefined];
const kill = (): never => {
	process.kill(process.pid, 'SIGKILL');
	throw new Error('unreachable');
};
const at = (p: string) => mode === 'send' && point === p;

export const BODY = new TextEncoder().encode('example image bytes');
const SENT = createHash('sha256').update(BODY).digest('hex');
const SOURCE = 'c'.repeat(64);
const CONNECTION: StorageConnection = { id: 'c1', alias: 'work', provider: 'aws-s3', classification: 'private', bucket: 'example-private', region: 'ap-northeast-1', keyTemplate: 'k/{filename}.{ext}' };

// --- settings on disk -------------------------------------------------------------
const dataPath = join(dir, 'data.json');
const devicePath = join(dir, 'device.json');
const storeIO: StoreIO = {
	loadData: () => Promise.resolve(existsSync(dataPath) ? (JSON.parse(readFileSync(dataPath, 'utf8')) as unknown) : null),
	saveData: (data) => {
		if (at('before-history') && Array.isArray(data.history) && data.history.length > 0) kill();
		writeFileSync(dataPath, JSON.stringify(data));
		return Promise.resolve();
	},
	device: {
		load: (key) => (existsSync(devicePath) ? (JSON.parse(readFileSync(devicePath, 'utf8')) as Record<string, unknown>)[key] : undefined),
		save: (key, value) => writeFileSync(devicePath, JSON.stringify({ [key]: value })),
	},
	sleep: () => Promise.resolve(),
};

// --- records on disk --------------------------------------------------------------
const real = nodePendingIO(dir);
let writes = 0;
const pendingIO: PendingIO = {
	...real,
	async writeAtomic(name, text) {
		await real.writeAtomic(name, text);
		writes++;
		if (at('after-record') && writes === 1) kill();
		const states = (JSON.parse(text) as { items: { state: string }[] }).items.map((i) => i.state);
		if (at('before-apply') && states.length > 0 && states.every((s) => s === 'delivered')) kill();
		if (at('after-alt') && text.includes('"altKey"')) kill();
	},
};

// --- a bucket that keeps its objects in files ---------------------------------------
const bucket = join(dir, 's3');
mkdirSync(bucket, { recursive: true });
const objectPath = (key: string) => join(bucket, encodeURIComponent(key));
if (mode === 'send' && count === 'alt') writeFileSync(objectPath('k/a.png'), 'other content');
const sdkError = (status: number, name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
const client = {
	send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
		const key = command.input.Key as string;
		if (command.constructor.name === 'HeadObjectCommand') {
			if (!existsSync(objectPath(key))) return Promise.reject(sdkError(404, 'NotFound'));
			return Promise.resolve({ ChecksumSHA256: readFileSync(objectPath(key), 'utf8'), ChecksumType: 'FULL_OBJECT' });
		}
		if (at('put-lost')) kill();
		if (existsSync(objectPath(key))) return Promise.reject(sdkError(412, 'PreconditionFailed'));
		writeFileSync(objectPath(key), command.input.ChecksumSHA256 as string);
		if (at('put-arrived')) kill();
		return Promise.resolve({});
	},
};

const settings = new SettingsStore(storeIO);
await settings.reload();
if (settings.current.connections.length === 0) await settings.mutate(saveConnectionOp(undefined, CONNECTION, 'p'));
const pending = new PendingStore(pendingIO, OWN, () => new Date('2026-10-17T00:00:00Z'));
await pending.load();

let ids = 0;
const deps: UploaderDeps = {
	pending,
	settings,
	client: client as never,
	signal: new AbortController().signal,
	timeoutMs: 15_000,
	check: () => undefined,
	sourceUnchanged: () => Promise.resolve(true),
	sourceChanged: () => false,
	rebuild: () => Promise.resolve(BODY),
	sleep: () => Promise.resolve(),
	random: () => 0.5,
	now: () => new Date('2026-10-17T00:00:00Z'),
	newId: () => `h-${mode}-${++ids}`,
};

if (mode === 'send') {
	const common = { target: 'aws:example-private', sourceSha256: SOURCE, sentSha256: SENT, key: 'k/a.png', preparedKey: 'k/a.png', groupId: 'g' };
	const items = count === 'two' ? [newItem('a', common), newItem('b', { ...common, sourcePath: 'assets/b.png', sourceSha256: 'd'.repeat(64), preparedKey: 'k/b.png' })] : [newItem('a', common)];
	await sendGroup(items, BODY, deps);
	process.stdout.write('finished\n');
} else {
	const groups = resumableGroups(pending.items);
	const results = [];
	for (const g of groups) results.push(...(await resumeGroup(g, deps)));
	process.stdout.write(
		JSON.stringify({
			resumed: groups,
			results,
			items: pending.items.map((i) => ({ id: i.id, state: i.state, uncertain: i.uncertain, occurrences: i.occurrences.length, altKey: i.altKey })),
			objects: readdirSync(bucket).map(decodeURIComponent),
			history: settings.current.history.map((h) => ({ key: h.key, sourceSha256: h.sourceSha256 })),
			privateFiles: settings.current.privateFiles,
		}),
	);
}
