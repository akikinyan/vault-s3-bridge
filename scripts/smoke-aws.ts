// Local-only: runs the plugin's connection diagnostics from Node against real AWS.
// Reads local/dev.json ({ profile, region, bucket, proxyUrl?, noProxy? }). Never used in CI.
//   npm run smoke:aws [-- --write] [--bucket <name>] [--proxy <url>] [--no-proxy <list>] [--verbose]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runConnectionTest } from '../src/diagnostics/connectionTest';
import { DEFAULT_REQUEST_TIMEOUT_MS, type StorageConnection } from '../src/settings/types';
import { redactText, sanitizeForLog } from '../src/util/redact';

interface DevConfig {
	profile: string;
	region: string;
	bucket: string;
	proxyUrl?: string;
	noProxy?: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

const dev = JSON.parse(readFileSync('local/dev.json', 'utf8')) as DevConfig;
const bucket = option('--bucket') ?? dev.bucket;
const replacements = [
	[dev.bucket, '<bucket>'],
	[bucket, '<bucket>'],
	[dev.profile, '<profile>'],
] as const;

const connection: StorageConnection = {
	id: 'smoke',
	alias: 'smoke',
	provider: 'aws-s3',
	classification: 'private',
	bucket,
	region: dev.region,
	keyTemplate: 'smoke/{filename}.{ext}',
};

const report = await runConnectionTest(connection, {
	profile: dev.profile,
	network: {
		proxyUrl: option('--proxy') ?? dev.proxyUrl,
		noProxy: option('--no-proxy') ?? dev.noProxy,
		timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
	},
	writeTest: flag('--write'),
});

const lines = report.items.map((item) => {
	const data = Object.entries(item.data ?? {})
		.map(([k, v]) => `${k}=${v}`)
		.join(' ');
	return `${item.status.padEnd(10)} ${item.id.padEnd(18)} ${item.code ?? ''} ${data}`.trimEnd();
});
if (report.ssoLoginCommand) lines.push('sso-login: aws sso login --profile <profile>');
process.stdout.write(redactText(lines.join('\n'), { replacements }) + '\n');

if (flag('--verbose')) {
	mkdirSync('local/logs', { recursive: true });
	const file = `local/logs/smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
	writeFileSync(file, JSON.stringify(sanitizeForLog(report, { replacements }), null, 2));
	process.stdout.write(`log: ${file}\n`);
}
process.exitCode = report.items.some((i) => i.status === 'fail') ? 1 : 0;
