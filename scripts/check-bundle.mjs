// Fails when the plugin bundle contains code that must never ship.
import { readFileSync } from 'node:fs';

const bundle = readFileSync('main.js', 'utf8');
const meta = JSON.parse(readFileSync('.esbuild-meta.json', 'utf8'));

// Only this file may spawn a process: `/usr/sbin/scutil --proxy` for the system proxy on macOS.
// Any other importer, a dependency above all (credential_process), fails the check.
const PROCESS_ALLOWED = new Set(['src/aws/systemProxy.ts']);
const importers = Object.entries(meta.inputs)
	.filter(([, input]) => input.imports.some((i) => i.path === 'child_process' || i.path === 'node:child_process'))
	.map(([file]) => file);
const unexpected = importers.filter((file) => !PROCESS_ALLOWED.has(file));
for (const file of unexpected) console.error(`${file} imports child_process (only ${[...PROCESS_ALLOWED].join(', ')} may)`);

const forbidden = [
	...(unexpected.length > 0 || importers.length === 0 ? [['child_process', 'process spawning (default credential chain)']] : []),
	['credential-provider-process', 'credential_process provider'],
	['credential-provider-env', 'environment variable credentials'],
	['AWS_SECRET_ACCESS_KEY', 'environment variable credentials'],
];
const hits = forbidden.filter(([needle]) => bundle.includes(needle));
for (const [needle, reason] of hits) console.error(`main.js contains "${needle}" (${reason})`);
if (unexpected.length > 0 || hits.length > 0) process.exit(1);
console.log(`check-bundle: OK (${Math.round(bundle.length / 1024)} KB)`);
