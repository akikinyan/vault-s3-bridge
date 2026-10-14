import { en, type MessageKey } from './en';
import { ja } from './ja';
import type { LanguageSetting } from '../settings/types';

export type { MessageKey };

let current: 'en' | 'ja' = 'en';

/** `obsidianLanguage` is the value of Obsidian's getLanguage(). */
export function setLanguage(setting: LanguageSetting, obsidianLanguage: string): void {
	current = setting === 'auto' ? (obsidianLanguage.startsWith('ja') ? 'ja' : 'en') : setting;
}

export function t(key: MessageKey, params: Record<string, string> = {}): string {
	const template: string = (current === 'ja' ? ja : en)[key] ?? en[key];
	return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}

/** Looks up a dynamic key, falling back to `fallback` when it does not exist. */
export function tDynamic(key: string, fallback: MessageKey): string {
	return key in en ? t(key as MessageKey) : t(fallback);
}
