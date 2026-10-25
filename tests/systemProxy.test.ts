import { describe, expect, it } from 'vitest';
import { parseScutilProxy, readSystemProxy } from '../src/aws/systemProxy';

const plist = (...lines: string[]) => ['<dictionary> {', ...lines.map((l) => `  ${l}`), '}', ''].join('\n');

describe('parseScutilProxy', () => {
	it('reads an enabled HTTPS proxy with its exceptions', () => {
		const text = plist(
			'ExceptionsList : <array> {',
			'  0 : *.local',
			'  1 : 169.254/16',
			'  2 : internal.example',
			'}',
			'FTPPassive : 1',
			'HTTPEnable : 1',
			'HTTPPort : 3128',
			'HTTPProxy : http-only.example.com',
			'HTTPSEnable : 1',
			'HTTPSPort : 8080',
			'HTTPSProxy : proxy.example.com',
		);
		expect(parseScutilProxy(text)).toEqual({
			kind: 'proxy',
			url: 'http://proxy.example.com:8080',
			exceptions: ['*.local', '169.254/16', 'internal.example'],
			excludeSimpleHostnames: false,
		});
	});

	it('connects directly when no HTTPS proxy is enabled', () => {
		expect(parseScutilProxy(plist('ExceptionsList : <array> {', '  0 : *.local', '}', 'FTPPassive : 1'))).toEqual({ kind: 'direct', reason: 'not-enabled' });
		expect(parseScutilProxy(plist('HTTPSEnable : 0', 'HTTPSPort : 8080', 'HTTPSProxy : proxy.example.com'))).toEqual({ kind: 'direct', reason: 'not-enabled' });
		expect(parseScutilProxy(plist('HTTPEnable : 1', 'HTTPPort : 8080', 'HTTPProxy : proxy.example.com'))).toEqual({ kind: 'direct', reason: 'not-enabled' });
		expect(parseScutilProxy(plist('HTTPSEnable : 1', 'HTTPSPort : 8080'))).toEqual({ kind: 'direct', reason: 'not-enabled' });
		expect(parseScutilProxy('')).toEqual({ kind: 'direct', reason: 'not-enabled' });
	});

	it('does not support automatic configuration (PAC or auto discovery), even with a manual proxy as well', () => {
		const manual = ['HTTPSEnable : 1', 'HTTPSPort : 8080', 'HTTPSProxy : proxy.example.com'];
		expect(parseScutilProxy(plist('ProxyAutoConfigEnable : 1', 'ProxyAutoConfigURLString : http://wpad.example.com/proxy.pac', ...manual))).toEqual({
			kind: 'direct',
			reason: 'auto-config',
		});
		expect(parseScutilProxy(plist('ProxyAutoDiscoveryEnable : 1', ...manual))).toEqual({ kind: 'direct', reason: 'auto-config' });
		expect(parseScutilProxy(plist('ProxyAutoConfigEnable : 0', ...manual))).toMatchObject({ kind: 'proxy' });
	});

	it('reads only the top-level keys, not the per-interface dictionaries', () => {
		const text = plist(
			'ExceptionsList : <array> {',
			'  0 : *.local',
			'}',
			'__SCOPED__ : <dictionary> {',
			'  en0 : <dictionary> {',
			'    HTTPSEnable : 1',
			'    HTTPSPort : 8080',
			'    HTTPSProxy : scoped.example.com',
			'    ProxyAutoConfigEnable : 1',
			'  }',
			'}',
			'HTTPSEnable : 0',
		);
		expect(parseScutilProxy(text)).toEqual({ kind: 'direct', reason: 'not-enabled' });
		const enabled = text.replace('HTTPSEnable : 0', 'HTTPSEnable : 1\n  HTTPSProxy : proxy.example.com\n  HTTPSPort : 8443');
		expect(parseScutilProxy(enabled)).toEqual({ kind: 'proxy', url: 'http://proxy.example.com:8443', exceptions: ['*.local'], excludeSimpleHostnames: false });
	});

	it('handles a missing port, an IPv6 address and simple host names', () => {
		expect(parseScutilProxy(plist('HTTPSEnable : 1', 'HTTPSProxy : proxy.example.com'))).toMatchObject({ url: 'http://proxy.example.com' });
		expect(parseScutilProxy(plist('HTTPSEnable : 1', 'HTTPSProxy : 2001:db8::1', 'HTTPSPort : 8080'))).toMatchObject({ url: 'http://[2001:db8::1]:8080' });
		expect(parseScutilProxy(plist('ExcludeSimpleHostnames : 1', 'HTTPSEnable : 1', 'HTTPSProxy : proxy.example.com', 'HTTPSPort : 8080'))).toMatchObject({
			excludeSimpleHostnames: true,
			exceptions: [],
		});
	});
});

describe('readSystemProxy', () => {
	const text = plist('HTTPSEnable : 1', 'HTTPSPort : 8080', 'HTTPSProxy : proxy.example.com');

	it('reads scutil on macOS only', async () => {
		let runs = 0;
		const run = () => {
			runs++;
			return Promise.resolve(text);
		};
		expect(await readSystemProxy('darwin', run)).toMatchObject({ kind: 'proxy', url: 'http://proxy.example.com:8080' });
		expect(await readSystemProxy('win32', run)).toEqual({ kind: 'direct', reason: 'unsupported-platform' });
		expect(await readSystemProxy('linux', run)).toEqual({ kind: 'direct', reason: 'unsupported-platform' });
		expect(runs).toBe(1);
	});

	it('connects directly when scutil fails', async () => {
		expect(await readSystemProxy('darwin', () => Promise.reject(new Error('ENOENT')))).toEqual({ kind: 'direct', reason: 'unavailable' });
	});
});
