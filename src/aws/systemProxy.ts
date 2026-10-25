// The operating system's HTTPS proxy, read from `scutil --proxy` on macOS. Kept free of Obsidian so it runs from Node.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Why the system settings lead to a direct connection. */
export type SystemProxyDirectReason = 'not-enabled' | 'auto-config' | 'unsupported-platform' | 'unavailable';

export type SystemProxy =
	| {
			kind: 'proxy';
			url: string;
			/** Hosts contacted directly (`ExceptionsList`), in the NO_PROXY form read by matchesNoProxy. */
			exceptions: string[];
			/** `ExcludeSimpleHostnames`: host names without a dot are contacted directly. */
			excludeSimpleHostnames: boolean;
	  }
	| { kind: 'direct'; reason: SystemProxyDirectReason };

type Value = string | Value[] | { [key: string]: Value };

/**
 * Parses the property list printed by scutil. Nested dictionaries (such as `__SCOPED__`, one per network
 * interface) are kept as values, so only the top-level keys describe the proxy in use.
 */
function parsePlist(text: string): Record<string, Value> {
	const lines = text.split(/\r?\n/);
	let i = 0;
	const block = (): Record<string, Value> => {
		const out: Record<string, Value> = {};
		while (i < lines.length) {
			const line = (lines[i++] ?? '').trim();
			if (line === '}') return out;
			const m = /^(\S+)\s*:\s*(.*)$/.exec(line);
			if (!m) continue;
			const key = m[1] ?? '';
			const value = m[2] ?? '';
			if (value === '<dictionary> {') out[key] = block();
			else if (value === '<array> {') out[key] = Object.values(block());
			else out[key] = value;
		}
		return out;
	};
	const first = lines.findIndex((l) => l.trim() === '<dictionary> {');
	if (first < 0) return {};
	i = first + 1;
	return block();
}

/** Reads the HTTPS proxy from `scutil --proxy`. Automatic configuration (PAC, WPAD) is not supported. */
export function parseScutilProxy(text: string): SystemProxy {
	const d = parsePlist(text);
	const on = (key: string) => d[key] === '1';
	if (on('ProxyAutoConfigEnable') || on('ProxyAutoDiscoveryEnable')) return { kind: 'direct', reason: 'auto-config' };
	const host = typeof d.HTTPSProxy === 'string' ? d.HTTPSProxy.trim() : '';
	if (!on('HTTPSEnable') || host === '') return { kind: 'direct', reason: 'not-enabled' };
	const port = typeof d.HTTPSPort === 'string' && /^\d+$/.test(d.HTTPSPort) ? Number(d.HTTPSPort) : undefined;
	const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
	const exceptions = Array.isArray(d.ExceptionsList) ? d.ExceptionsList.filter((e): e is string => typeof e === 'string' && e.trim() !== '') : [];
	return {
		kind: 'proxy',
		// The proxy itself is reached over plain HTTP; HTTPS goes through it with CONNECT.
		url: `http://${bracketed}${port ? `:${port}` : ''}`,
		// Address ranges such as 169.254/16 never match a host name; AWS endpoints are always names.
		exceptions: exceptions.map((e) => e.trim()),
		excludeSimpleHostnames: on('ExcludeSimpleHostnames'),
	};
}

export type RunScutil = () => Promise<string>;

const SCUTIL_TIMEOUT_MS = 3_000;

export const runScutil: RunScutil = async () => (await promisify(execFile)('/usr/sbin/scutil', ['--proxy'], { timeout: SCUTIL_TIMEOUT_MS, encoding: 'utf8' })).stdout;

/** The system proxy of this device. Only macOS is supported; elsewhere the connection is direct. */
export async function readSystemProxy(platform: NodeJS.Platform = process.platform, run: RunScutil = runScutil): Promise<SystemProxy> {
	if (platform !== 'darwin') return { kind: 'direct', reason: 'unsupported-platform' };
	try {
		return parseScutilProxy(await run());
	} catch {
		return { kind: 'direct', reason: 'unavailable' };
	}
}
