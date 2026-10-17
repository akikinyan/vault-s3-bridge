// The two upload commands (11-1) on top of uploadCommand: picker, confirmation screen, progress with a stop
// button (10-4) and the result notice.
import { type App, MarkdownView, Notice, type TFile } from 'obsidian';
import { t } from '../i18n';
import { connectionState } from '../settings/registry';
import { uploadCommand } from '../upload/job';
import { type UploadHost, uploadCommandDeps } from '../upload/obsidianJob';
import { type Line, pendingLine, planView, resultLines, stopLine } from '../upload/present';
import { pickConnection } from './ConnectionPickerModal';
import { confirmUpload } from './UploadConfirmModal';

const text = (lines: readonly Line[]) => lines.map((l) => t(l.key, l.params)).join('\n');

/** The note of the active Markdown view in editing mode; reading mode has none. */
export function uploadTarget(app: App): TFile | undefined {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.getMode() !== 'source') return undefined;
	return view.file ?? undefined;
}

/** A notice that stays until the job ends, with a stop button. Clicks elsewhere in it do not close it. */
function progressNotice(files: number, stop: AbortController): Notice {
	const fragment = createFragment((f) => {
		const box = f.createDiv();
		box.addEventListener('click', (e) => e.stopPropagation());
		box.createSpan({ text: t('upload.progress', { n: String(files) }) });
		box.createEl('button', { text: t('upload.stopButton'), cls: 'mod-warning' }).addEventListener('click', () => stop.abort());
	});
	return new Notice(fragment, 0);
}

export async function runUploadCommand(host: UploadHost, file: TFile, preview: boolean): Promise<void> {
	// Created before the deps: the stop button exists for the whole job.
	const stop = new AbortController();
	let progress: Notice | undefined;
	if (!preview && host.pending) {
		const line = pendingLine(host.pending.items);
		if (line) new Notice(text([line]));
	}
	const job = uploadCommandDeps(host, file, {
		pickConnection: () => {
			const s = host.store.current;
			const active = s.connections.filter((c) => connectionState(s, c) === 'active');
			if (active.length === 0) {
				new Notice(t('upload.noActiveConnections'));
				return Promise.resolve(undefined);
			}
			const preferred = active.find((c) => c.id === s.upload.defaultConnectionId) ?? (active.length === 1 ? active[0] : undefined);
			return preferred ? Promise.resolve(preferred) : pickConnection(host.app, active, t('picker.uploadPlaceholder'));
		},
		confirm: async (plan, previewMode) => {
			const choice = await confirmUpload(host.app, planView(plan, host.store.current), previewMode);
			if (choice && !previewMode) progress = progressNotice(plan.groups.reduce((n, g) => n + g.files.length, 0), stop);
			return choice;
		},
		stop: stop.signal,
	});
	try {
		const r = await uploadCommand(job.deps, preview);
		if ('stop' in r) {
			const line = stopLine(r);
			if (line) new Notice(text([line]));
			return;
		}
		progress?.hide();
		const { lines, warn } = resultLines(r.done);
		new Notice(text(lines), warn ? 0 : undefined);
	} catch {
		new Notice(t('code.unknown'));
	} finally {
		progress?.hide();
		job.dispose();
	}
}
