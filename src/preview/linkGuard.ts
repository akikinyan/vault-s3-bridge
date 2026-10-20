// Design 7-5 (I18): a link to an `s3-bridge:` reference never leaves Obsidian. Three layers stop it: DOM events in
// every window (capture phase), the commands that open the link under the cursor, and window.open. A click or Enter
// opens the preview inside Obsidian instead (7-6); any other way of opening it does nothing.
import { EditorView } from '@codemirror/view';

/** Whether a URL is an `s3-bridge:` reference, however it is cased or padded. */
export function isS3Reference(url: string | null | undefined): url is string {
	return typeof url === 'string' && url.trim().toLowerCase().startsWith('s3-bridge:');
}

/** Index of the `]` that closes the bracket at `open`; -1 if it is not closed on the line. */
function closingBracket(line: string, open: number): number {
	let depth = 0;
	for (let i = open; i < line.length; i++) {
		const c = line[i];
		if (c === '\\') i++;
		else if (c === '[') depth++;
		else if (c === ']' && --depth === 0) return i;
	}
	return -1;
}

/** End (exclusive) of `(dest …)` starting at `open`, and the destination; undefined if not closed on the line. */
function destination(line: string, open: number): { end: number; dest: string } | undefined {
	if (line[open] !== '(') return undefined;
	if (line[open + 1] === '<') {
		const close = line.indexOf('>', open + 2);
		const end = close < 0 ? -1 : line.indexOf(')', close);
		return end < 0 ? undefined : { end: end + 1, dest: line.slice(open + 2, close) };
	}
	let depth = 0;
	for (let i = open + 1; i < line.length; i++) {
		const c = line[i];
		if (c === '\\') i++;
		else if (c === '(') depth++;
		else if (c === ')') {
			if (depth === 0) return { end: i + 1, dest: line.slice(open + 1, i).trim().split(/\s+/)[0] ?? '' };
			depth--;
		}
	}
	return undefined;
}

/**
 * Design 7-5: the `s3-bridge:` URL of the link whose text covers column `ch` of `line`: `[t](s3-bridge://…)`, an
 * embed `![t](…)`, or an autolink `<s3-bridge://…>`. Only the link itself counts, so a click elsewhere on the line
 * still moves the cursor.
 */
export function s3LinkAt(line: string, ch: number): string | undefined {
	for (const m of line.matchAll(/<(s3-bridge:[^>\s]*)>/gi)) {
		if (ch >= m.index && ch < m.index + m[0].length) return m[1];
	}
	for (let i = line.indexOf('['); i >= 0; i = line.indexOf('[', i + 1)) {
		const close = closingBracket(line, i);
		if (close < 0) continue;
		const d = destination(line, close + 1);
		if (!d || !isS3Reference(d.dest)) continue;
		const start = i > 0 && line[i - 1] === '!' ? i - 1 : i;
		if (ch >= start && ch < d.end) return d.dest.trim();
	}
	return undefined;
}

/** Design 7-5 layer 2: commands that open the link under the cursor (in place, in a new tab, window or split). */
export function isLinkOpeningCommand(id: string): boolean {
	return /(^|:)(follow-link|open-link)/.test(id);
}

/** Design 7-5 layer 3: window.open refuses an `s3-bridge:` URL and passes everything else on unchanged. */
export function guardWindowOpen(win: Pick<Window, 'open'>): () => void {
	const original = win.open;
	const guarded = function (this: unknown, ...args: Parameters<Window['open']>) {
		if (isS3Reference(typeof args[0] === 'string' ? args[0] : args[0]?.toString())) return null;
		return original.apply(this, args);
	} as Window['open'];
	win.open = guarded;
	// Put back only if nobody replaced it since.
	return () => {
		if (win.open === guarded) win.open = original;
	};
}

/** Event targets of a popout window are not instances of this window's Node: checked by shape. */
function asNode(target: EventTarget | null): Node | undefined {
	return target !== null && typeof (target as Partial<Node>).nodeType === 'number' && typeof (target as Partial<Node>).instanceOf === 'function' ? (target as Node) : undefined;
}

export interface LinkGuardDeps {
	/** 7-6: shows the referenced object in a modal inside Obsidian. */
	openPreview(url: string): void;
}

const MOUSE_EVENTS = ['click', 'auxclick', 'mousedown', 'contextmenu', 'dragstart'] as const;

/** Layers 1 and 3 for each window it is given. */
export class LinkGuard {
	private readonly windows = new Map<Window, () => void>();

	constructor(private readonly deps: LinkGuardDeps) {}

	/** Registers a window once, popouts included; returns false if it already was. */
	install(win: Window): boolean {
		if (this.windows.has(win)) return false;
		const doc = win.document;
		const onMouse = (evt: Event) => this.onMouse(evt as MouseEvent);
		const onKey = (evt: Event) => this.onKey(evt as KeyboardEvent);
		for (const type of MOUSE_EVENTS) doc.addEventListener(type, onMouse, true);
		doc.addEventListener('keydown', onKey, true);
		const restoreOpen = guardWindowOpen(win);
		this.windows.set(win, () => {
			for (const type of MOUSE_EVENTS) doc.removeEventListener(type, onMouse, true);
			doc.removeEventListener('keydown', onKey, true);
			restoreOpen();
		});
		return true;
	}

	uninstall(win: Window): void {
		this.windows.get(win)?.();
		this.windows.delete(win);
	}

	dispose(): void {
		for (const win of [...this.windows.keys()]) this.uninstall(win);
	}

	/** The reference an event would open: an `a` element's href, or the editor text under the pointer. */
	private urlAt(evt: MouseEvent): string | undefined {
		const target = asNode(evt.target);
		if (!target) return undefined;
		const el = target.instanceOf(Element) ? target : target.parentElement;
		const a = el?.closest('a');
		if (a) {
			const href = a.getAttribute('href') ?? a.getAttribute('data-href');
			return isS3Reference(href) ? href.trim() : undefined;
		}
		const content = el?.closest<HTMLElement>('.cm-content');
		if (!content || !el?.instanceOf(HTMLElement)) return undefined;
		const view = EditorView.findFromDOM(el);
		const pos = view?.posAtCoords({ x: evt.clientX, y: evt.clientY });
		if (!view || pos === null || pos === undefined) return undefined;
		const line = view.state.doc.lineAt(pos);
		return s3LinkAt(line.text, pos - line.from);
	}

	private onMouse(evt: MouseEvent): void {
		// A plain press of the main button only places the cursor or starts a selection.
		if (evt.type === 'mousedown' && evt.button !== 1) return;
		if (evt.type === 'auxclick' && evt.button !== 1) return;
		const url = this.urlAt(evt);
		if (!url) return;
		evt.preventDefault();
		evt.stopImmediatePropagation();
		if (evt.type === 'click' && evt.button === 0) this.deps.openPreview(url);
	}

	/** Enter on a focused link (reading view, page preview). In the editor Enter is typing; layer 2 covers it. */
	private onKey(evt: KeyboardEvent): void {
		if (evt.key !== 'Enter') return;
		const target = asNode(evt.target);
		if (!target?.instanceOf(HTMLAnchorElement)) return;
		const href = target.getAttribute('href') ?? target.getAttribute('data-href');
		if (!isS3Reference(href)) return;
		evt.preventDefault();
		evt.stopImmediatePropagation();
		this.deps.openPreview(href.trim());
	}
}

/** The part of Obsidian's (non-public) command registry that layer 2 wraps. */
export interface CommandRegistry {
	executeCommandById?: (this: unknown, id: string, ...rest: unknown[]) => boolean;
	executeCommand?: (this: unknown, command: { id: string }, ...rest: unknown[]) => boolean;
}

/**
 * Design 7-5 layer 2: a command that opens the link under the cursor does not run while the cursor is on an
 * `s3-bridge:` link; the preview opens instead. Returns the restore function, or undefined if there is nothing to
 * wrap (layer 3 then still stops the link).
 */
export function guardLinkCommands(commands: CommandRegistry | undefined, linkAtCursor: () => string | undefined, openPreview: (url: string) => void): (() => void) | undefined {
	if (!commands || (typeof commands.executeCommandById !== 'function' && typeof commands.executeCommand !== 'function')) return undefined;
	const intercept = (id: string): boolean => {
		if (!isLinkOpeningCommand(id)) return false;
		const url = linkAtCursor();
		if (!url) return false;
		openPreview(url);
		return true;
	};
	const restore: (() => void)[] = [];
	const byId = commands.executeCommandById;
	if (typeof byId === 'function') {
		const wrapped = function (this: unknown, id: string, ...rest: unknown[]) {
			return intercept(id) ? true : byId.call(this, id, ...rest);
		};
		commands.executeCommandById = wrapped;
		restore.push(() => {
			if (commands.executeCommandById === wrapped) commands.executeCommandById = byId;
		});
	}
	const byCommand = commands.executeCommand;
	if (typeof byCommand === 'function') {
		const wrapped = function (this: unknown, command: { id: string }, ...rest: unknown[]) {
			return intercept(command.id) ? true : byCommand.call(this, command, ...rest);
		};
		commands.executeCommand = wrapped;
		restore.push(() => {
			if (commands.executeCommand === wrapped) commands.executeCommand = byCommand;
		});
	}
	return () => {
		for (const r of restore) r();
	};
}
