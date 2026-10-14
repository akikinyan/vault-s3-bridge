// Local-only pre-publish check: finds real environment values in tracked or staged files.
// Values come from local/dev.json and ~/.aws/config, so this check cannot run in CI.
// Output never prints the matched value itself.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Placeholder values that may appear in public files.
const ALLOWED = new Set(['123456789012', 'AKIAIOSFODNN7EXAMPLE']);

const values = new Set();
if (existsSync('local/dev.json')) {
	const dev = JSON.parse(readFileSync('local/dev.json', 'utf8'));
	for (const key of ['profile', 'bucket', 'proxyUrl']) if (dev[key]) values.add(String(dev[key]));
}
const configPath = join(homedir(), '.aws', 'config');
if (existsSync(configPath)) {
	const config = readFileSync(configPath, 'utf8');
	for (const m of config.matchAll(/^\[(?:profile|sso-session)\s+([^\]]+)\]/gm)) values.add(m[1].trim());
	for (const m of config.matchAll(/^\s*sso_start_url\s*=\s*(\S+)/gm)) values.add(m[1]);
	for (const m of config.matchAll(/\b\d{12}\b/g)) values.add(m[0]);
}
const literal = [...values].filter((v) => v.length >= 4 && !ALLOWED.has(v));

const files = execFileSync('git', ['ls-files', '--cached'], { encoding: 'utf8' })
	.split('\n')
	.filter((f) => f && f !== 'package-lock.json' && existsSync(f));

const generic = [
	[/\b\d{12}\b/g, '12-digit number'],
	[/arn:aws[a-z-]*:[^\s'"`]*/g, 'ARN'],
];
let hits = 0;
for (const file of files) {
	const text = readFileSync(file, 'utf8');
	text.split('\n').forEach((line, i) => {
		literal.forEach((value, n) => {
			if (line.toLowerCase().includes(value.toLowerCase())) {
				console.error(`${file}:${i + 1}: local value #${n + 1}`);
				hits++;
			}
		});
		for (const [pattern, label] of generic) {
			for (const m of line.matchAll(pattern)) {
				const allowed = [...ALLOWED].some((a) => m[0].includes(a)) || /:\*{4}:|<[a-z-]+>/.test(m[0]) || m[0] === 'arn:aws:';
				if (!allowed) {
					console.error(`${file}:${i + 1}: unapproved ${label}`);
					hits++;
				}
			}
		}
	});
}
if (hits > 0) {
	console.error(`check-local-values: ${hits} finding(s)`);
	process.exit(1);
}
console.log(`check-local-values: OK (${files.length} files, ${literal.length} local values)`);
