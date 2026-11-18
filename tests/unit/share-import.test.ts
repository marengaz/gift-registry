import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftStore } from '../../src/lib/client/drafts';
import { importShare, parseShare } from '../../src/lib/client/share-import';

const databases: string[] = [];
afterEach(async () => {
	for (const name of databases.splice(0)) await Dexie.delete(name);
});
function store() {
	const name = `share-test-${crypto.randomUUID()}`;
	databases.push(name);
	return new DraftStore(name);
}
function form(values: Record<string, string>) {
	const data = new FormData();
	for (const [key, value] of Object.entries(values)) data.set(key, value);
	return data;
}
describe('incoming shares', () => {
	it('finds a URL in Android text or title and keeps the original evidence', () => {
		const shared = parseShare(
			form({ title: 'Wooden train', text: 'Look at this: https://shop.example/train?size=small.' })
		);
		expect(shared.draft.title).toBe('Wooden train');
		expect(shared.draft.sourceUrl).toBe('https://shop.example/train?size=small');
		expect(shared.draft.sourceText).toContain(
			'Look at this: https://shop.example/train?size=small.'
		);
		expect(parseShare(form({ title: 'https://shop.example/train' })).draft.sourceUrl).toBe(
			'https://shop.example/train'
		);
		expect(parseShare(form({ text: 'A train without a link' })).draft.sourceText).toBe(
			'A train without a link'
		);
	});
	it('prefers an explicit web URL and leaves unsafe links as editable text', () => {
		const shared = parseShare(
			form({ url: 'https://shop.example/first', text: 'https://shop.example/second' })
		);
		expect(shared.draft.sourceUrl).toBe('https://shop.example/first');
		expect(parseShare(form({ url: 'javascript:alert(1)' })).draft.sourceUrl).toBe('');
	});
	it('commits an unbound photo draft despite a previously remembered signed-in account', async () => {
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
		const data = form({ title: 'Window display', text: 'A shop photo' });
		data.append('photos', new File(['photo bytes'], 'window.jpg', { type: 'image/jpeg' }));
		const imported = await importShare(data, db);
		expect(imported.ownerId).toBeNull();
		expect(imported.readyToSync).toBe(false);
		expect((await db.get(imported.id, null))?.draft.title).toBe('Window display');
		expect(await (await db.files(imported.id, null))[0].text()).toBe('photo bytes');
		expect(await db.list('person-a')).toEqual([]);
		db.close();
	});
	it('rejects unsupported files or an empty share without leaving a partial draft', async () => {
		const db = store();
		const data = form({ text: 'Keep this source' });
		data.append('photos', new File(['<svg/>'], 'drawing.svg', { type: 'image/svg+xml' }));
		await expect(importShare(data, db)).rejects.toThrow(/JPEG|PNG|WebP|supported/i);
		await expect(importShare(new FormData(), db)).rejects.toThrow(/empty|nothing|content/i);
		expect(await db.list(null)).toEqual([]);
		db.close();
	});
	it('accepts image/jpg and parameterized MIME types from Android share intents', async () => {
		const db = store();
		const jpgData = form({ title: 'Camera JPG' });
		jpgData.append('photos', new File(['jpg bytes'], 'camera-photo', { type: 'IMAGE/JPG' }));
		const jpgImported = await importShare(jpgData, db);
		expect(jpgImported.ownerId).toBeNull();
		expect(await (await db.files(jpgImported.id, null))[0].text()).toBe('jpg bytes');

		const paramData = form({ title: 'Parameterized JPEG' });
		paramData.append(
			'photos',
			new File(['jpeg bytes'], 'gallery.jpeg', { type: 'image/jpeg; charset=binary' })
		);
		const paramImported = await importShare(paramData, db);
		expect(await (await db.files(paramImported.id, null))[0].text()).toBe('jpeg bytes');

		const fallbackData = form({ title: 'Octet stream JPEG' });
		fallbackData.append(
			'photos',
			new File(['octet bytes'], 'IMG_001.JPG', { type: 'application/octet-stream' })
		);
		const fallbackImported = await importShare(fallbackData, db);
		expect(await (await db.files(fallbackImported.id, null))[0].text()).toBe('octet bytes');
		db.close();
	});
	it('does not report a saved import when the local transaction fails', async () => {
		const db = store();
		db.blobs.hook('creating', () => {
			throw new DOMException('Storage full', 'QuotaExceededError');
		});
		const data = form({ title: 'Photo' });
		data.append('photos', new File(['image'], 'photo.png', { type: 'image/png' }));
		await expect(importShare(data, db)).rejects.toThrow('Storage full');
		expect(await db.list(null)).toEqual([]);
		db.close();
	});
});
