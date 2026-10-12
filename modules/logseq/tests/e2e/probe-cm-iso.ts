// Isolation probe: minimal CM6 editor with the same autocompletion config as
// the plugin. Bundled with the repo's own @codemirror copies; opened as a
// plain file:// page. If .cm-tooltip appears here but not in Obsidian, the
// problem is host-environment; if it doesn't appear here either, it's the
// extension configuration.
import { EditorView } from '@codemirror/view';
import {
  autocompletion,
  completionStatus,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';

const wikiSrc = (ctx: CompletionContext): CompletionResult | null => {
  console.log('[iso] wikiSrc called at', ctx.pos, 'explicit:', ctx.explicit);
  const before = ctx.matchBefore(/\[\[[^\[\]]*$/);
  console.log('[iso] matchBefore:', before ? `${before.from}-${before.to} "${before.text}"` : 'null');
  if (!before) return null;
  // HYPOTHESIS TEST: `from` must sit AFTER the `[[` trigger so CM6's filter
  // query is only the page-name fragment, not the brackets.
  const nameFrom = before.from + 2;
  return {
    from: nameFrom,
    options: [
      { label: 'alpha', type: 'text' },
      { label: 'Page One', type: 'text' },
      { label: 'deep page', type: 'text' },
    ],
    validFor: /^[^\[\]]*$/,
  };
};

const view = new EditorView({
  doc: '',
  parent: document.getElementById('host')!,
  extensions: [
    EditorView.lineWrapping,
    autocompletion({ override: [wikiSrc], icons: true, activateOnTyping: true }),
  ],
});
const w = window as unknown as Record<string, unknown>;
w.view = view;
w.completionStatus = completionStatus;
w.startCompletion = () => startCompletion(view);
w.stateDump = () => {
  // completionStatus values: null | "active" | "pending" | "apply-dialect"
  return { status: completionStatus(view.state) };
};
