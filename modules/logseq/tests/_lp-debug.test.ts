import { it } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { collectLivePreview } from '../src/editor/livePreview';

it('debug2', () => {
  const doc = 'see [[Page Name|Alias]] now';
  const specs = collectLivePreview(
    EditorState.create({ doc, selection: EditorSelection.cursor(doc.length) }),
  );
  console.log('ALL:', JSON.stringify(specs.map((s) => `${s.kind}[${s.from},${s.to}]`)));
  const joined = specs
    .filter((s) => s.kind !== 'table:head' && s.kind !== 'table:row' && s.kind !== 'table:delim')
    .filter((s) => s.from !== s.to && !s.kind.endsWith(':mark'))
    .map((s) => doc.slice(s.from, s.to))
    .join('');
  console.log('JOINED:', JSON.stringify(joined));
  console.log('DOCLEN:', doc.length, 'SLICE21_23:', JSON.stringify(doc.slice(21, 23)));
});
