// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { type CommandRegistry, guardLinkCommands, guardWindowOpen, isLinkOpeningCommand, isS3Reference, LinkGuard, s3LinkAt } from '../src/preview/linkGuard';
import { installObsidianDomHelpers } from './fixtures/obsidianDom';

beforeAll(installObsidianDomHelpers);

describe('isS3Reference', () => {
	it('any case, surrounding spaces; nothing else', () => {
		expect([' S3-Bridge://work/a.pdf', 's3-bridge://w/k', 'https://example.com', 'S3://x', '', null, undefined].map(isS3Reference)).toEqual([true, true, false, false, false, false, false]);
	});
});

describe('s3LinkAt (design 7-5): only the link itself', () => {
	const line = 'before [資料](s3-bridge://work/k/a.pdf) mid ![x](s3-bridge://work/k/b.png) <S3-BRIDGE://work/c> [web](https://example.com) end';
	const at = (s: string) => line.indexOf(s);

	it('inside a link or an autolink; an embed is not a link', () => {
		expect(s3LinkAt(line, at('[資料]'))).toBe('s3-bridge://work/k/a.pdf');
		expect(s3LinkAt(line, at('資料'))).toBe('s3-bridge://work/k/a.pdf');
		expect(s3LinkAt(line, at('k/a.pdf'))).toBe('s3-bridge://work/k/a.pdf');
		expect(s3LinkAt(line, at('![x]'))).toBeUndefined();
		expect(s3LinkAt(line, at('[x]'))).toBeUndefined();
		expect(s3LinkAt(line, at('work/c>'))).toBe('S3-BRIDGE://work/c');
	});

	it('elsewhere on the line, and on other links, nothing', () => {
		expect(s3LinkAt(line, 0)).toBeUndefined();
		expect(s3LinkAt(line, at(' mid'))).toBeUndefined();
		expect(s3LinkAt(line, at('[web]'))).toBeUndefined();
		expect(s3LinkAt(line, line.length)).toBeUndefined();
		expect(s3LinkAt(line, at(') mid'))).toBe('s3-bridge://work/k/a.pdf');
		expect(s3LinkAt(line, at(') mid') + 1)).toBeUndefined();
	});

	it('angle brackets, a title, nested brackets in the text, a link around an embed', () => {
		expect(s3LinkAt('[![i](a.png)](s3-bridge://w/k)', 0)).toBe('s3-bridge://w/k');
		expect(s3LinkAt('[a](<s3-bridge://w/k a.pdf>)', 1)).toBe('s3-bridge://w/k a.pdf');
		expect(s3LinkAt('[a](s3-bridge://w/k "t")', 1)).toBe('s3-bridge://w/k');
		expect(s3LinkAt('[a [b]](s3-bridge://w/k)', 4)).toBe('s3-bridge://w/k');
	});
});

describe('isLinkOpeningCommand (layer 2)', () => {
	it('follow-link and open-link commands, with or without a prefix', () => {
		expect(['editor:follow-link', 'editor:open-link-in-new-leaf', 'editor:open-link-in-new-window', 'editor:open-link-in-new-split', 'follow-link'].every(isLinkOpeningCommand)).toBe(true);
		expect(['editor:toggle-bold', 'app:open-settings', 'file-explorer:open', 'editor:unfollow-linkx'].map(isLinkOpeningCommand)).toEqual([false, false, false, false]);
		// No end anchor: any variant of opening a link counts. It only matters on an s3-bridge link (the safe side).
		expect(isLinkOpeningCommand('editor:open-link-in-some-new-place')).toBe(true);
	});
});

describe('guardLinkCommands (layer 2)', () => {
	it('runs other commands, and link commands away from an s3-bridge link; opens the preview on one', () => {
		const ran: string[] = [];
		const opened: string[] = [];
		const registry: CommandRegistry = {
			executeCommandById: (id) => (ran.push(id), true),
			executeCommand: (c) => (ran.push(`cmd:${c.id}`), true),
		};
		let cursor: string | undefined = 's3-bridge://w/k';
		const restore = guardLinkCommands(registry, () => cursor, (u) => opened.push(u))!;
		registry.executeCommandById!('editor:follow-link');
		registry.executeCommand!({ id: 'editor:open-link-in-new-leaf' });
		registry.executeCommandById!('editor:toggle-bold');
		cursor = undefined;
		registry.executeCommandById!('editor:follow-link');
		expect(opened).toEqual(['s3-bridge://w/k', 's3-bridge://w/k']);
		expect(ran).toEqual(['editor:toggle-bold', 'editor:follow-link']);
		restore();
		cursor = 's3-bridge://w/k';
		registry.executeCommandById!('editor:follow-link');
		expect(ran.at(-1)).toBe('editor:follow-link');
	});

	it('nothing to wrap: undefined, so layer 3 alone holds', () => {
		expect(guardLinkCommands(undefined, () => undefined, () => undefined)).toBeUndefined();
		expect(guardLinkCommands({}, () => undefined, () => undefined)).toBeUndefined();
	});
});

describe('guardWindowOpen (layer 3)', () => {
	it('refuses s3-bridge URLs only; restores only its own wrapper', () => {
		const calls: unknown[][] = [];
		const win = { open: (...args: unknown[]) => (calls.push(args), 'opened' as never) } as Pick<Window, 'open'>;
		const original = win.open;
		const restore = guardWindowOpen(win);
		expect(win.open(' s3-bridge://w/k')).toBeNull();
		expect(win.open('https://example.com', '_blank')).toBe('opened');
		expect(win.open()).toBe('opened');
		expect(calls).toEqual([['https://example.com', '_blank'], []]);
		restore();
		expect(win.open).toBe(original);
		const again = guardWindowOpen(win);
		const someoneElse = () => null;
		win.open = someoneElse;
		again();
		expect(win.open).toBe(someoneElse);
	});
});

describe('LinkGuard layer 1 (reading view links)', () => {
	const setup = () => {
		const opened: string[] = [];
		const guard = new LinkGuard({ openPreview: (u) => opened.push(u) });
		guard.install(window);
		const a = document.createElement('a');
		a.setAttribute('href', 's3-bridge://work/k/a.pdf');
		const span = a.appendChild(document.createElement('span'));
		span.textContent = '資料';
		const web = document.createElement('a');
		web.setAttribute('href', 'https://example.com');
		document.body.append(a, web);
		const reached: string[] = [];
		document.body.addEventListener('click', (e) => reached.push((e.target as Element).tagName));
		document.body.addEventListener('contextmenu', () => reached.push('menu'));
		return { opened, guard, a, span, web, reached };
	};

	it('a click on the link (or inside it) opens the preview and goes no further', () => {
		const t = setup();
		const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
		t.span.dispatchEvent(e);
		expect(e.defaultPrevented).toBe(true);
		expect(t.opened).toEqual(['s3-bridge://work/k/a.pdf']);
		expect(t.reached).toEqual([]);
		t.guard.dispose();
	});

	it('right click, middle click, drag: stopped, nothing opened; other links untouched', () => {
		const t = setup();
		for (const [type, button] of [['contextmenu', 2], ['auxclick', 1], ['mousedown', 1], ['dragstart', 0]] as const) {
			const e = new MouseEvent(type, { bubbles: true, cancelable: true, button });
			t.a.dispatchEvent(e);
			expect(e.defaultPrevented, type).toBe(true);
		}
		expect(t.opened).toEqual([]);
		const plain = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
		t.a.dispatchEvent(plain);
		expect(plain.defaultPrevented).toBe(false);
		const web = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
		t.web.dispatchEvent(web);
		expect(web.defaultPrevented).toBe(false);
		expect(t.reached).toEqual(['A']);
		t.guard.dispose();
	});

	it('Enter on a focused link opens the preview; once uninstalled nothing is stopped', () => {
		const t = setup();
		const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		t.a.dispatchEvent(enter);
		expect(enter.defaultPrevented).toBe(true);
		expect(t.opened).toEqual(['s3-bridge://work/k/a.pdf']);
		expect(t.guard.install(window)).toBe(false);
		t.guard.dispose();
		const after = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
		t.a.dispatchEvent(after);
		expect(after.defaultPrevented).toBe(false);
	});
});
