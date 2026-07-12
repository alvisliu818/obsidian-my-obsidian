const MARKDOWN_LINK_PATTERN = /\[(?:\\.|[^\]])*\]\(([^)]+)\)/g;

export function findTimestampTarget(event: MouseEvent, target: Element): string | null {
	const link = target.closest<HTMLAnchorElement>('a');
	if (link) {
		return link.getAttribute('data-href') ?? link.getAttribute('href');
	}

	const attributedTarget = target.closest<HTMLElement>('[data-href], [href]');
	if (attributedTarget) {
		return attributedTarget.getAttribute('data-href') ?? attributedTarget.getAttribute('href');
	}

	const line = target.closest<HTMLElement>('.cm-line');
	if (!line) return null;

	const offset = textOffsetAtPoint(line, event.clientX, event.clientY);
	return findMarkdownLinkTarget(line.textContent ?? '', offset);
}

export function findMarkdownLinkTarget(line: string, offset: number): string | null {
	for (const match of line.matchAll(MARKDOWN_LINK_PATTERN)) {
		const start = match.index;
		const end = start + match[0].length;
		if (offset >= start && offset <= end) return match[1] ?? null;
	}
	return null;
}

function textOffsetAtPoint(line: HTMLElement, x: number, y: number): number {
	const documentAtPoint = line.ownerDocument;
	const caretPosition = documentAtPoint.caretPositionFromPoint?.(x, y);
	if (caretPosition && line.contains(caretPosition.offsetNode)) {
		return rangeLength(line, caretPosition.offsetNode, caretPosition.offset);
	}

	const caretRangeFromPoint = Reflect.get(documentAtPoint, 'caretRangeFromPoint') as
		| ((clientX: number, clientY: number) => Range | null)
		| undefined;
	const caretRange = caretRangeFromPoint?.call(documentAtPoint, x, y);
	if (caretRange && line.contains(caretRange.startContainer)) {
		return rangeLength(line, caretRange.startContainer, caretRange.startOffset);
	}

	return Number.MAX_SAFE_INTEGER;
}

function rangeLength(line: HTMLElement, node: Node, offset: number): number {
	const range = line.ownerDocument.createRange();
	range.setStart(line, 0);
	range.setEnd(node, offset);
	return range.toString().length;
}
