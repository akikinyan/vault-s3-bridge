import { describe, expect, it } from 'vitest';
import { editTarget, snapshot, stillSame } from '../src/ui/InsertReferenceModal';
import { MarkdownView, type App, type Editor } from 'obsidian';

function editor(content: string, line = 0, ch = 0) {
	const e = {
		content,
		cursor: { line, ch },
		getValue: () => e.content,
		getCursor: () => e.cursor,
	};
	return e as typeof e & Editor;
}

describe('insert target check', () => {
	it('inserts only into the same, unchanged note at the same cursor', () => {
		const ed = editor('hello', 0, 2);
		const target = snapshot(ed, 'a.md');
		expect(stillSame(target, ed, 'a.md')).toBe(true);
		expect(stillSame(target, ed, 'b.md')).toBe(false); // switched notes
		expect(stillSame(target, editor('hello', 0, 2), 'a.md')).toBe(false); // another editor
		expect(stillSame(target, undefined, 'a.md')).toBe(false); // view closed
		ed.content = 'hello!';
		expect(stillSame(target, ed, 'a.md')).toBe(false); // edited
		ed.content = 'hello';
		ed.cursor = { line: 0, ch: 3 };
		expect(stillSame(target, ed, 'a.md')).toBe(false); // cursor moved
	});
});

describe('edit target', () => {
	const app = (activeEditor: unknown) => ({ workspace: { activeEditor } }) as unknown as App;
	const markdownView = (mode: 'source' | 'preview', ed: Editor) =>
		Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, { editor: ed, file: { path: 'a.md' }, getMode: () => mode });

	it('accepts a Markdown view in editing mode', () => {
		const ed = editor('x');
		expect(editTarget(app(markdownView('source', ed)))).toEqual({ editor: ed, path: 'a.md' });
	});

	it('refuses reading mode and no active editor', () => {
		expect(editTarget(app(markdownView('preview', editor('x'))))).toBeUndefined();
		expect(editTarget(app(null))).toBeUndefined();
		expect(editTarget(app({ file: { path: 'a.md' } }))).toBeUndefined(); // no editor
	});

	it('accepts an embedded editor such as a note edited inside a Canvas', () => {
		const ed = editor('x');
		expect(editTarget(app({ editor: ed, file: { path: 'c.md' } }))).toEqual({ editor: ed, path: 'c.md' });
	});
});
