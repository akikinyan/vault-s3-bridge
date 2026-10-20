// Adds the Obsidian DOM helpers used by the code under test to happy-dom.
type Ctor<T> = abstract new (...args: never[]) => T;

export function installObsidianDomHelpers(): void {
	const node = Node.prototype as unknown as Record<string, unknown>;
	node.instanceOf = function (this: Node, type: Ctor<unknown>): boolean {
		return this instanceof (type as unknown as abstract new () => unknown);
	};
	const el = Element.prototype as unknown as Record<string, unknown>;
	el.addClass = function (this: Element, ...classes: string[]) {
		this.classList.add(...classes);
	};
	el.removeClass = function (this: Element, ...classes: string[]) {
		this.classList.remove(...classes);
	};
	el.hasClass = function (this: Element, cls: string) {
		return this.classList.contains(cls);
	};
	type Options = { cls?: string | string[]; text?: string; type?: string };
	const make = (tag: string, o: Options = {}) => {
		const e = document.createElement(tag);
		if (o.cls) e.classList.add(...(Array.isArray(o.cls) ? o.cls : [o.cls]));
		if (o.text) e.textContent = o.text;
		if (o.type) e.setAttribute('type', o.type);
		return e;
	};
	el.createEl = function (this: Element, tag: string, o?: Options) {
		return this.appendChild(make(tag, o));
	};
	el.createDiv = function (this: Element, o?: Options) {
		return this.appendChild(make('div', o));
	};
	el.createSpan = function (this: Element, o?: Options) {
		return this.appendChild(make('span', o));
	};
	const g = globalThis as Record<string, unknown>;
	g.createSpan = (o: Options = {}) => make('span', o);
	g.createDiv = (o: Options = {}) => make('div', o);
	g.createEl = (tag: string, o: Options = {}) => make(tag, o);
}
