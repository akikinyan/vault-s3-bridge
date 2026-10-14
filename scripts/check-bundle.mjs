// Fails when the plugin bundle contains code that must never ship.
import { readFileSync } from 'node:fs';

const bundle = readFileSync('main.js', 'utf8');
const forbidden = [
	['child_process', 'process spawning (default credential chain)'],
	['credential-provider-process', 'credential_process provider'],
	['credential-provider-env', 'environment variable credentials'],
	['AWS_SECRET_ACCESS_KEY', 'environment variable credentials'],
];
const hits = forbidden.filter(([needle]) => bundle.includes(needle));
for (const [needle, reason] of hits) console.error(`main.js contains "${needle}" (${reason})`);
if (hits.length > 0) process.exit(1);
console.log(`check-bundle: OK (${Math.round(bundle.length / 1024)} KB)`);
