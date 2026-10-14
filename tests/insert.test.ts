import { describe, expect, it } from 'vitest';
import { snapshot, stillSame } from '../src/ui/InsertReferenceModal';
import type { Editor } from 'obsidian';

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
