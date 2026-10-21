// Design 7-7: what is put right after the hidden `img` for content the `img` does not draw itself.
import { renderInfo, renderText } from './content';
import { renderPdf, type PdfDeps } from './pdf';
import type { PreviewInfo, PreviewPdf, PreviewText } from './service';

/** The element put after the `img`, and how to undo what it holds (canvases, pixels, a PDF document). */
export interface Display {
	el: HTMLElement;
	dispose?(): void;
}

export type ContentRenderer = (content: PreviewText | PreviewInfo | PreviewPdf, reference: string) => Display;

/** Without pdf.js (`pdf` omitted) a PDF is shown as its information card. */
export function contentRenderer(pdf?: PdfDeps): ContentRenderer {
	return (content) => {
		if (content.kind === 'text') return { el: renderText(content) };
		if (content.kind === 'info') return { el: renderInfo(content) };
		return pdf ? renderPdf(content, pdf) : { el: renderInfo({ kind: 'info', name: content.name, size: content.size, type: 'pdf' }) };
	};
}
