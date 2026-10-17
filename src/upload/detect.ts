// Finds image embeds in a note independently of Obsidian's metadataCache (design 8-2), so the cache can be
// checked against the current text (8-3). Block structure is classified first (front matter, fences, indented
// code, math blocks, HTML blocks, tables), then the remaining text is scanned once from left to right for
// inline code, inline math, %% comments, HTML comments, escapes and embeds. Anything it cannot decide is a
// problem: the caller aborts instead of guessing.

export interface FoundEmbed {
	/** UTF-16 offset in the note as stored (CRLF kept). */
	offset: number;
	original: string;
	/** Inside %% … %%: part of the comparison with the cache, never a target. */
	inComment: boolean;
	/** In a GFM table row (any container), where a generated `|` must be escaped. */
	inTable: boolean;
}

export type ParseProblem = 'lone-cr' | 'unclosed-percent' | 'unclosed-html-comment' | 'comment-spans-block';
export type ParsedNote = { ok: true; embeds: FoundEmbed[] } | { ok: false; problem: ParseProblem; offset: number };

interface Line {
	start: number;
	/** Without the line break. */
	text: string;
	kind: 'frontmatter' | 'fence' | 'indented-code' | 'math' | 'html' | 'normal';
	inTable: boolean;
}

const QUOTE = /^(?: {0,3}> ?)*/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?: +|$)/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const HTML_BLOCK_6 =
	/^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i;
const HTML_BLOCK_1 = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i;
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const isBlank = (s: string) => s.trim() === '';
const indentOf = (s: string) => {
	let n = 0;
	for (const ch of s) {
		if (ch === ' ') n++;
		else if (ch === '\t') n += 4 - (n % 4);
		else break;
	}
	return n;
};
const cellCount = (row: string) => {
	const t = row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
	return t.split(/(?<!\\)\|/).length;
};

function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	for (const raw of text.split('\n')) {
		const t = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		lines.push({ start, text: t, kind: 'normal', inTable: false });
		start += raw.length + 1;
	}
	return lines;
}

/** Marks every line with its block kind and table membership. */
function classify(lines: Line[]): void {
	let i = 0;
	// Front matter: only when it starts the note and is closed.
	if (lines[0]?.text === '---') {
		const end = lines.findIndex((l, n) => n > 0 && (l.text === '---' || l.text === '...'));
		if (end > 0) {
			for (let n = 0; n <= end; n++) lines[n]!.kind = 'frontmatter';
			i = end + 1;
		}
	}
	let fence: { ch: string; len: number } | undefined;
	let math = false;
	let html: { until: 'blank' | RegExp } | undefined;
	let inList = false;
	let prevBlank = true;
	let inIndentedCode = false;
	for (; i < lines.length; i++) {
		const line = lines[i]!;
		const content = line.text.slice(QUOTE.exec(line.text)?.[0].length ?? 0);
		if (fence) {
			line.kind = 'fence';
			const m = FENCE.exec(content.trimStart());
			if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && isBlank(m[2]!)) fence = undefined;
			continue;
		}
		if (math) {
			line.kind = 'math';
			if (content.includes('$$')) math = false;
			continue;
		}
		if (html) {
			if (html.until === 'blank') {
				if (isBlank(content)) {
					html = undefined;
				} else {
					line.kind = 'html';
					continue;
				}
			} else {
				line.kind = 'html';
				if (html.until.test(content)) html = undefined;
				continue;
			}
		}
		const blank = isBlank(content);
		const indent = indentOf(content);
		if (blank) {
			prevBlank = true;
			if (inIndentedCode) line.kind = 'indented-code';
			continue;
		}
		if (inIndentedCode && indent >= 4) {
			line.kind = 'indented-code';
			prevBlank = false;
			continue;
		}
		inIndentedCode = false;
		if (LIST_ITEM.test(content)) inList = true;
		else if (indent < 2 && prevBlank) inList = false;
		if (indent >= 4 && prevBlank && !inList) {
			line.kind = 'indented-code';
			inIndentedCode = true;
			prevBlank = false;
			continue;
		}
		const body = content.trimStart().replace(LIST_ITEM, '').trimStart();
		const f = FENCE.exec(body);
		if (f && (indent < 4 || inList) && !(f[1]![0] === '`' && f[2]!.includes('`'))) {
			fence = { ch: f[1]![0]!, len: f[1]!.length };
			line.kind = 'fence';
			prevBlank = false;
			continue;
		}
		if (indent < 4 && body.startsWith('$$')) {
			line.kind = 'math';
			// One line `$$ … $$` closes itself.
			math = !(body.length > 4 && body.slice(2).includes('$$'));
			prevBlank = false;
			continue;
		}
		const h1 = HTML_BLOCK_1.exec(content);
		if (h1) {
			line.kind = 'html';
			const close = new RegExp(`</${h1[1]!}>`, 'i');
			if (!close.test(content)) html = { until: close };
			prevBlank = false;
			continue;
		}
		if (HTML_BLOCK_6.test(content)) {
			line.kind = 'html';
			html = { until: 'blank' };
			prevBlank = false;
			continue;
		}
		prevBlank = false;
	}
	markTables(lines);
}

/** GFM tables: a header row and a delimiter row with the same cell count, then rows up to a blank line. */
function markTables(lines: Line[]): void {
	const quoteDepth = (t: string) => (QUOTE.exec(t)?.[0].match(/>/g) ?? []).length;
	const content = (t: string) => t.slice(QUOTE.exec(t)?.[0].length ?? 0);
	for (let i = 0; i + 1 < lines.length; i++) {
		const head = lines[i]!;
		const delim = lines[i + 1]!;
		if (head.kind !== 'normal' || delim.kind !== 'normal' || head.inTable) continue;
		const h = content(head.text);
		const d = content(delim.text);
		if (!h.includes('|') || !DELIMITER_ROW.test(d) || !d.includes('-') || indentOf(h) >= 4) continue;
		if (quoteDepth(head.text) !== quoteDepth(delim.text) || cellCount(h) !== cellCount(d)) continue;
		const depth = quoteDepth(head.text);
		let n = i;
		while (n < lines.length) {
			const l = lines[n]!;
			if (l.kind !== 'normal' || quoteDepth(l.text) !== depth || isBlank(content(l.text))) break;
			l.inTable = true;
			n++;
		}
		i = n - 1;
	}
}

const PUNCT = /[!-/:-@[-`{-~]/;

/** One left-to-right pass over the text of normal lines. */
export function parseEmbeds(text: string): ParsedNote {
	const lone = text.search(/\r(?!\n)/);
	if (lone >= 0) return { ok: false, problem: 'lone-cr', offset: lone };
	const lines = splitLines(text);
	classify(lines);

	// Per character: the line it belongs to, and whether that line is normal text.
	const lineAt = new Int32Array(text.length + 1);
	for (let n = 0; n < lines.length; n++) {
		const l = lines[n]!;
		lineAt.fill(n, l.start, Math.min(text.length + 1, l.start + l.text.length + 2));
	}
	const normal = (p: number) => lines[lineAt[p]!]!.kind === 'normal';
	/** End of the paragraph-like run that contains p: the next blank or non-normal line. */
	const runEnd = (p: number) => {
		let n = lineAt[p]!;
		while (n + 1 < lines.length && lines[n + 1]!.kind === 'normal' && !isBlank(lines[n + 1]!.text)) n++;
		const l = lines[n]!;
		return l.start + l.text.length;
	};
	/** Comments may span lines, but not across blocks the parser masks. */
	const spansBlock = (from: number, to: number) => {
		for (let n = lineAt[from]!; n <= lineAt[to]!; n++) if (lines[n]!.kind !== 'normal') return true;
		return false;
	};

	const embeds: FoundEmbed[] = [];
	let inComment = false;
	let commentStart = 0;
	let p = 0;
	while (p < text.length) {
		if (!normal(p)) {
			// Skip to the start of the next line (a CRLF line ends one character later than its text).
			p = lines[lineAt[p]! + 1]?.start ?? text.length;
			continue;
		}
		const ch = text[p]!;
		if (inComment) {
			if (text.startsWith('%%', p)) {
				if (spansBlock(commentStart, p)) return { ok: false, problem: 'comment-spans-block', offset: commentStart };
				inComment = false;
				p += 2;
				continue;
			}
		} else {
			if (ch === '\\' && PUNCT.test(text[p + 1] ?? '')) {
				p += 2;
				continue;
			}
			if (ch === '`') {
				let n = 1;
				while (text[p + n] === '`') n++;
				const run = '`'.repeat(n);
				const end = runEnd(p);
				let q = text.indexOf(run, p + n);
				while (q >= 0 && q < end && text[q + n] === '`') {
					let k = q;
					while (text[k] === '`') k++;
					q = text.indexOf(run, k);
				}
				p = q >= 0 && q < end ? q + n : p + n;
				continue;
			}
			if (ch === '$' && text[p + 1] !== '$' && !/\s/.test(text[p + 1] ?? ' ')) {
				const end = runEnd(p);
				let q = p + 1;
				let close = -1;
				while (q < end) {
					if (text[q] === '\\') {
						q += 2;
						continue;
					}
					if (text[q] === '$' && !/\s/.test(text[q - 1]!) && !/\d/.test(text[q + 1] ?? '')) {
						close = q;
						break;
					}
					q++;
				}
				p = close >= 0 ? close + 1 : p + 1;
				continue;
			}
			if (text.startsWith('<!--', p)) {
				const q = text.indexOf('-->', p + 4);
				if (q < 0) return { ok: false, problem: 'unclosed-html-comment', offset: p };
				if (spansBlock(p, q)) return { ok: false, problem: 'comment-spans-block', offset: p };
				p = q + 3;
				continue;
			}
			if (text.startsWith('%%', p)) {
				inComment = true;
				commentStart = p;
				p += 2;
				continue;
			}
		}
		if (text.startsWith('![[', p)) {
			const end = text.indexOf(']]', p + 3);
			const nl = text.indexOf('\n', p);
			if (end > p + 3 && (nl < 0 || end < nl)) {
				embeds.push({ offset: p, original: text.slice(p, end + 2), inComment, inTable: lines[lineAt[p]!]!.inTable });
				p = end + 2;
				continue;
			}
		} else if (text.startsWith('![', p)) {
			const len = markdownImageLength(text, p);
			if (len > 0) {
				embeds.push({ offset: p, original: text.slice(p, p + len), inComment, inTable: lines[lineAt[p]!]!.inTable });
				p += len;
				continue;
			}
		}
		p++;
	}
	if (inComment) return { ok: false, problem: 'unclosed-percent', offset: commentStart };
	return { ok: true, embeds };
}

/** Length of `![alt](dest "title")` at p on one line, or 0. */
function markdownImageLength(text: string, p: number): number {
	let q = p + 2;
	let depth = 1;
	while (q < text.length && depth > 0) {
		const c = text[q]!;
		if (c === '\n') return 0;
		if (c === '\\') q++;
		else if (c === '[') depth++;
		else if (c === ']') depth--;
		q++;
	}
	if (depth !== 0 || text[q] !== '(') return 0;
	q++;
	if (text[q] === '<') {
		const close = text.indexOf('>', q);
		const nl = text.indexOf('\n', q);
		if (close < 0 || (nl >= 0 && nl < close)) return 0;
		q = close + 1;
	} else {
		let parens = 0;
		while (q < text.length) {
			const c = text[q]!;
			if (c === '\\') {
				q += 2;
				continue;
			}
			if (/\s/.test(c)) break;
			if (c === '(') parens++;
			else if (c === ')') {
				if (parens === 0) break;
				parens--;
			}
			q++;
		}
	}
	const title = /^(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)/.exec(text.slice(q));
	return title ? q + title[0].length - p : 0;
}

// --- comparison with the cache (8-3) -----------------------------------------

export interface CacheView {
	embeds: readonly { offset: number; original: string }[];
	/** Line ranges (inclusive) of the cache's `table` sections. */
	tables: readonly { startLine: number; endLine: number }[];
	/** Line ranges (inclusive) of the cache's `comment` sections (%% blocks). */
	comments?: readonly { startLine: number; endLine: number }[];
}

export interface Mismatch {
	onlyOwn: { offset: number; original: string }[];
	onlyCache: { offset: number; original: string }[];
	/** Same embed, but the parser and the cache disagree on whether it is in a table. */
	table: { offset: number; original: string }[];
	/** In a cache comment section, but not in a %% comment for the parser. */
	comment: { offset: number; original: string }[];
}

/** Line number (0-based) of an offset; CRLF and LF both count one line break. */
export function lineOf(text: string, offset: number): number {
	let n = 0;
	for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) n++;
	return n;
}

/** The set of (offset, original), and table membership of each, must agree exactly. */
export function compareWithCache(text: string, own: readonly FoundEmbed[], cache: CacheView): Mismatch | undefined {
	const key = (e: { offset: number; original: string }) => `${e.offset}:${e.original}`;
	const ownKeys = new Set(own.map(key));
	const cacheKeys = new Set(cache.embeds.map(key));
	const onlyOwn = own.filter((e) => !cacheKeys.has(key(e))).map(({ offset, original }) => ({ offset, original }));
	const onlyCache = cache.embeds.filter((e) => !ownKeys.has(key(e))).map(({ offset, original }) => ({ offset, original }));
	const table = own
		.filter((e) => cacheKeys.has(key(e)))
		.filter((e) => {
			const line = lineOf(text, e.offset);
			return e.inTable !== cache.tables.some((t) => line >= t.startLine && line <= t.endLine);
		})
		.map(({ offset, original }) => ({ offset, original }));
	const comment = own
		.filter((e) => !e.inComment)
		.filter((e) => {
			const line = lineOf(text, e.offset);
			return (cache.comments ?? []).some((c) => line >= c.startLine && line <= c.endLine);
		})
		.map(({ offset, original }) => ({ offset, original }));
	const counts = own.length === cache.embeds.length;
	return onlyOwn.length || onlyCache.length || table.length || comment.length || !counts ? { onlyOwn, onlyCache, table, comment } : undefined;
}

// --- syntax of one embed (8-4) -----------------------------------------------

/** A size suffix: `W` or `WxH`, each 1 to 10000. */
export function parseSize(s: string): string | undefined {
	const m = /^(\d{1,5})(?:x(\d{1,5}))?$/.exec(s);
	if (!m) return undefined;
	const ok = (v: string | undefined) => v === undefined || (Number(v) >= 1 && Number(v) <= 10000);
	return ok(m[1]) && ok(m[2]) ? s : undefined;
}

export type EmbedSyntax =
	| { kind: 'wiki'; path: string; alt?: string; size?: string }
	| { kind: 'markdown'; path: string; alt: string; size?: string };

export type SyntaxRejection = 'multiple-pipes' | 'subpath' | 'escaped-pipe' | 'title' | 'external' | 'reference' | 'unparsable';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The parts of an embed the upload can rewrite, or why it cannot. In a table, a wiki embed separates its
 * parts with `\|`; outside a table `\|` is not understood. Paths are returned as written (not decoded).
 */
export function parseEmbedSyntax(original: string, inTable: boolean): { ok: true; value: EmbedSyntax } | { ok: false; reason: SyntaxRejection } {
	const reject = (reason: SyntaxRejection) => ({ ok: false as const, reason });
	const linkKind = (path: string): SyntaxRejection | undefined => {
		if (path.startsWith('s3-bridge:')) return 'reference';
		if (SCHEME.test(path)) return 'external';
		return undefined;
	};
	if (original.startsWith('![[') && original.endsWith(']]')) {
		const inner = original.slice(3, -2);
		if (!inTable && inner.includes('\\|')) return reject('escaped-pipe');
		const parts = inTable ? inner.split('\\|') : inner.split('|');
		if (inTable && parts.some((x) => x.includes('|'))) return reject('unparsable');
		if (parts.length > 2) return reject('multiple-pipes');
		const path = parts[0]!;
		if (path === '') return reject('unparsable');
		if (path.includes('#') || path.includes('^')) return reject('subpath');
		const kind = linkKind(path);
		if (kind) return reject(kind);
		const extra = parts[1];
		if (extra === undefined) return { ok: true, value: { kind: 'wiki', path } };
		const size = parseSize(extra);
		return { ok: true, value: size ? { kind: 'wiki', path, size } : { kind: 'wiki', path, alt: extra } };
	}
	const m = /^!\[(.*)\]\((<[^>\n]*>|[^\s]*)([ \t]+\S.*)?\)$/s.exec(original);
	if (!m) return reject('unparsable');
	if (m[3] !== undefined) return reject('title');
	const dest = m[2]!;
	const path = dest.startsWith('<') ? dest.slice(1, -1) : dest;
	if (path === '') return reject('unparsable');
	const kind = linkKind(path);
	if (kind) return reject(kind);
	let alt = m[1]!;
	if (inTable) alt = alt.replace(/\\\|/g, '|');
	const bar = alt.lastIndexOf('|');
	const size = bar >= 0 ? parseSize(alt.slice(bar + 1)) : undefined;
	if (size) alt = alt.slice(0, bar);
	return { ok: true, value: size ? { kind: 'markdown', path, alt, size } : { kind: 'markdown', path, alt } };
}

// --- the detection flow (8-3) --------------------------------------------------

export interface DetectSource {
	/** The note as stored on disk (line breaks kept). */
	read(): Promise<string>;
	/** The metadataCache entry of the note right now, or undefined if there is none yet. */
	cache(): CacheView | undefined;
	/** Resolves on the note's metadataCache `changed` event, or after `ms` without one. */
	waitForChange(ms: number): Promise<void>;
}

export const CACHE_WAIT_MS = 3000;

export type Detection =
	| { ok: true; snapshot: string; embeds: FoundEmbed[] }
	| { ok: false; reason: 'unparsable'; problem: ParseProblem; offset: number }
	| { ok: false; reason: 'mismatch'; mismatch: Mismatch }
	| { ok: false; reason: 'changed' };

const NO_CACHE: CacheView = { embeds: [], tables: [], comments: [] };

/**
 * Compares the parser with the cache on the current disk text. On a mismatch it waits for the cache (at most
 * CACHE_WAIT_MS, without relying on the event), re-reads the disk, restarts once if the text changed, and
 * compares once more. The result is accepted only when it matches the current text (R3-3).
 */
export async function detectEmbeds(source: DetectSource): Promise<Detection> {
	let snapshot = await source.read();
	let restarted = false;
	for (;;) {
		const parsed = parseEmbeds(snapshot);
		if (!parsed.ok) return { ok: false, reason: 'unparsable', problem: parsed.problem, offset: parsed.offset };
		if (!compareWithCache(snapshot, parsed.embeds, source.cache() ?? NO_CACHE)) return { ok: true, snapshot, embeds: parsed.embeds };
		await source.waitForChange(CACHE_WAIT_MS);
		const again = await source.read();
		if (again !== snapshot) {
			if (restarted) return { ok: false, reason: 'changed' };
			restarted = true;
			snapshot = again;
			continue;
		}
		const mismatch = compareWithCache(snapshot, parsed.embeds, source.cache() ?? NO_CACHE);
		return mismatch ? { ok: false, reason: 'mismatch', mismatch } : { ok: true, snapshot, embeds: parsed.embeds };
	}
}
