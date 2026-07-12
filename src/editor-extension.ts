import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { TimestampController } from './timestamp-controller';
import { findMarkdownLinkTarget } from './timestamp-target';

export function createEditorTimestampExtension(controller: TimestampController): Extension {
	return EditorView.domEventHandlers({
		click(event, editorView): boolean {
			const target = event.target;
			if (!target || typeof (target as Element).closest !== 'function') return false;

			const position = editorView.posAtCoords({
				x: event.clientX,
				y: event.clientY,
			});
			if (position === null) return false;

			const line = editorView.state.doc.lineAt(position);
			const timestampTarget = findMarkdownLinkTarget(line.text, position - line.from);
			if (!timestampTarget) return false;

			void controller.handleTimestampTarget(event, target as Element, timestampTarget);
			return true;
		},
	});
}
