/**
 * Slash command menu ("/" while editing a block) implemented as a CM6
 * autocompletion source. Commands apply text edits and/or block mutations.
 */

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { BlockEditorView } from '../view/BlockEditorView';
import type { Marker } from '../types';

interface SlashCommand extends Completion {
  group: string;
  /** Mutates the focused block model — not available in the embed editor. */
  needsBlock?: boolean;
  run: (view: EditorView, from: number, to: number, host: BlockEditorView) => void;
}

const todayLink = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `[[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}]]`;
};

const nowTime = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const todayISO = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function replaceRange(view: EditorView, from: number, to: number, insert: string, caret?: number): void {
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: caret !== undefined ? from + caret : from + insert.length },
  });
}

function markerCommand(label: string, marker: Marker): SlashCommand {
  return {
    label,
    group: 'Task state',
    detail: `set marker to ${label}`,
    type: 'keyword',
    needsBlock: true,
    run: (view, from, to, host) => {
      replaceRange(view, from, to, '');
      const b = host.focusedBlock;
      if (!b) return;
      host.mutate(
        () => {
          b.marker = marker;
        },
        () => ({ subtree: b }),
      );
      host.focusBlock(b, 0);
    },
  };
}

/** Slash command that sets (or clears, value=null) a block property. */
function propCommand(label: string, key: string, value: string | null, detail?: string): SlashCommand {
  return {
    label,
    group: 'Task state',
    detail: detail ?? (value === null ? `remove ${key}:: property` : `set ${key}:: ${value}`),
    type: 'keyword',
    needsBlock: true,
    run: (view, from, to, host) => {
      replaceRange(view, from, to, '');
      const b = host.focusedBlock;
      if (!b) return;
      host.mutate(
        () => {
          if (value === null) delete b.props[key];
          else b.props[key] = value;
        },
        () => ({ subtree: b }),
      );
      host.focusBlock(b, 0);
    },
  };
}

const COMMANDS: SlashCommand[] = [
  markerCommand('TODO', 'TODO'),
  markerCommand('DOING', 'DOING'),
  markerCommand('DONE', 'DONE'),
  {
    label: 'Heading 1',
    group: 'Formatting',
    detail: 'large heading',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '# '),
  },
  {
    label: 'Heading 2',
    group: 'Formatting',
    detail: 'medium heading',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '## '),
  },
  {
    label: 'Heading 3',
    group: 'Formatting',
    detail: 'small heading',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '### '),
  },
  {
    label: 'Divider',
    group: 'Formatting',
    detail: 'horizontal rule',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '---'),
  },
  {
    label: 'Code block',
    group: 'Formatting',
    detail: 'fenced code',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '```\n\n```', 4),
  },
  {
    label: 'Quote',
    group: 'Formatting',
    detail: 'blockquote',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '> '),
  },
  {
    label: "Today's date",
    group: 'Insert',
    detail: 'link to today\'s journal page',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, todayLink()),
  },
  {
    label: 'Current time',
    group: 'Insert',
    detail: 'HH:mm',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, nowTime()),
  },
  {
    label: 'Block reference',
    group: 'Insert',
    detail: 'insert ((block-id))',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '((', 2),
  },
  {
    label: 'Embed block',
    group: 'Insert',
    detail: 'inline another block',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '{{embed ((', 9),
  },
  {
    label: 'Priority A',
    group: 'Task state',
    detail: 'set priority:: A',
    type: 'keyword',
    run: propCommand('Priority A', 'priority', 'A').run,
  },
  {
    label: 'Priority B',
    group: 'Task state',
    detail: 'set priority:: B',
    type: 'keyword',
    run: propCommand('Priority B', 'priority', 'B').run,
  },
  {
    label: 'Priority C',
    group: 'Task state',
    detail: 'set priority:: C',
    type: 'keyword',
    run: propCommand('Priority C', 'priority', 'C').run,
  },
  propCommand('Clear priority', 'priority', null),
  {
    label: 'Bold',
    group: 'Formatting',
    detail: '**text**',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '****', 2),
  },
  {
    label: 'Italic',
    group: 'Formatting',
    detail: '*text*',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '**', 1),
  },
  {
    label: 'Highlight',
    group: 'Formatting',
    detail: '==text==',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '====', 2),
  },
  {
    label: 'Query',
    group: 'Advanced',
    detail: '{{query (TODO)}} live results',
    type: 'keyword',
    run: (view, from, to) => replaceRange(view, from, to, '{{query (TODO)}}'),
  },
  {
    label: 'Query table',
    group: 'Advanced',
    detail: '{{query-table (TODO)}} with property columns',
    type: 'keyword',
    run: (view, from, to) => replaceRange(view, from, to, '{{query-table (TODO)}}'),
  },
  propCommand('Scheduled', 'scheduled', todayISO(), 'set scheduled:: today'),
  propCommand('Deadline', 'deadline', todayISO(), 'set deadline:: today'),
  {
    label: 'Current page',
    group: 'Templates',
    detail: '<% current page %> expands on commit',
    type: 'keyword',
    run: (view, from, to) => replaceRange(view, from, to, '<% current page %>'),
  },
  {
    label: 'Yesterday',
    group: 'Templates',
    detail: '<% yesterday %> expands on commit',
    type: 'keyword',
    run: (view, from, to) => replaceRange(view, from, to, '<% yesterday %>'),
  },
  {
    label: 'Tomorrow',
    group: 'Templates',
    detail: '<% tomorrow %> expands on commit',
    type: 'keyword',
    run: (view, from, to) => replaceRange(view, from, to, '<% tomorrow %>'),
  },
  {
    label: 'Now',
    group: 'Templates',
    detail: '<% now %> expands on commit',
    type: 'keyword',
    run: (view, from, to) => replaceRange(view, from, to, '<% now %>'),
  },
  // ---- Structure commands (block-model; Logseq md parity) ----
  {
    label: 'Indent block',
    group: 'Structure',
    detail: 'nest under the block above (Tab)',
    type: 'keyword',
    needsBlock: true,
    run: (view, from, to, host) => {
      replaceRange(view, from, to, '');
      const b = host.focusedBlock;
      if (!b) return;
      host.handleTabFromCommand(false);
    },
  },
  {
    label: 'Outdent block',
    group: 'Structure',
    detail: 'move one level up (Shift+Tab)',
    type: 'keyword',
    needsBlock: true,
    run: (view, from, to, host) => {
      replaceRange(view, from, to, '');
      const b = host.focusedBlock;
      if (!b) return;
      host.handleTabFromCommand(true);
    },
  },
  {
    label: 'New block below',
    group: 'Structure',
    detail: 'insert a sibling after this block',
    type: 'keyword',
    needsBlock: true,
    run: (view, from, to, host) => {
      replaceRange(view, from, to, '');
      const b = host.focusedBlock;
      if (!b) return;
      host.handleEnterFromCommand();
    },
  },
  {
    label: 'Delete block',
    group: 'Structure',
    detail: 'remove this block (children move up)',
    type: 'keyword',
    needsBlock: true,
    run: (view, from, to, host) => {
      replaceRange(view, from, to, '');
      host.deleteFocusedBlock();
    },
  },
  {
    label: 'Open in native editor',
    group: 'Structure',
    detail: 'switch this file to the native markdown editor',
    type: 'keyword',
    needsBlock: true,
    run: (view, from, to, host) => {
      replaceRange(view, from, to, '');
      // Commit through the normal pipeline, then swap the leaf's view type.
      window.setTimeout(() => {
        const leaf = host.leaf;
        const state = leaf?.view.getState();
        const file = (state?.state as { file?: string } | undefined)?.file;
        if (leaf && file) {
          void leaf.setViewState({ type: 'markdown', state: { file }, active: true } as never);
        }
      }, 30);
    },
  },
  {
    label: 'Link to page',
    group: 'Insert',
    detail: 'insert [[wiki link]]',
    type: 'text',
    run: (view, from, to) => replaceRange(view, from, to, '[[', 2),
  },
];

export function slashMenuSource(host: BlockEditorView, embed = false): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/(?:^|\s)\/[\w-]*$/);
    if (!before) return null;
    const slashIdx = before.text.lastIndexOf('/');
    const query = before.text.slice(slashIdx + 1).toLowerCase();
    const from = before.from + slashIdx;
    const options: Completion[] = [];
    for (const c of COMMANDS) {
      if (embed && c.needsBlock) continue; // block-model commands need the outline editor
      if (query && !c.label.toLowerCase().includes(query)) continue;
      options.push({
        ...c,
        apply: (view, _c, f, t) => c.run(view, f, t, host),
      });
    }
    if (options.length === 0) return null;
    return { from, options, validFor: /(?:^|\s)\/[\w-]*$/ };
  };
}
