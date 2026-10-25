// Minimal stand-ins for the Obsidian API. Unit tests cover modules that do not depend on Obsidian.
export class Plugin {}
export class Notice {}
export const getLanguage = (): string => 'en';
export class Modal {}
export class MarkdownView {}
export class TFile {}
export class Setting {}
export class PluginSettingTab {
	constructor(
		public app: unknown,
		public plugin: unknown,
	) {}
	update(): void {}
	hide(): void {}
}
