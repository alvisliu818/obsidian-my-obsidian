/**
 * Command search scoring (batch 34, SiYuan command/search.ts 1:1).
 *
 * normalize: NFKC fold + camelCase split + separator→space + lowercase;
 * fields: every searchable text plus its space-stripped variant (so "bc"
 * still matches "Bold Code" via "boldcode"); score: every token must hit
 * SOME field, then exact=300 / prefix=200 / includes=100; ties keep the
 * original order (stable sort by index).
 */

export interface SearchableCommand {
  label: string;
  group?: string;
  detail?: string;
  id?: string;
  keywords?: string[];
}

export function normalizeCommandSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[._:/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getSearchFields(command: SearchableCommand): string[] {
  const normalizedFields = [
    command.label,
    command.group ?? '',
    command.detail ?? '',
    command.id ?? '',
    ...(command.keywords ?? []),
  ]
    .map(normalizeCommandSearchText)
    .filter(Boolean);
  return [...new Set(normalizedFields.flatMap((field) => [field, field.replace(/ /g, '')]))];
}

function getScore(fields: string[], query: string, tokens: string[]): number {
  if (!query) {
    return 0;
  }
  if (!tokens.every((token) => fields.some((field) => field.includes(token)))) {
    return -1;
  }
  if (fields.some((field) => field === query)) {
    return 300;
  }
  if (fields.some((field) => field.startsWith(query))) {
    return 200;
  }
  return 100;
}

export function searchCommands<T extends SearchableCommand>(commands: T[], value: string): T[] {
  const query = normalizeCommandSearchText(value);
  const tokens = query.split(' ').filter(Boolean);
  return commands
    .map((command, index) => ({ command, index, score: getScore(getSearchFields(command), query, tokens) }))
    .filter((item) => item.score >= 0)
    .sort((first, second) => second.score - first.score || first.index - second.index)
    .map((item) => item.command);
}
