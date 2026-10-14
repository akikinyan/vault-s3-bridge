import { ViewPlugin, type EditorView } from '@codemirror/view';
import type { ImageReplacer } from './replacer';

/** Applies the replacer to images that Obsidian's live preview creates or changes. */
export function livePreviewExtension(replacer: ImageReplacer) {
	return ViewPlugin.fromClass(
		class {
			private readonly observer: MutationObserver;

			constructor(private readonly view: EditorView) {
				replacer.processTree(view.dom);
				this.observer = new MutationObserver((records) => {
					const removed: Node[] = [];
					for (const record of records) {
						if (record.type === 'attributes') {
							if (record.target.instanceOf(HTMLImageElement)) replacer.process(record.target);
							continue;
						}
						record.removedNodes.forEach((node) => removed.push(node));
						record.addedNodes.forEach((node) => replacer.processTree(node));
					}
					// Release only what is still detached after the batch (moved nodes stay tracked).
					replacer.releaseDetached(removed);
				});
				this.observer.observe(view.dom, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
			}

			destroy(): void {
				this.observer.disconnect();
				replacer.releaseTree(this.view.dom);
			}
		},
	);
}
