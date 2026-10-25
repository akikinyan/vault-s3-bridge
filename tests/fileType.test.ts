import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyContent, classifyFile, extensionOf, type FileKind, OCTET_STREAM, publicUseOf, TEXT_CONTENT_TYPE, ZIP_MAX_ENTRIES } from '../src/upload/fileType';

const DIR = join(__dirname, 'fixtures', 'files');
const read = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));
const text = (s: string) => new TextEncoder().encode(s);

/** Expected kind per fixture (design 2-2). Names: t- text, a-/b- active, p- pdf, z- zip/office, v- audio/video, i- image, m- misc. */
const EXPECT: Record<string, FileKind> = {
	'a-img.svg': 'svg',
	'p-ok.pdf': 'pdf',
	'p-pdf-html-polyglot.pdf': 'pdf',
	'p-html-pdf-polyglot.pdf': 'active',
	'p-svg-as-pdf.pdf': 'active',
	'z-docx.docx': 'office',
	'z-xlsx.xlsx': 'office',
	'z-pptx.pptx': 'office',
	'z-docx-as-zip.zip': 'office',
	'z-plain.zip': 'zip',
	'z-comment.zip': 'zip',
	'v-mp4.mp4': 'video',
	'v-webm.webm': 'video',
	'v-m4a.m4a': 'audio',
	'v-mp3-id3.mp3': 'audio',
	'v-mp3-sync.mp3': 'audio',
	'v-wav.wav': 'audio',
	'v-ogg.ogg': 'audio',
	'v-flac.flac': 'audio',
	'i-png.png': 'image',
	'm-empty.txt': 'text',
	'm-svgz.svgz': 'active',
};
const expected = (name: string): FileKind => EXPECT[name] ?? (name.startsWith('t-') ? 'text' : name.startsWith('a-') || name.startsWith('b-') ? 'active' : 'ambiguous');

describe('classifyFile', () => {
	const names = readdirSync(DIR).sort();

	it('has the Step 1 fixtures', () => {
		expect(names.length).toBe(70);
	});

	it.each(names)('%s', (name) => {
		const v = classifyFile(read(name), extensionOf(name));
		expect(v.kind, v.reasons.join(' ')).toBe(expected(name));
	});

	it('never lets active or ambiguous files be public, and puts them as octet-stream', () => {
		for (const name of names) {
			const v = classifyFile(read(name), extensionOf(name));
			if (v.kind === 'active' || v.kind === 'ambiguous') {
				expect(v.publicUse).toBe('reject');
				expect(v.contentType).toBe(OCTET_STREAM);
			}
		}
	});

	it('gives the fixed Content-Types (design 2-3)', () => {
		const ct = (name: string) => classifyFile(read(name), extensionOf(name)).contentType;
		expect(ct('t-json.json')).toBe(TEXT_CONTENT_TYPE);
		expect(ct('t-csv.csv')).toBe(TEXT_CONTENT_TYPE);
		expect(ct('p-ok.pdf')).toBe('application/pdf');
		expect(ct('a-img.svg')).toBe('image/svg+xml');
		expect(ct('z-docx.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
		expect(ct('z-xlsx.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
		expect(ct('z-docx-as-zip.zip')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
		expect(ct('z-plain.zip')).toBe('application/zip');
		expect(ct('v-mp3-id3.mp3')).toBe('audio/mpeg');
		expect(ct('v-mp4.mp4')).toBe('video/mp4');
		expect(ct('v-webm.webm')).toBe('video/webm');
	});

	it('uses the extension for audio versus video and the exact type', () => {
		const ftyp = read('v-mp4.mp4');
		expect(classifyFile(ftyp, 'mov')).toMatchObject({ kind: 'video', contentType: 'video/quicktime' });
		expect(classifyFile(ftyp, 'm4a')).toMatchObject({ kind: 'audio', contentType: 'audio/mp4' });
		expect(classifyFile(read('v-ogg.ogg'), 'ogv')).toMatchObject({ kind: 'video', contentType: 'video/ogg' });
	});

	it('decides the open points of Step 1 (design 2-2)', () => {
		// 1: text after a preamble stays text. 2: unknown tags at the start are active.
		expect(classifyFile(read('t-long-preamble-html.txt'), 'txt').kind).toBe('text');
		expect(classifyFile(read('b-unknown-tag-as-txt.txt'), 'txt').kind).toBe('active');
		// 3: a .json that does not parse is text. 4: no extension is ambiguous.
		expect(classifyFile(read('t-json-shaped-js.json'), 'json')).toMatchObject({ kind: 'text', publicUse: 'allow' });
		expect(classifyFile(read('m-no-ext'), '').kind).toBe('ambiguous');
		// 5: MPEG frame sync alone only with the mp3 extension, and never over a UTF-16 BOM.
		expect(classifyFile(read('v-mp3-sync.mp3'), 'txt').kind).toBe('ambiguous');
		expect(classifyFile(new Uint8Array([0xff, 0xfe, 0x68, 0x00]), 'mp3').kind).toBe('ambiguous');
	});

	it('treats an SVG document in another extension as active, and other markup in .svg as active', () => {
		expect(classifyFile(read('a-img.svg'), 'txt').kind).toBe('active');
		expect(classifyFile(text('<html></html>'), 'svg').kind).toBe('active');
		expect(classifyFile(text('<?xml version="1.0"?><!-- c --><svg xmlns="x"/>'), 'svg').kind).toBe('svg');
	});

	it('refuses Office content under the wrong Office extension', () => {
		expect(classifyFile(read('z-docx.docx'), 'xlsx').kind).toBe('ambiguous');
	});

	it('treats a central directory over the limit as ambiguous', () => {
		// Empty archive whose end record claims too many entries.
		const b = new Uint8Array(22);
		b.set([0x50, 0x4b, 0x05, 0x06]);
		new DataView(b.buffer).setUint16(10, ZIP_MAX_ENTRIES + 1, true);
		expect(classifyFile(b, 'zip').kind).toBe('ambiguous');
	});
});

describe('publicUseOf', () => {
	it('follows the table of design 2-3', () => {
		expect(publicUseOf('png')).toBe('image');
		expect(publicUseOf('text')).toBe('allow');
		for (const f of ['pdf', 'docx', 'xlsx', 'pptx', 'zip', 'audio', 'video'] as const) expect(publicUseOf(f)).toBe('confirm');
		for (const f of ['svg', 'active', 'other'] as const) expect(publicUseOf(f)).toBe('reject');
	});

	it('agrees with classifyFile for every fixture', () => {
		for (const name of readdirSync(DIR)) {
			const v = classifyFile(read(name), extensionOf(name));
			expect(publicUseOf(v.format), name).toBe(v.publicUse);
		}
	});
});

describe('extensionOf', () => {
	it('lowercases and ignores a leading dot', () => {
		expect(extensionOf('a/B.PDF')).toBe('pdf');
		expect(extensionOf('.hidden')).toBe('');
		expect(extensionOf('dir.d/README')).toBe('');
		expect(extensionOf('x.tar.gz')).toBe('gz');
	});
});

describe('classifyContent', () => {
	it('decides the preview kind from the bytes only (design 2-5)', () => {
		expect(classifyContent(read('p-ok.pdf'))).toBe('pdf');
		expect(classifyContent(read('a-img.svg'))).toBe('svg');
		expect(classifyContent(read('b-svg-doctype-as-txt.txt'))).toBe('svg');
		expect(classifyContent(read('m-no-ext'))).toBe('text');
		expect(classifyContent(read('i-png.png'))).toBe('image');
		expect(classifyContent(read('b-html-as-txt.txt'))).toBe('other');
		expect(classifyContent(read('p-pdf-zip-polyglot.pdf'))).toBe('other');
		expect(classifyContent(read('m-utf16le-bom.txt'))).toBe('other');
		expect(classifyContent(read('z-docx.docx'))).toBe('other');
	});
});
