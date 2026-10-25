// Design 8-3: whether a text names a file, decided generously. Every decoding that could hide a file name is
// applied, alone and combined, and a name found in any of the results counts as a reference. A false match only
// keeps a file where it is (plan 2-6); a missed one could move a file a note still uses.
import { decodeHTML } from 'entities';

/** Design 8-3 step 3 (N): NFC, without case. */
export function normalizeForSearch(text: string): string {
	return text.normalize('NFC').toLowerCase();
}

const UTF8_LENGTH = (lead: number): number => (lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0);

function percentOnce(text: string): string {
	return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
		let out = '';
		const count = run.length / 3;
		for (let i = 0; i < count; ) {
			const n = UTF8_LENGTH(parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16));
			if (n > 0 && i + n <= count) {
				try {
					out += decodeURIComponent(run.slice(i * 3, (i + n) * 3));
					i += n;
					continue;
				} catch {
					// Not a valid UTF-8 sequence: kept as written.
				}
			}
			out += run.slice(i * 3, i * 3 + 3);
			i++;
		}
		return out;
	});
}

/** Design 8-3 step 2 (P): `%XX` as UTF-8, invalid runs kept, repeated (at most 3 times) for `%2520`. */
export function percentDecode(text: string): string {
	let current = text;
	for (let i = 0; i < 3 && current.includes('%'); i++) {
		const next = percentOnce(current);
		if (next === current) break;
		current = next;
	}
	return current;
}

const JSON_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** Design 8-3 step 1: JSON string escapes, without parsing (surrogate pairs join as they are written). */
export function jsonUnescape(text: string): string {
	return text.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_, e: string) => (e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16)) : JSON_ESCAPES[e]!));
}

/** Design 8-3 step 1: a Markdown backslash before an ASCII punctuation character. */
export function markdownUnescape(text: string): string {
	return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** Design 8-3 step 1: HTML character references, all named ones included (also the legacy ones without `;`). */
export function htmlDecode(text: string): string {
	return text.includes('&') ? decodeHTML(text) : text;
}

/** Every string value and key of a parsed JSON document, one per line. Throws if the text is not JSON. */
export function jsonStrings(text: string): string {
	const out: string[] = [];
	const walk = (v: unknown): void => {
		if (typeof v === 'string') out.push(v);
		else if (Array.isArray(v)) v.forEach(walk);
		else if (v !== null && typeof v === 'object') {
			for (const [k, x] of Object.entries(v)) {
				out.push(k);
				walk(x);
			}
		}
	};
	walk(JSON.parse(text));
	return out.join('\n');
}

// The characters formatReference writes. A reference written otherwise (a raw space, say) ends early and the rest
// of it is searched; text joined to a URL with none of the other characters between is taken as part of it.
const REFERENCE_URL = /s3-bridge:\/\/[A-Za-z0-9\-_.~/%]*/g;

/**
 * Design 8-3 step 1: `s3-bridge://` references blanked out. They name an object on the storage, never a vault file,
 * yet their key usually ends with the uploaded file's own name. Done before P, while `%20` still keeps the URL whole.
 */
export function withoutReferences(text: string): string {
	return text.includes('s3-bridge://') ? text.replace(REFERENCE_URL, ' ') : text;
}

/**
 * Design 8-3 step 4: the forms a text is searched in, each once. S is every combination of the structural
 * decodings ({as written, JSON unescaped} × {HTML decoded or not} × {Markdown unescaped or not}, plus the strings
 * of a parsed Canvas); each gives N(S) and N(P(S)). Yielded one by one so a large text is not held many times.
 */
export function* searchForms(text: string, parsed?: string): Generator<string> {
	const seen = new Set<string>();
	const structural = new Set<string>();
	for (const base of parsed === undefined ? [text] : [text, parsed]) {
		for (const j of base.includes('\\') ? [base, jsonUnescape(base)] : [base]) {
			for (const h of j.includes('&') ? [j, htmlDecode(j)] : [j]) {
				structural.add(h);
				if (h.includes('\\')) structural.add(markdownUnescape(h));
			}
		}
	}
	for (const decoded of structural) {
		const s = withoutReferences(decoded);
		const n = normalizeForSearch(s);
		if (!seen.has(n)) {
			seen.add(n);
			yield n;
		}
		if (s.includes('%')) {
			const p = normalizeForSearch(percentDecode(s));
			if (!seen.has(p)) {
				seen.add(p);
				yield p;
			}
		}
	}
}

/** Design 8-3 step 4: the forms a file name is looked for in: N(name) and N(P(name)). */
export function nameForms(name: string): string[] {
	return [...new Set([normalizeForSearch(name), normalizeForSearch(percentDecode(name))])];
}

interface ExtensionGroup {
	lengths: Set<number>;
	forms: Map<string, Set<string>>;
}

/**
 * Finds which of many names occur in a text, as `includes` would but without trying every name: each name form
 * is indexed by its own extension, every occurrence of `.ext` in the text is a possible end of a name, and the
 * text before it is looked up for each length a name with that extension has. Forms without an extension are
 * looked for one by one.
 */
export class NameMatcher {
	private readonly byExtension = new Map<string, ExtensionGroup>();
	private readonly plain = new Map<string, Set<string>>();

	/** `names`: an id (the file's path) and its name, with extension. */
	constructor(names: Iterable<readonly [id: string, name: string]>) {
		for (const [id, name] of names) {
			for (const form of nameForms(name)) {
				const dot = form.lastIndexOf('.');
				const ext = dot < 0 ? '' : form.slice(dot + 1);
				if (ext === '') {
					add(this.plain, form, id);
					continue;
				}
				let group = this.byExtension.get(ext);
				if (!group) this.byExtension.set(ext, (group = { lengths: new Set(), forms: new Map() }));
				group.lengths.add(form.length);
				add(group.forms, form, id);
			}
		}
	}

	/** Adds to `found` the id of every name that occurs in `text` (a searched form, already normalized). */
	find(text: string, found: Set<string>): void {
		for (const [ext, group] of this.byExtension) {
			const needle = `.${ext}`;
			for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
				const end = at + needle.length;
				for (const length of group.lengths) {
					if (length > end) continue;
					const ids = group.forms.get(text.slice(end - length, end));
					if (ids) for (const id of ids) found.add(id);
				}
			}
		}
		for (const [form, ids] of this.plain) if (text.includes(form)) for (const id of ids) found.add(id);
	}
}

function add(map: Map<string, Set<string>>, key: string, id: string): void {
	let set = map.get(key);
	if (!set) map.set(key, (set = new Set()));
	set.add(id);
}
