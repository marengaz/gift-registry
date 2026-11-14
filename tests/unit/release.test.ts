import { describe, expect, it } from 'vitest';
import { nextVersion, validTitle } from '../../scripts/release.mjs';

describe('automatic release policy', () => {
	it('starts at 0.1.0 and releases maintenance changes as patches', () => {
		expect(nextVersion(null, ['ci: publish releases'])).toBe('0.1.0');
		expect(nextVersion('v0.1.0', ['docs: document the image'])).toBe('0.1.1');
	});
	it('uses the largest change across the entire unreleased range', () => {
		expect(nextVersion('v1.4.9', ['fix: a bug', 'feat(lists): add sharing'])).toBe('1.5.0');
		expect(nextVersion('v1.4.9', ['feat: add sharing', 'fix(auth)!: replace sessions'])).toBe(
			'2.0.0'
		);
		expect(
			nextVersion('v0.4.9', ['refactor: change API\n\nBREAKING CHANGE: remove the old API'])
		).toBe('1.0.0');
	});
	it('rejects malformed versions and empty releases', () => {
		expect(() => nextVersion('v01.2.3', ['fix: bug'])).toThrow();
		expect(() => nextVersion('v1.2.3', [])).toThrow();
	});
	it('requires a single-line conventional PR title', () => {
		expect(validTitle('fix(capture): keep the photograph')).toBe(true);
		expect(validTitle('feat!: replace the API')).toBe(true);
		expect(validTitle('update things')).toBe(false);
		expect(validTitle('fix: valid\nmalicious second line')).toBe(false);
		expect(validTitle('fix: ')).toBe(false);
	});
});
