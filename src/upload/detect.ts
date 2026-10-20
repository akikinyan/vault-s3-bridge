// Finds embeds and links in a note independently of Obsidian's metadataCache (design 8-2), so the cache can be
// checked against the current text (8-3). Block structure is classified first (front matter, fences, indented
// code, math blocks, HTML blocks, tables), then the remaining text is scanned once from left to right for
// inline code, inline math, %% comments, HTML comments, escapes, embeds and links. Anything it cannot decide is a
// problem: the caller aborts instead of guessing.

export interface FoundEmbed {
	/** UTF-16 offset in the note as stored (CRLF kept). */
	offset: number;
	original: string;
	/** Inside %% … %%: part of the comparison with the cache, never a target. */
	inComment: boolean;
	/** In a GFM table row (any container), where a generated `|` must be escaped. */
	inTable: boolean;
	/**
	 * On a `|` line of a table inside a quote, callout or list. The cache reports only top-level sections, so
	 * whether such a line is a table row cannot be checked against it (it is left out of the table comparison).
	 */
	inNestedTable: boolean;
}

export type ParseProblem =
	| 'lone-cr'
	| 'unclosed-percent'
	| 'unclosed-html-comment'
	| 'comment-spans-block'
	/** Design 5-2 (D19): whether the cache ends a comment at a %% inside inline code is not known. */
	| 'percent-in-code-in-comment';

export interface ParsedLinks {
	embeds: FoundEmbed[];
	/** `[[p]]` and `[t](p)`, as the cache's `links` (design 5-1). */
	links: FoundEmbed[];
	/** Offsets of reference-style links `[t][id]` and definitions `[id]: p`, which the cache does not report (5-3). */
	references: number[];
}

export type ParsedNote = ({ ok: true } & ParsedLinks) | { ok: false; problem: ParseProblem; offset: number };

interface Line {
	start: number;
	/** Without the line break. */
	text: string;
	kind: 'frontmatter' | 'fence' | 'indented-code' | 'math' | 'html' | 'normal';
	inTable: boolean;
	inNestedTable: boolean;
}

const QUOTE = /^(?: {0,3}> ?)*/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?: +|$)/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const HTML_BLOCK_6 =
	/^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i;
const HTML_BLOCK_1 = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
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
		lines.push({ start, text: t, kind: 'normal', inTable: false, inNestedTable: false });
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

/**
 * Tables as Obsidian reads them (measured): a header row and a delimiter row with the same cell count, not
 * directly after a paragraph line (a heading line, ATX or setext, is not one), then rows that contain `|`, up to a blank line.
 */
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
		const prev = lines[i - 1];
		const prevText = prev ? content(prev.text) : '';
		// A heading (ATX, or a setext underline under a text line) ends the paragraph: a table may follow (measured).
		const before = lines[i - 2];
		const setext = SETEXT_UNDERLINE.test(prevText) && before !== undefined && before.kind === 'normal' && !isBlank(content(before.text));
		const paragraphBefore =
			prev !== undefined && prev.kind === 'normal' && !prev.inTable && quoteDepth(prev.text) === depth && !isBlank(prevText) && !ATX_HEADING.test(prevText) && !setext;
		if (paragraphBefore) continue;
		let n = i;
		while (n < lines.length) {
			const l = lines[n]!;
			if (l.kind !== 'normal' || quoteDepth(l.text) !== depth || isBlank(content(l.text)) || !content(l.text).includes('|')) break;
			l.inTable = true;
			n++;
		}
		i = n - 1;
	}
	markNestedTables(lines, quoteDepth, content);
}

/**
 * A run of lines in the same container (quote depth, or indented inside a list) that holds a delimiter-like
 * row may be a table the cache cannot report: its `|` lines are marked so the comparison does not judge them.
 */
function markNestedTables(lines: Line[], quoteDepth: (t: string) => number, content: (t: string) => string): void {
	const delimiterLike = (t: string) => t.includes('|') && t.includes('-') && DELIMITER_ROW.test(t.trim());
	// Tables found inside a quote or callout are escaped as tables, but still cannot be compared.
	for (const l of lines) if (l.inTable && quoteDepth(l.text) > 0) l.inNestedTable = true;
	let i = 0;
	while (i < lines.length) {
		const first = lines[i]!;
		const depth = quoteDepth(first.text);
		const nested = (l: Line) => depth > 0 || indentOf(content(l.text)) > 0;
		if (first.kind !== 'normal' || isBlank(content(first.text)) || !nested(first)) {
			i++;
			continue;
		}
		let n = i;
		while (n < lines.length && lines[n]!.kind === 'normal' && quoteDepth(lines[n]!.text) === depth && !isBlank(content(lines[n]!.text)) && nested(lines[n]!)) n++;
		const run = lines.slice(i, n);
		if (run.some((l) => !l.inTable && delimiterLike(content(l.text)))) {
			for (const l of run) if (!l.inTable && content(l.text).includes('|')) l.inNestedTable = true;
		}
		i = Math.max(n, i + 1);
	}
}

const PUNCT = /[!-/:-@[-`{-~]/;

function where(line: Line): { inTable: boolean; inNestedTable: boolean } {
	return { inTable: line.inTable, inNestedTable: line.inNestedTable };
}

/** One left-to-right pass over the text of normal lines. */
export interface ParseOptions {
	/**
	 * Design 6-3: also count embeds and links whose destination has a scheme. Only for checking generated Markdown,
	 * which always has one; the cache does not report them, so detection never sets it.
	 */
	countSchemeReferences?: boolean;
}

export function parseEmbeds(text: string, options: ParseOptions = {}): ParsedNote {
	const schemes = options.countSchemeReferences === true;
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

	/** Backtick run length at p and the start of its closing run within the paragraph (-1 if none). */
	const codeSpan = (p: number): [number, number] => {
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
		return [n, q >= 0 && q < end ? q : -1];
	};

	const embeds: FoundEmbed[] = [];
	const links: FoundEmbed[] = [];
	const references: number[] = [];
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
			// 5-2: inline code inside a comment is skipped as outside; a %% inside it has not been measured, so stop.
			if (ch === '`') {
				const [n, q] = codeSpan(p);
				if (q >= 0 && text.slice(p + n, q).includes('%%')) return { ok: false, problem: 'percent-in-code-in-comment', offset: p };
				p = q >= 0 ? q + n : p + n;
				continue;
			}
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
				const [n, q] = codeSpan(p);
				p = q >= 0 ? q + n : p + n;
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
				embeds.push({ offset: p, original: text.slice(p, end + 2), inComment, ...where(lines[lineAt[p]!]!) });
				p = end + 2;
				continue;
			}
		} else if (text.startsWith('![', p)) {
			const len = markdownImageLength(text, p);
			if (len > 0) {
				const original = text.slice(p, p + len);
				// URLs with a scheme (https://, s3-bridge://) are not embeds for the cache (measured).
				if (schemes || !hasScheme(original)) embeds.push({ offset: p, original, inComment, ...where(lines[lineAt[p]!]!) });
				p += len;
				continue;
			}
		} else if (text.startsWith('[[', p)) {
			// 5-1: a wiki link runs to the first ]] on its line, as a wiki embed does.
			const end = text.indexOf(']]', p + 2);
			const nl = text.indexOf('\n', p);
			if (end > p + 2 && (nl < 0 || end < nl)) {
				links.push({ offset: p, original: text.slice(p, end + 2), inComment, ...where(lines[lineAt[p]!]!) });
				p = end + 2;
				continue;
			}
		} else if (ch === '[') {
			const len = markdownImageLength(text, p - 1);
			if (len > 1) {
				const original = text.slice(p, p - 1 + len);
				// Links with a scheme are not in the cache's links either (measured).
				if (schemes || !SCHEME.test(linkDestination(original))) links.push({ offset: p, original, inComment, ...where(lines[lineAt[p]!]!) });
				// Past '[' only: an image in the link text is an embed of its own.
				p++;
				continue;
			}
			// 5-3: a reference-style link `[t][id]` or a definition `[id]: p` (up to 3 spaces in) is not reported.
			const rest = text.slice(p, p + 400);
			const lineStart = text.slice(lines[lineAt[p]!]!.start, p);
			if (/^\[[^\]\n]+\]\[[^\]\n]*\]/.test(rest) || (/^ {0,3}$/.test(lineStart) && /^\[[^\]\n]+\]:/.test(rest))) references.push(p);
		}
		p++;
	}
	if (inComment) return { ok: false, problem: 'unclosed-percent', offset: commentStart };
	return { ok: true, embeds, links, references };
}

/** The destination of `[text](dest)`, after the bracket that closes the text (the text may hold an image). */
function linkDestination(link: string): string {
	const close = linkTextEnd(link);
	return close < 0 ? '' : link.slice(close + 2).replace(/^</, '');
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `![alt](dest)` whose destination starts with a URL scheme. */
function hasScheme(markdownImage: string): boolean {
	const open = markdownImage.indexOf('](');
	const dest = markdownImage.slice(open + 2).replace(/^</, '');
	return SCHEME.test(dest);
}

/** Length of `![alt](dest "title")` at p on one line, or 0. */
export function markdownImageLength(text: string, p: number): number {
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
	/** The cache's `links` (design 5-4): notes and headings included, front matter not. */
	links: readonly { offset: number; original: string }[];
	/** Line ranges (inclusive) of the cache's `table` sections. */
	tables: readonly { startLine: number; endLine: number }[];
	/** Line ranges (inclusive) of the cache's `comment` sections (%% blocks). */
	comments?: readonly { startLine: number; endLine: number }[];
}

export interface Found {
	kind: 'embed' | 'link';
	offset: number;
	original: string;
}

export interface Mismatch {
	onlyOwn: Found[];
	onlyCache: Found[];
	/** Same embed or link, but the parser and the cache disagree on whether it is in a table. */
	table: Found[];
	/** In a cache comment section, but not in a %% comment for the parser. */
	comment: Found[];
}

/** Line number (0-based) of an offset; CRLF and LF both count one line break. */
export function lineOf(text: string, offset: number): number {
	let n = 0;
	for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) n++;
	return n;
}

/**
 * I11 and design 5-4: the embeds and the links, each as a set of (offset, original) and a count, and the table
 * membership of each, must agree exactly. An embed never matches a link.
 */
export function compareWithCache(text: string, own: Pick<ParsedLinks, 'embeds' | 'links'>, cache: CacheView): Mismatch | undefined {
	const mine = [...own.embeds.map((e) => ({ kind: 'embed' as const, e })), ...own.links.map((e) => ({ kind: 'link' as const, e }))];
	const theirs: Found[] = [
		...cache.embeds.map(({ offset, original }) => ({ kind: 'embed' as const, offset, original })),
		...cache.links.map(({ offset, original }) => ({ kind: 'link' as const, offset, original })),
	];
	const key = (f: Found) => `${f.kind}:${f.offset}:${f.original}`;
	const found = (kind: Found['kind'], e: FoundEmbed): Found => ({ kind, offset: e.offset, original: e.original });
	const ownKeys = new Set(mine.map(({ kind, e }) => key(found(kind, e))));
	const cacheKeys = new Set(theirs.map(key));
	const onlyOwn = mine.map(({ kind, e }) => found(kind, e)).filter((f) => !cacheKeys.has(key(f)));
	const onlyCache = theirs.filter((f) => !ownKeys.has(key(f)));
	const table = mine
		.filter(({ kind, e }) => cacheKeys.has(key(found(kind, e))) && !e.inNestedTable)
		.filter(({ e }) => {
			const line = lineOf(text, e.offset);
			return e.inTable !== cache.tables.some((t) => line >= t.startLine && line <= t.endLine);
		})
		.map(({ kind, e }) => found(kind, e));
	const comment = mine
		.filter(({ e }) => !e.inComment)
		.filter(({ e }) => {
			const line = lineOf(text, e.offset);
			return (cache.comments ?? []).some((c) => line >= c.startLine && line <= c.endLine);
		})
		.map(({ kind, e }) => found(kind, e));
	const counts = own.embeds.length === cache.embeds.length && own.links.length === cache.links.length;
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
	// Outside a detected table, `\|` may still be a cell of a table the parser cannot see (in a list or a
	// callout): rewriting it would produce a bare `|` there.
	if (!inTable && alt.includes('\\|')) return reject('escaped-pipe');
	if (inTable) alt = alt.replace(/\\\|/g, '|');
	const bar = alt.lastIndexOf('|');
	const size = bar >= 0 ? parseSize(alt.slice(bar + 1)) : undefined;
	if (size) alt = alt.slice(0, bar);
	return { ok: true, value: size ? { kind: 'markdown', path, alt, size } : { kind: 'markdown', path, alt } };
}

export type LinkSyntax = { kind: 'wiki'; path: string; text?: string } | { kind: 'markdown'; path: string; text: string };

/**
 * Design 6-1: the parts of a link the upload can rewrite. `x` in `[[p|x]]` is the display text, never a size; in a
 * table the parts are separated by `\|`. The text of `[t](p)` is Markdown and kept as written.
 */
export function parseLinkSyntax(original: string, inTable: boolean): { ok: true; value: LinkSyntax } | { ok: false; reason: SyntaxRejection } {
	const reject = (reason: SyntaxRejection) => ({ ok: false as const, reason });
	const pathKind = (path: string): SyntaxRejection | undefined => {
		if (path === '') return 'unparsable';
		if (path.startsWith('s3-bridge:')) return 'reference';
		if (SCHEME.test(path)) return 'external';
		if (path.includes('#') || path.includes('^')) return 'subpath';
		return undefined;
	};
	if (original.startsWith('[[') && original.endsWith(']]')) {
		const inner = original.slice(2, -2);
		if (!inTable && inner.includes('\\|')) return reject('escaped-pipe');
		const parts = inTable ? inner.split('\\|') : inner.split('|');
		if (inTable && parts.some((x) => x.includes('|'))) return reject('unparsable');
		if (parts.length > 2) return reject('multiple-pipes');
		const path = parts[0]!;
		const bad = pathKind(path);
		if (bad) return reject(bad);
		return { ok: true, value: parts[1] === undefined ? { kind: 'wiki', path } : { kind: 'wiki', path, text: parts[1] } };
	}
	const close = original.startsWith('[') ? linkTextEnd(original) : -1;
	if (close < 0) return reject('unparsable');
	const m = /^\((<[^>\n]*>|[^\s]*)([ \t]+\S.*)?\)$/s.exec(original.slice(close + 1));
	if (!m) return reject('unparsable');
	if (m[2] !== undefined) return reject('title');
	const dest = m[1]!;
	const path = dest.startsWith('<') ? dest.slice(1, -1) : dest;
	const bad = pathKind(path);
	if (bad) return reject(bad);
	const text = original.slice(1, close);
	// As for embeds: outside a detected table, `\|` may be a cell of a table the parser cannot see.
	if (!inTable && text.includes('\\|')) return reject('escaped-pipe');
	return { ok: true, value: { kind: 'markdown', path, text } };
}

/** Index of the `]` that closes the text of `[text](dest)`; -1 if there is none. */
function linkTextEnd(link: string): number {
	let depth = 0;
	for (let i = 0; i < link.length; i++) {
		const c = link[i];
		if (c === '\\') i++;
		else if (c === '[') depth++;
		else if (c === ']' && --depth === 0) return i;
	}
	return -1;
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
	| ({ ok: true; snapshot: string } & ParsedLinks)
	| { ok: false; reason: 'unparsable'; problem: ParseProblem; offset: number }
	| { ok: false; reason: 'mismatch'; mismatch: Mismatch }
	| { ok: false; reason: 'changed' };

const NO_CACHE: CacheView = { embeds: [], links: [], tables: [], comments: [] };

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
		const { embeds, links, references } = parsed;
		const result = { ok: true as const, snapshot, embeds, links, references };
		if (!compareWithCache(snapshot, parsed, source.cache() ?? NO_CACHE)) return result;
		await source.waitForChange(CACHE_WAIT_MS);
		const again = await source.read();
		if (again !== snapshot) {
			if (restarted) return { ok: false, reason: 'changed' };
			restarted = true;
			snapshot = again;
			continue;
		}
		const mismatch = compareWithCache(snapshot, parsed, source.cache() ?? NO_CACHE);
		return mismatch ? { ok: false, reason: 'mismatch', mismatch } : result;
	}
}
