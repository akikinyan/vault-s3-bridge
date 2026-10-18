// Local-only: runs the upload's S3 requests and the uploader against a real bucket, then deletes what it wrote.
// Reads local/dev.json ({ profile, region, bucket, uploadPrefix? }). Never used in CI.
// Writes a few small objects under <uploadPrefix><run id>/ (default prefix: .vault-s3-bridge/smoke-upload/).
//   npm run smoke:upload
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { classifyError } from '../src/aws/errors';
import { connectionTarget } from '../src/settings/registry';
import { saveConnectionOp } from '../src/settings/ops';
import { SettingsStore, type StoreIO } from '../src/settings/store';
import { DEFAULT_REQUEST_TIMEOUT_MS, type StorageConnection } from '../src/settings/types';
import { jobClients } from '../src/upload/clients';
import { type NewPendingItem, nodePendingIO, PendingStore } from '../src/upload/pending';
import { classifyS3Outcome, compareHead, headCommand, putCommand } from '../src/upload/s3';
import { sendGroup, type UploaderDeps } from '../src/upload/uploader';
import { redactText } from '../src/util/redact';

interface DevConfig {
	profile: string;
	region: string;
	bucket: string;
	uploadPrefix?: string;
}

const dev = JSON.parse(readFileSync('local/dev.json', 'utf8')) as DevConfig;
const replacements = [
	[dev.bucket, '<bucket>'],
	[dev.profile, '<profile>'],
] as const;
const prefix = `${dev.uploadPrefix ?? '.vault-s3-bridge/smoke-upload/'}${randomUUID()}/`;
const connection: StorageConnection = { id: 'smoke', alias: 'smoke', provider: 'aws-s3', classification: 'private', bucket: dev.bucket, region: dev.region, keyTemplate: 'smoke/{filename}.{ext}' };

let failures = 0;
const report = (pass: boolean, name: string, detail = '') => {
	if (!pass) failures++;
	process.stdout.write(redactText(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${detail}`.trimEnd(), { replacements }) + '\n');
};
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const imageBytes = () => new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2048)]));
const errorOf = async (p: Promise<unknown>) => {
	try {
		await p;
		return undefined;
	} catch (error) {
		return error;
	}
};

// Settings in memory; records in a temporary directory. Nothing is written to the vault or local/.
const memory: { data: unknown; device: Record<string, unknown> } = { data: null, device: {} };
const storeIO: StoreIO = {
	loadData: () => Promise.resolve(structuredClone(memory.data)),
	saveData: (data) => {
		memory.data = structuredClone(data);
		return Promise.resolve();
	},
	device: { load: (k) => memory.device[k], save: (k, v) => void (memory.device[k] = structuredClone(v)) },
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
const store = new SettingsStore(storeIO);
await store.reload();
await store.mutate(saveConnectionOp(undefined, connection, dev.profile));
const recordsDir = mkdtempSync(join(tmpdir(), 'vsb-smoke-upload-'));
const pending = new PendingStore(nodePendingIO(recordsDir), randomUUID());
await pending.load();

const clients = jobClients(store, connection.id);
const signal = new AbortController().signal;
const created = new Set<string>();
let s3: S3Client | undefined;
try {
	s3 = await clients.client(signal);
	const client = s3;
	const bucket = connection.bucket;
	const head = (key: string) => client.send(headCommand(bucket, key), { abortSignal: signal });

	// a-c: conditional Put with the SHA-256 checksum, read back, and a second Put refused.
	const body = imageBytes();
	const sent = sha256(body);
	const keyA = `${prefix}direct.png`;
	created.add(keyA);
	const putA = await errorOf(client.send(putCommand(bucket, keyA, body, sent, 'png'), { abortSignal: signal }));
	report(putA === undefined, 'a  conditional Put to a new key', putA ? classifyS3Outcome('put', putA, false).code : '');
	const h = await head(keyA);
	report(compareHead(h, sent) === 'match', 'b  Head returns the same full-object SHA-256', `type=${h.ChecksumType}`);
	report(h.ContentType === 'image/png' && h.ContentLength === body.byteLength, 'b  Content-Type and length as sent');
	report(h.ChecksumCRC32 === undefined && h.ChecksumCRC64NVME === undefined, 'b  no checksum added by the SDK');
	const again = await errorOf(client.send(putCommand(bucket, keyA, imageBytes(), sent, 'png'), { abortSignal: signal }));
	const againOutcome = again ? classifyS3Outcome('put', again, false).outcome : 'succeeded';
	const h2 = await head(keyA);
	report(againOutcome === 'precondition' && h2.ETag === h.ETag, 'c  second Put to the same key is refused', againOutcome);

	// d: a wrong checksum is rejected by S3 and nothing is stored.
	const keyD = `${prefix}bad-digest.png`;
	created.add(keyD);
	const bad = await errorOf(client.send(putCommand(bucket, keyD, imageBytes(), sent, 'png'), { abortSignal: signal }));
	const badOutcome = bad ? classifyS3Outcome('put', bad, false).outcome : 'succeeded';
	const afterBad = await errorOf(head(keyD));
	const afterBadOutcome = afterBad ? classifyS3Outcome('head', afterBad, false).outcome : 'exists';
	report(badOutcome === 'digest', 'd  Put with a wrong checksum is rejected', badOutcome);
	report(afterBadOutcome === 'absent' || afterBadOutcome === 'head-forbidden', 'd  nothing stored after the rejection', afterBadOutcome);

	// e: a key never written.
	const missing = await errorOf(head(`${prefix}never-written.png`));
	const missingOutcome = missing ? classifyS3Outcome('head', missing, false).outcome : 'exists';
	report(missingOutcome === 'absent' || missingOutcome === 'head-forbidden', 'e  Head of a missing key', missingOutcome === 'head-forbidden' ? 'head-forbidden (no s3:ListBucket)' : missingOutcome);

	// f-h: the uploader itself, with the records and settings above.
	let ids = 0;
	const deps = (bytes: Uint8Array): UploaderDeps => ({
		pending,
		settings: store,
		client,
		signal,
		timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
		check: () => undefined,
		sourceUnchanged: () => Promise.resolve(true),
		rebuild: () => Promise.resolve(bytes),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		random: Math.random,
		now: () => new Date(),
		newId: () => `smoke-${++ids}`,
	});
	const item = (id: string, bytes: Uint8Array, key: string, over: Partial<NewPendingItem> = {}): NewPendingItem => ({
		id,
		jobId: 'smoke',
		groupId: id,
		connectionId: connection.id,
		target: connectionTarget(connection),
		classification: 'private',
		notePath: 'smoke.md',
		sourcePath: `${id}.png`,
		sourceSha256: sha256(bytes),
		sentSha256: sha256(bytes),
		size: bytes.byteLength,
		format: 'png',
		converter: 'c1;orig',
		key,
		preparedKey: key,
		phase: 'prepared',
		occurrences: [{ original: `![[${id}.png]]`, alt: id, inTable: false }],
		apply: 'replace',
		...over,
	});

	const bodyF = imageBytes();
	const keyF = `${prefix}uploader.png`;
	created.add(keyF);
	const [f] = await sendGroup([item('f', bodyF, keyF)], bodyF, deps(bodyF));
	const recorded = store.current.history.some((e) => e.key === keyF) && store.current.privateFiles.includes(sha256(bodyF));
	report(f?.outcome === 'delivered' && f.key === keyF && recorded, 'f  new upload delivered and recorded', f?.outcome ?? '');
	const hF = await head(keyF);

	const keyG = `${prefix}uploader-unused.png`;
	created.add(keyG);
	const [g] = await sendGroup([item('g', bodyF, keyF, { preparedKey: keyG, phase: 'candidate' })], bodyF, deps(bodyF));
	const unused = await errorOf(head(keyG));
	const hF2 = await head(keyF);
	report(g?.outcome === 'delivered' && g.key === keyF && hF2.ETag === hF.ETag && unused !== undefined, 'g  same bytes reuse the existing object', g?.outcome ?? '');

	const bodyH = imageBytes();
	const [hItem] = await sendGroup([item('h', bodyH, keyF)], bodyH, deps(bodyH));
	if (hItem?.key) created.add(hItem.key);
	const hH = hItem?.key ? await head(hItem.key) : undefined;
	report(hItem?.outcome === 'delivered' && hItem.key !== keyF && hH !== undefined && compareHead(hH, sha256(bodyH)) === 'match', 'h  different bytes at a used key go to an alternate key', hItem?.key?.slice(prefix.length) ?? hItem?.outcome ?? '');
	report(pending.items.every((i) => i.state === 'delivered'), 'f-h  records left for the note to be updated', `${pending.items.length} delivered`);
} catch (error) {
	report(false, 'unexpected error', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
} finally {
	// Cleanup: delete the exact version of every key this run may have written, then confirm it is gone.
	const left: string[] = [];
	const unverified: string[] = [];
	if (s3) {
		const client = s3;
		const timeout = () => ({ abortSignal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS) });
		const headOutcome = async (key: string) => {
			try {
				return { exists: true as const, versionId: (await client.send(headCommand(connection.bucket, key), timeout())).VersionId };
			} catch (error) {
				return { exists: false as const, outcome: classifyS3Outcome('head', error, false).outcome };
			}
		};
		for (const key of created) {
			const name = key.slice(prefix.length);
			const before = await headOutcome(key);
			if (before.exists) {
				const del = await errorOf(client.send(new DeleteObjectCommand({ Bucket: connection.bucket, Key: key, VersionId: before.versionId }), timeout()));
				if (del) {
					left.push(`${name} (delete: ${classifyError(del).code})`);
					continue;
				}
			}
			const after = await headOutcome(key);
			if (after.exists) left.push(name);
			else if (after.outcome !== 'absent') unverified.push(`${name} (${after.outcome})`);
		}
	}
	report(left.length === 0, 'cleanup: every object written by this run is deleted', left.length ? `left under ${prefix}: ${left.join(', ')}` : `${created.size} keys checked`);
	if (unverified.length) process.stdout.write(redactText(`WARN  absence not confirmed (no s3:ListBucket?): ${unverified.join(', ')}`, { replacements }) + '\n');
	clients.destroy();
	rmSync(recordsDir, { recursive: true, force: true });
}
process.exitCode = failures > 0 ? 1 : 0;
