// Adds the Obsidian DOM helpers used by the code under test to happy-dom.
type Ctor<T> = abstract new (...args: never[]) => T;

export function installObsidianDomHelpers(): void {
	const node = Node.prototype as unknown as Record<string, unknown>;
	node.instanceOf = function (this: Node, type: Ctor<unknown>): boolean {
		return this instanceof (type as unknown as abstract new () => unknown);
	};
	const el = Element.prototype as Element & Record<string, unknown>;
	el.addClass = function (this: Element, ...classes: string[]) {
		this.classList.add(...classes);
	};
	el.removeClass = function (this: Element, ...classes: string[]) {
		this.classList.remove(...classes);
	};
	const g = globalThis as Record<string, unknown>;
	g.createSpan = (o: { cls?: string | string[]; text?: string } = {}) => {
		const span = document.createElement('span');
		if (o.cls) span.classList.add(...(Array.isArray(o.cls) ? o.cls : [o.cls]));
		if (o.text) span.textContent = o.text;
		return span;
	};
}
