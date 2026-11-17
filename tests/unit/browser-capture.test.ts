import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftStore } from '../../src/lib/client/drafts';
import { parseBrowserCapture, importBrowserCapture } from '../../src/lib/client/browser-capture';

const payload = {
	version: 1,
	sourceUrl: 'https://www.smythstoys.com/uk/en-gb/toy/p/266502',
	title: 'Browser toy',
	description: 'Visible product details',
	imageUrl: 'https://images.example/toy.jpg',
	priceText: '£49.95',
	currency: 'GBP',
	fromPrice: false
};
const hash = (value: unknown) => '#gift=' + encodeURIComponent(JSON.stringify(value));
const databases: string[] = [];
afterEach(async () => {
	for (const name of databases.splice(0)) await Dexie.delete(name);
});
function store() {
	const name = 'browser-capture-' + crypto.randomUUID();
	databases.push(name);
	return new DraftStore(name);
}

describe('browser product captures', () => {
	it('keeps a browser capture unbound despite remembered identity and ignores supplied ownership or lists', async () => {
		const db = store();
		await db.remember({
			id: 'person-a',
			name: 'Person A',
			email: 'a@example.test',
			member: true,
			siteRole: 'administrator',
			superAdministrator: true,
			administrator: true,
			collaborator: true,
			buyer: true,
			canCapture: true,
			lists: []
		});
		const record = await importBrowserCapture(
			hash({ ...payload, ownerId: 'person-a', listIds: ['private-list'] }),
			db
		);
		expect(record.ownerId).toBeNull();
		expect(record.draft).toMatchObject({
			title: 'Browser toy',
			estimate: '49.95',
			listIds: [],
			browserCapture: { imageUrl: 'https://images.example/toy.jpg', pendingReview: true }
		});
		expect(record.draft.offers[0]).toMatchObject({
			retailer: 'Smyths',
			price: '49.95',
			currency: 'GBP'
		});
		expect(record.draft.sourceText).toContain('Captured from your browser');
		expect(await db.list('person-a')).toEqual([]);
		await db.adopt(record.id, {
			id: 'person-a',
			name: 'Person A',
			email: 'a@example.test',
			member: true,
			siteRole: 'administrator',
			superAdministrator: true,
			administrator: true,
			collaborator: true,
			buyer: true,
			canCapture: true,
			lists: []
		});
		expect(await db.claim(record.id, 'person-a')).toBeUndefined();
		const adopted = (await db.get(record.id, 'person-a'))!;
		expect(adopted.draft.browserCapture?.pendingReview).toBe(true);
		adopted.draft.browserCapture!.pendingReview = false;
		await db.save({ id: record.id, ownerId: 'person-a', draft: adopted.draft, photos: [] });
		expect(await db.claim(record.id, 'person-a')).toMatchObject({ status: 'syncing' });
		db.close();
	});
	it('does not treat from-prices, missing currency or foreign minor units as exact GBP estimates', () => {
		expect(parseBrowserCapture(hash({ ...payload, fromPrice: true })).estimate).toBe('');
		expect(parseBrowserCapture(hash({ ...payload, currency: '' })).estimate).toBe('');
		const foreign = parseBrowserCapture(hash({ ...payload, priceText: '1500', currency: 'JPY' }));
		expect(foreign.estimate).toBe('');
		expect(foreign.offers[0]).toMatchObject({ price: '1500', currency: 'JPY' });
		expect(parseBrowserCapture(hash({ ...payload, priceText: '£0.00' })).estimate).toBe('0.00');
	});
	it('rejects unsupported or credential-bearing sources and discards unsafe photo URLs', () => {
		for (const sourceUrl of [
			'https://evil.example/product',
			'https://constructor/',
			'https://__proto__/',
			'http://www.smythstoys.com/uk/toy/p/266502',
			'https://person:password@www.smythstoys.com/uk/toy/p/266502'
		])
			expect(() => parseBrowserCapture(hash({ ...payload, sourceUrl }))).toThrow('invalid');
		expect(
			parseBrowserCapture(hash({ ...payload, imageUrl: 'javascript:alert(1)' })).browserCapture
				?.imageUrl
		).toBe('');
	});
	it('rejects malformed or oversized captures before storing a partial draft', async () => {
		const db = store();
		for (const value of [
			'#gift=%broken',
			hash(null),
			hash({ ...payload, version: 2 }),
			hash({ ...payload, title: 'x'.repeat(501) }),
			'#gift=' + 'x'.repeat(64001)
		])
			await expect(importBrowserCapture(value, db)).rejects.toThrow('invalid');
		expect(await db.list(null)).toEqual([]);
		db.close();
	});
});
