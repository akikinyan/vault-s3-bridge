// Local-only: fetches test images through the plugin's PreviewService against real AWS.
// Reads local/dev.json ({ profile, region, bucket, previewPrefix }). Never used in CI.
// The bucket must contain, under previewPrefix: png-blue.png, 日本語 フォルダ/画像 (1).jpg,
// 記号/a!b'c*d#e?f%g.gif, webp-1x1.webp, vector.svg and not-image.txt.
//   npm run smoke:preview
import { readFileSync } from 'node:fs';
import { PreviewError } from '../src/preview/errors';
import { createPreviewStack } from '../src/preview/stack';
import { formatReference } from '../src/reference/reference';
import { emptyDeviceState, setProfile } from '../src/settings/device';
import { recordConnection, recordsOf } from '../src/settings/registry';
import { DEFAULT_SETTINGS, type PluginSettings, type StorageConnection } from '../src/settings/types';

interface DevConfig {
	profile: string;
	region: string;
	bucket: string;
	previewPrefix: string;
}

const dev = JSON.parse(readFileSync('local/dev.json', 'utf8')) as DevConfig;
const connection: StorageConnection = { id: 'smoke', alias: 'work', provider: 'aws-s3', classification: 'private', bucket: dev.bucket, region: dev.region, keyTemplate: 'smoke/{filename}.{ext}' };
const settings: PluginSettings = { ...structuredClone(DEFAULT_SETTINGS), connections: [connection], ...recordConnection(recordsOf(DEFAULT_SETTINGS), connection) };
const device = emptyDeviceState();
setProfile(device, connection.id, dev.profile);
const { service, handler } = createPreviewStack(
	() => settings,
	() => device,
);

const p = dev.previewPrefix;
const cases: [string, string, string][] = [
	['work', `${p}png-blue.png`, 'ok'],
	['work', `${p}日本語 フォルダ/画像 (1).jpg`, 'ok'],
	['work', `${p}記号/a!b'c*d#e?f%g.gif`, 'ok'],
	['work', `${p}webp-1x1.webp`, 'ok'],
	['work', `${p}vector.svg`, 'unsupported-svg'],
	['work', `${p}not-image.txt`, 'unsupported-format'],
	['work', `${p}does-not-exist.png`, 'not-found'],
	['nosuch', `${p}png-blue.png`, 'unknown-alias'],
];

let failures = 0;
const started = Date.now();
const leases = cases.map(([alias, key]) => service.acquire(formatReference(alias, key)));
for (const [i, [, key, expected]] of cases.entries()) {
	let outcome: string;
	try {
		const shown = await leases[i]!.result;
		if ('kind' in shown) outcome = shown.kind;
		else outcome = `${shown.url.startsWith('blob:') ? 'ok' : 'no-blob'} ${shown.width}x${shown.height}`;
	} catch (error) {
		outcome = error instanceof PreviewError ? error.code : 'unexpected-error';
	}
	const pass = outcome.split(' ')[0] === expected;
	if (!pass) failures++;
	process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${key.slice(p.length).padEnd(30)} ${outcome}\n`);
}
process.stdout.write(`stats: ${JSON.stringify(service.stats())}  elapsed: ${Date.now() - started} ms\n`);
leases.forEach((l) => l.release());
service.destroy();
handler.destroy();
process.exitCode = failures > 0 ? 1 : 0;
