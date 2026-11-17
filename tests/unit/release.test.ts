import { describe, expect, it } from 'vitest';
import {
	nextRebuildVersion,
	nextVersion,
	resolveReleasePlan,
	validTitle
} from '../../scripts/release.mjs';

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
	it('does not treat a commit example in the body as a breaking subject', () => {
		expect(
			nextVersion('v1.4.9', ['docs: explain titles\n\nFor example:\nfix!: replace the API'])
		).toBe('1.4.10');
	});
	it('rejects malformed versions and empty releases', () => {
		expect(() => nextVersion('v01.2.3', ['fix: bug'])).toThrow();
		expect(() => nextVersion('v1.2.3', [])).toThrow();
		expect(() => nextRebuildVersion('v01.2.3')).toThrow();
	});
	it('requires a single-line conventional PR title', () => {
		expect(validTitle('fix(capture): keep the photograph')).toBe(true);
		expect(validTitle('feat!: replace the API')).toBe(true);
		expect(validTitle('update things')).toBe(false);
		expect(validTitle('fix: valid\nmalicious second line')).toBe(false);
		expect(validTitle('fix: ')).toBe(false);
	});
	it('bumps patch versions for OS rebuilds only when already released', async () => {
		expect(nextRebuildVersion(null)).toBe('0.1.0');
		expect(nextRebuildVersion('v0.2.0')).toBe('0.2.1');
		await expect(
			resolveReleasePlan({
				tags: ['v0.1.0', 'v0.2.0'],
				sameCommitTags: ['v0.2.0'],
				hasRelease: async () => true,
				getMessages: () => []
			})
		).resolves.toEqual({ publish: false });
		await expect(
			resolveReleasePlan({
				tags: ['v0.1.0', 'v0.2.0'],
				sameCommitTags: ['v0.2.0'],
				hasRelease: async () => true,
				getMessages: () => [],
				rebuild: true
			})
		).resolves.toEqual({ publish: true, version: '0.2.1', tag: 'v0.2.1' });
		await expect(
			resolveReleasePlan({
				tags: ['v0.1.0', 'v0.2.0', 'v0.2.1'],
				sameCommitTags: ['v0.2.0', 'v0.2.1'],
				hasRelease: async (tag) => tag === 'v0.2.0' || tag === 'v0.2.1',
				getMessages: () => [],
				rebuild: true
			})
		).resolves.toEqual({ publish: true, version: '0.2.2', tag: 'v0.2.2' });
		await expect(
			resolveReleasePlan({
				tags: ['v0.1.0', 'v0.2.0', 'v0.2.1'],
				sameCommitTags: ['v0.2.0', 'v0.2.1'],
				hasRelease: async (tag) => tag === 'v0.2.0',
				getMessages: () => [],
				rebuild: true
			})
		).resolves.toEqual({ publish: true, version: '0.2.1', tag: 'v0.2.1' });
		await expect(
			resolveReleasePlan({
				tags: ['v0.1.0', 'v0.2.1'],
				sameCommitTags: [],
				hasRelease: async () => true,
				getMessages: () => ['feat: add wish notes'],
				rebuild: true
			})
		).resolves.toEqual({ publish: true, version: '0.3.0', tag: 'v0.3.0' });
	});
});
