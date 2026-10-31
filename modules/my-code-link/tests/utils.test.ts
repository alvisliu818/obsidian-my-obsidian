import { describe, it, expect } from 'vitest';
import { dedent, lineWindow } from '../src/utils/index';

describe('dedent', () => {
	it('should remove common leading whitespace', () => {
		const input = `
    line1
    line2
    `;
		const expected = `
line1
line2
`;
		expect(dedent(input)).toBe(expected);
	});

	it('should handle mixed indentation levels', () => {
		const input = `
    line1
      line2
    line3
`;
		const expected = `
line1
  line2
line3
`;
		expect(dedent(input)).toBe(expected);
	});

	it('should handle blank lines', () => {
		const input = `
    line1

    line2
    `;
		const expected = `
line1

line2
`;
		expect(dedent(input)).toBe(expected);
	});

	it('should handle whitespace-only lines by normalizing them to empty', () => {
		const input = '    line1\n    \n    line2';
		const expected = 'line1\n\nline2';
		expect(dedent(input)).toBe(expected);
	});

	it('should not remove whitespace if no common indent exists', () => {
		const input = 'line1\n  line2';
		expect(dedent(input)).toBe(input);
	});

	it('should handle tabs correctly', () => {
		const input = '\t\tline1\n\t\tline2';
		const expected = 'line1\nline2';
		expect(dedent(input)).toBe(expected);
	});

	it('should handle mix of tabs and spaces as separate characters (Python behavior)', () => {
		const input = '  line1\n\tline2';
		// No common leading whitespace because space != tab
		expect(dedent(input)).toBe(input);
	});

	it('should handle empty string', () => {
		expect(dedent('')).toBe('');
	});

	it('should handle whitespace-only string', () => {
		expect(dedent('  \n  ')).toBe('\n');
	});
});

describe('lineWindow', () => {
	const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');

	it('should center the window on the target line with 1-based numbers', () => {
		const out = lineWindow(text, 15);
		const lines = out.split('\n');
		expect(lines).toHaveLength(11); // ±5 + target
		expect(lines[5]).toBe('15 | line 15');
		expect(lines[0]).toBe('10 | line 10');
		expect(lines[10]).toBe('20 | line 20');
	});

	it('should clamp near the file start', () => {
		const out = lineWindow(text, 1);
		const lines = out.split('\n');
		expect(lines[0]).toBe('1 | line 1');
		expect(lines).toHaveLength(6); // 1..6
	});

	it('should clamp beyond EOF', () => {
		const out = lineWindow(text, 999);
		const lines = out.split('\n');
		expect(lines[lines.length - 1]).toBe('30 | line 30');
		expect(lines).toHaveLength(6); // 25..30
	});

	it('should pad line numbers for alignment', () => {
		const out = lineWindow('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl', 6);
		expect(out.split('\n')[0]).toBe(' 1 | a');
	});

	it('should preserve indentation (no dedent)', () => {
		const out = lineWindow('    indented line', 1);
		expect(out).toBe('1 |     indented line');
	});
});
