/**
 * The Material Icon Theme bridge.
 *
 * The theme decorates Obsidian's own explorer rows and will NOT touch ours
 * (measured: a row built with its class names and a real vault data-path came
 * back untouched), so we ask it for the SVG instead. What matters here is the
 * degradation: a missing theme, a renamed method, a throw, or an empty result
 * must all fall back to the caller's marker rather than break the tree.
 */

import { describe, expect, it } from 'vitest';
import {
  decideIcon,
  hasIconTheme,
  iconSvgFor,
} from '../src/features/iconTheme';

const SVG = '<svg viewBox="0 0 16 16"><path d="M2 2h12v12H2z"/></svg>';

/** A fake registry shaped like the real one. */
function appWith(theme: unknown | null): unknown {
  return { plugins: { plugins: theme ? { 'material-icon-theme': theme } : {} } };
}

const opts = (over: Partial<Parameters<typeof decideIcon>[1]> = {}) => ({
  name: 'index.ts',
  isDir: false,
  mountPath: 'D:\\notes',
  rel: 'sub/index.ts',
  fallback: '📄',
  ...over,
});

describe('iconSvgFor — asking the theme for an icon', () => {
  it('returns the svg the theme produced', () => {
    const app = appWith({ getFileIconSvg: () => SVG });
    expect(iconSvgFor(app, 'index.ts')).toBe(SVG);
  });

  it('returns null when the theme is not installed', () => {
    expect(iconSvgFor(appWith(null), 'index.ts')).toBeNull();
    expect(iconSvgFor(null, 'index.ts')).toBeNull();
    expect(iconSvgFor(undefined, 'index.ts')).toBeNull();
  });

  it('returns null when the method is gone — a renamed API is not an error', () => {
    expect(iconSvgFor(appWith({}), 'index.ts')).toBeNull();
  });

  it('survives a theme that throws on an odd path', () => {
    const app = appWith({
      getFileIconSvg: () => {
        throw new Error('boom');
      },
    });
    expect(iconSvgFor(app, 'weird')).toBeNull();
  });

  it('rejects a non-svg result rather than injecting junk into the DOM', () => {
    expect(iconSvgFor(appWith({ getFileIconSvg: () => undefined }), 'a.md')).toBeNull();
    expect(iconSvgFor(appWith({ getFileIconSvg: () => '<div>not an svg</div>' }), 'a.md')).toBeNull();
  });
});

describe('hasIconTheme — the capability check', () => {
  it('is true only when the method is actually callable', () => {
    expect(hasIconTheme(appWith({ getFileIconSvg: () => SVG }))).toBe(true);
    expect(hasIconTheme(appWith({}))).toBe(false);
    expect(hasIconTheme(appWith(null))).toBe(false);
  });

  it('finds the theme through the older internalPlugins registry too', () => {
    const app = { internalPlugins: { plugins: { 'material-icon-theme': { getFileIconSvg: () => SVG } } } };
    expect(hasIconTheme(app)).toBe(true);
  });
});

describe('decideIcon — what the row should show', () => {
  it('uses the theme svg for a file', () => {
    const d = decideIcon(appWith({ getFileIconSvg: () => SVG }), opts());
    expect(d.svg).toBe(SVG);
    expect(d.themed).toBe(true);
  });

  it('asks with the mount-relative path first, so directory-scoped rules apply', () => {
    const asked: string[] = [];
    const app = appWith({
      getFileIconSvg: (p: string) => {
        asked.push(p);
        return p.includes('/') ? SVG : null;
      },
    });
    decideIcon(app, opts());
    expect(asked[0]).toBe('sub/index.ts');
  });

  it('falls back to the caller marker when no theme is installed', () => {
    const d = decideIcon(appWith(null), opts());
    expect(d.svg).toBeNull();
    expect(d.fallback).toBe('📄');
    expect(d.themed).toBe(false);
  });

  it('asks the theme for a folder icon through its three-step lookup', () => {
    // Folders need getFolderIconKey -> getIconSet -> getSvg; asking the file
    // lookup instead would return a FILE glyph for a directory.
    const seen: string[] = [];
    const app = appWith({
      getFolderIconKey: (p: string) => {
        seen.push('key:' + p);
        return 'folder-src';
      },
      getIconSet: (k: string) => {
        seen.push('set:' + k);
        return { dark: SVG, light: SVG };
      },
      getSvg: () => SVG,
    });
    const d = decideIcon(app, opts({ name: 'src', isDir: true, rel: 'src', fallback: '📁' }));
    expect(d.themed).toBe(true);
    expect(d.svg).toBe(SVG);
    // The theme matches folder icons on the NAME.
    expect(seen).toEqual(['key:src', 'set:folder-src']);
  });

  it('passes the collapsed state so an open folder can differ from a closed one', () => {
    const seen: boolean[] = [];
    const app = appWith({
      getFolderIconKey: (_p: string, collapsed: boolean) => {
        seen.push(collapsed);
        return 'k';
      },
      getIconSet: () => ({ dark: SVG, light: SVG }),
      getSvg: () => SVG,
    });
    decideIcon(app, opts({ name: 'sub', isDir: true, rel: 'sub', collapsed: false }));
    decideIcon(app, opts({ name: 'sub', isDir: true, rel: 'sub', collapsed: true }));
    expect(seen).toEqual([false, true]);
  });

  it('falls back to the folder marker when any step of the lookup is missing', () => {
    // A build that drops getIconSet cannot resolve a key, so we must degrade
    // rather than inject a broken icon.
    const partial = appWith({ getFolderIconKey: () => 'k', getSvg: () => SVG });
    const d = decideIcon(partial, opts({ name: 'sub', isDir: true, rel: 'sub', fallback: '📁' }));
    expect(d.svg).toBeNull();
    expect(d.fallback).toBe('📁');
  });

  it('falls back to the folder marker when the theme throws', () => {
    const app = appWith({
      getFolderIconKey: () => {
        throw new Error('boom');
      },
    });
    expect(decideIcon(app, opts({ name: 'sub', isDir: true, rel: 'sub' })).themed).toBe(false);
  });

  it('normalizes backslashes so a Windows-style rel still matches scoped rules', () => {
    const asked: string[] = [];
    const app = appWith({
      getFileIconSvg: (p: string) => {
        asked.push(p);
        return null;
      },
    });
    decideIcon(app, opts({ rel: 'a\\b\\c.md' }));
    expect(asked[0]).toBe('a/b/c.md');
  });
});
