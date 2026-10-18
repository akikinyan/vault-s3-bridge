import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { parseReference } from '../src/reference/reference';
import { validatePublicBaseUrl } from '../src/settings/validate';
import { type EmbedSyntax, parseEmbeds, parseEmbedSyntax } from '../src/upload/detect';
import {
	applyToNote,
	buildMarkdown,
	type EditorLike,
	lfOffset,
	type NoteAccess,
	publicUrl,
	type Replacement,
	replaceRanges,
	type Target,
	verifyMarkdown,
} from '../src/upload/rewrite';

const PUB: Target = { classification: 'public', publicBaseUrl: 'https://cdn.example.com/files/' };
const PRIV: Target = { classification: 'private', alias: 'demo' };
const KEY = 'attachments/2026/10/0123456789abcdef.png';
const syntax = (original: string, inTable = false): EmbedSyntax => {
	const r = parseEmbedSyntax(original, inTable);
	if (!r.ok) throw new Error(r.reason);
	return r.value;
};
const md = (original: string, target: Target, inTable = false) => buildMarkdown({ syntax: syntax(original, inTable), target, key: KEY, fileBase: 'a', inTable });
const URL_ = `https://cdn.example.com/files/${KEY}`;
const REF = `s3-bridge://demo/${KEY}`;

describe('buildMarkdown (9-3)', () => {
	it.each([
		['![[a.png]]', `![](${URL_})`, `![a](${REF})`],
		['![[a.png|300]]', `![|300](${URL_})`, `![a|300](${REF})`],
		['![[a.png|図の説明]]', `![図の説明](${URL_})`, `![図の説明](${REF})`],
		['![図](a.png)', `![図](${URL_})`, `![図](${REF})`],
		['![図|300x200](a.png)', `![図|300x200](${URL_})`, `![図|300x200](${REF})`],
	])('%s', (original, pub, priv) => {
		expect(md(original, PUB)).toBe(pub);
		expect(md(original, PRIV)).toBe(priv);
	});

	it('escapes the generated | inside a table', () => {
		expect(md('![[a.png\\|300]]', PRIV, true)).toBe(`![a\\|300](${REF})`);
		expect(md('![[a.png\\|300]]', PUB, true)).toBe(`![\\|300](${URL_})`);
	});

	it('cleans what the user wrote and the private default with safeAltText; a public image without alt stays empty', () => {
		expect(md('![[a.png|a]b`c<d>]]', PRIV)).toBe(`![abcd](${REF})`);
		expect(buildMarkdown({ syntax: syntax('![[a.png]]'), target: PRIV, key: KEY, fileBase: '画像 [1]', inTable: false })).toBe(`![画像 1](${REF})`);
		expect(md('![](a.png)', PUB)).toBe(`![](${URL_})`);
		expect(md('![](a.png)', PRIV)).toBe(`![a](${REF})`);
	});

	it('produces Markdown that reads back as one embed with the same key', () => {
		for (const original of ['![[a.png]]', '![[a.png|300]]', '![図|300x200](a.png)']) {
			expect(verifyMarkdown(md(original, PUB), PUB, KEY)).toBe(true);
			expect(verifyMarkdown(md(original, PRIV), PRIV, KEY)).toBe(true);
		}
		const odd = 'attachments/日報_10月/画像 (1)!.png';
		expect(verifyMarkdown(buildMarkdown({ syntax: syntax('![[a.png]]'), target: PRIV, key: odd, fileBase: 'a', inTable: false }), PRIV, odd)).toBe(true);
		expect(verifyMarkdown(buildMarkdown({ syntax: syntax('![[a.png]]'), target: PUB, key: odd, fileBase: 'a', inTable: false }), PUB, odd)).toBe(true);
		expect(verifyMarkdown(`![](${URL_})`, PUB, 'other.png')).toBe(false);
		expect(verifyMarkdown(`![](${REF}) and more`, PRIV, KEY)).toBe(false);
		expect(verifyMarkdown(`text ![a](${REF})`, PRIV, KEY)).toBe(false);
	});
});

describe('public URLs', () => {
	it('joins the base and the encoded key exactly once', () => {
		expect(publicUrl('https://cdn.example.com', 'a/b c.png')).toBe('https://cdn.example.com/a/b%20c.png');
		expect(publicUrl('https://cdn.example.com/x//', 'a/(1).png')).toBe('https://cdn.example.com/x/a/%281%29.png');
		expect(() => publicUrl('http://cdn.example.com', 'a.png')).toThrow();
	});

	it.each([
		['https://cdn.example.com', undefined],
		['https://cdn.example.com/files/', undefined],
		['https://cdn.example.com/a%20b/', undefined],
		['http://cdn.example.com', 'public-url-invalid'],
		['https://user:pw@cdn.example.com', 'public-url-invalid'],
		['https://cdn.example.com/?a=1', 'public-url-invalid'],
		['https://cdn.example.com/#x', 'public-url-invalid'],
		['https://cdn.example.com/日本', 'public-url-invalid'],
		['https://cdn.example.com/a b', 'public-url-invalid'],
		['not a url', 'public-url-invalid'],
	])('%s → %s', (value, expected) => {
		expect(validatePublicBaseUrl(value)).toBe(expected);
	});
});

describe('replaceRanges (9-1)', () => {
	it('replaces from the end and keeps everything else', () => {
		const s = 'a ![[x.png]] b ![[y.png]] c';
		expect(replaceRanges(s, [{ offset: 2, length: 10, text: 'X' }, { offset: 15, length: 10, text: 'YY' }])).toBe('a X b YY c');
		expect(() => replaceRanges(s, [{ offset: 2, length: 10, text: 'X' }, { offset: 5, length: 3, text: 'Z' }])).toThrow();
	});

	it('maps CRLF offsets to the editor’s LF offsets', () => {
		const s = 'a\r\nb\r\n![[x]]';
		expect(lfOffset(s, s.indexOf('!'))).toBe('a\nb\n![[x]]'.indexOf('!'));
	});
});

/** An editor that applies all changes of one transaction against the document as it was before it. */
class FakeEditor implements EditorLike {
	transactions = 0;
	constructor(public value: string) {}
	getValue(): string {
		return this.value;
	}
	offsetToPos(offset: number) {
		const before = this.value.slice(0, offset).split('\n');
		return { line: before.length - 1, ch: before[before.length - 1]!.length };
	}
	posToOffset(pos: { line: number; ch: number }): number {
		const lines = this.value.split('\n');
		return lines.slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.ch;
	}
	transaction(tx: { changes: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[] }): void {
		this.transactions++;
		const ranges = tx.changes.map((c) => ({ from: this.posToOffset(c.from), to: this.posToOffset(c.to), text: c.text })).sort((a, b) => b.from - a.from);
		for (const r of ranges) this.value = this.value.slice(0, r.from) + r.text + this.value.slice(r.to);
	}
}

function noteWith(disk: string | undefined, editors: FakeEditor[], wasOpenAtStart = editors.length > 0): NoteAccess & { disk: string | undefined } {
	const n = {
		disk,
		openEditors: () => editors,
		wasOpenAtStart,
		exists: () => n.disk !== undefined,
		process: (fn: (d: string) => string) => {
			const next = fn(n.disk!);
			n.disk = next;
			return Promise.resolve(next);
		},
		read: () => Promise.resolve(n.disk!),
	};
	return n;
}

describe('applyToNote (9-2)', () => {
	const snapshot = 'one ![[a.png]] two ![[b.png]]\r\n| x | ![[c.png\\|9]] |\r\n';
	const reps: Replacement[] = [
		{ offset: 4, length: 10, text: '![A](s3-bridge://demo/a.png)' },
		{ offset: 19, length: 10, text: '![B](s3-bridge://demo/b.png)' },
		{ offset: snapshot.indexOf('![[c'), length: '![[c.png\\|9]]'.length, text: '![C\\|9](s3-bridge://demo/c.png)' },
	];
	const expected = 'one ![A](s3-bridge://demo/a.png) two ![B](s3-bridge://demo/b.png)\r\n| x | ![C\\|9](s3-bridge://demo/c.png) |\r\n';
	const lf = (s: string) => s.replace(/\r\n/g, '\n');

	it('open note: one transaction with all changes, on the LF text, then verified', async () => {
		const editor = new FakeEditor(lf(snapshot));
		const r = await applyToNote(noteWith(snapshot, [editor]), snapshot, reps);
		expect(r).toEqual({ applied: true, via: 'editor', verified: true });
		expect(editor.transactions).toBe(1);
		expect(editor.value).toBe(lf(expected));
	});

	it('open note with other text in the editor: nothing replaced', async () => {
		const editor = new FakeEditor(`${lf(snapshot)}typed`);
		expect(await applyToNote(noteWith(snapshot, [editor]), snapshot, reps)).toEqual({ applied: false, reason: 'changed' });
		expect(editor.transactions).toBe(0);
	});

	it('closed note: vault.process writes only over the exact snapshot', async () => {
		const n = noteWith(snapshot, [], false);
		expect(await applyToNote(n, snapshot, reps)).toEqual({ applied: true, via: 'file', verified: true });
		expect(n.disk).toBe(expected);
		const changed = noteWith(`${snapshot}x`, [], false);
		expect(await applyToNote(changed, snapshot, reps)).toEqual({ applied: false, reason: 'changed' });
		expect(changed.disk).toBe(`${snapshot}x`);
	});

	it('a write no longer allowed at the moment of writing changes nothing', async () => {
		const editor = new FakeEditor(lf(snapshot));
		expect(await applyToNote(noteWith(snapshot, [editor]), snapshot, reps, () => false)).toEqual({ applied: false, reason: 'blocked' });
		expect(editor.transactions).toBe(0);
		const n = noteWith(snapshot, [], false);
		expect(await applyToNote(n, snapshot, reps, () => false)).toEqual({ applied: false, reason: 'blocked' });
		expect(n.disk).toBe(snapshot);
	});

	it('open at the start and closed now, or deleted: copy instead', async () => {
		expect(await applyToNote(noteWith(snapshot, [], true), snapshot, reps)).toEqual({ applied: false, reason: 'closed' });
		expect(await applyToNote(noteWith(undefined, [], false), snapshot, reps)).toEqual({ applied: false, reason: 'deleted' });
	});
});

describe('end to end on a measured note', () => {
	it.each([
		['LF', (t: string) => t],
		['CRLF', (t: string) => t.replace(/\n/g, '\r\n')],
	])('%s: replaces the targets only, keeps comments and non-targets, and escapes | in the table', (_, convert) => {
		const text = convert(readFileSync(new URL('./fixtures/notes/embeds.md', import.meta.url), 'utf8'));
		const found = parseEmbeds(text);
		if (!found.ok) throw new Error('unparsable');
		const reps: Replacement[] = [];
		for (const e of found.embeds) {
			if (e.inComment) continue;
			const s = parseEmbedSyntax(e.original, e.inTable);
			if (!s.ok) continue;
			reps.push({ offset: e.offset, length: e.original.length, text: buildMarkdown({ syntax: s.value, target: PRIV, key: `k/${e.offset}.png`, fileBase: 'f', inTable: e.inTable }) });
		}
		const next = replaceRanges(text, reps);
		// Outside the replaced ranges nothing changes: cut both texts at the ranges and compare the pieces.
		const sorted = [...reps].sort((a, b) => a.offset - b.offset);
		const outside: string[] = [];
		let from = 0;
		for (const r of sorted) {
			outside.push(text.slice(from, r.offset));
			from = r.offset + r.length;
		}
		outside.push(text.slice(from));
		let at = 0;
		outside.forEach((piece, i) => {
			expect(next.startsWith(piece, at)).toBe(true);
			at += piece.length + (i < sorted.length ? sorted[i]!.text.length : 0);
		});
		expect(at).toBe(next.length);
		expect(next).toMatch(/\| !\[f\\\|100\]\(s3-bridge:\/\/demo\/k\/\d+\.png\) \| !\[t\]\(s3-bridge:\/\/demo\/k\/\d+\.png\) \|/);
		expect(next).toContain('%% ![[percent-comment-ignored.png]] %%');
		// References are not embeds for the cache (measured), so only the embeds left alone remain.
		const again = parseEmbeds(next);
		if (!again.ok) throw new Error('unparsable');
		expect(again.embeds).toHaveLength(found.embeds.length - reps.length);
		expect(next.match(/\]\(s3-bridge:\/\/demo\//g)).toHaveLength(reps.length);
	});
});

describe('generated Markdown rendered by a Markdown parser', () => {
	const parser = new MarkdownIt();
	const images = (markdown: string) =>
		[...parser.render(markdown).matchAll(/<img src="([^"]*)" alt="([^"]*)"/g)].map((m) => ({ src: m[1]!.replace(/&amp;/g, '&'), alt: m[2]! }));
	const TARGETS: readonly Target[] = [PUB, PRIV];
	const keys = ['attachments/2026/10/0123456789abcdef.png', 'notes/日本語 フォルダ/画像 (1).png', "a(b)c/[x]/y z!'*.png"];

	it.each(keys)('%s: one image whose URL or reference reads back as the key, in text and in a table', (key) => {
		for (const [original, inTable] of [
			['![[a.png]]', false],
			['![[a.png|300]]', false],
			['![図](a.png)', false],
			['![[a.png\\|300]]', true],
		] as const) {
			for (const target of TARGETS) {
				const out = buildMarkdown({ syntax: syntax(original, inTable), target, key, fileBase: 'a', inTable });
				const found = images(inTable ? `| x |\n|---|\n| ${out} |\n` : out);
				expect(found, out).toHaveLength(1);
				const src = found[0]!.src;
				if (target === PUB) {
					expect(src.startsWith('https://cdn.example.com/files/')).toBe(true);
					expect(decodeURIComponent(src.slice('https://cdn.example.com/files/'.length))).toBe(key);
					expect(found[0]!.alt).not.toBe('image');
				} else {
					expect(parseReference(src)).toEqual({ ok: true, value: { alias: 'demo', key } });
				}
			}
		}
	});
});
