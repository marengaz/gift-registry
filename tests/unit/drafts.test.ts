import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftStore } from '../../src/lib/client/drafts';
import { refreshCaptureIdentity, syncDrafts } from '../../src/lib/client/sync';
import { emptyDraft, type Identity } from '../../src/lib/catalogue-types';
const names: string[] = [];
function store(name = crypto.randomUUID()) {
	names.push(name);
	return new DraftStore(name);
}
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	for (const name of names.splice(0)) await Dexie.delete(name);
});
const draft = () => ({ ...emptyDraft(), title: 'A train', listIds: ['birthday'] });
const person = (id: string): Identity => ({
	id,
	name: id,
	email: `${id}@example.test`,
	member: true,
	administrator: true,
	lists: []
});
describe('durable capture drafts', () => {
	it('commits metadata, photo blobs and stable operation ID together, and reopens them', async () => {
		const first = store();
		const record = await first.save({
			ownerId: 'a',
			draft: draft(),
			photos: [new File(['photo bytes'], 'train.png', { type: 'image/png' })]
		});
		first.close();
		const reopened = new DraftStore(first.name);
		const restored = await reopened.get(record.id, 'a');
		expect(restored?.operationId).toBe(record.operationId);
		expect(restored?.draft.listIds).toEqual(['birthday']);
		expect(await (await reopened.files(record.id, 'a'))[0].text()).toBe('photo bytes');
		reopened.close();
	});
	it('never lists or adopts another account’s drafts and explicitly adopts unbound imports', async () => {
		const db = store();
		const a = await db.save({ ownerId: 'a', draft: draft(), photos: [] });
		const unbound = await db.save({ ownerId: null, draft: draft(), photos: [] });
		expect(await db.list('b')).toEqual([]);
		expect(await db.get(a.id, 'b')).toBeUndefined();
		await expect(db.adopt(a.id, person('b'))).rejects.toThrow();
		expect((await db.adopt(unbound.id, person('b'))).ownerId).toBe('b');
		expect(await db.get(unbound.id, null)).toBeUndefined();
		db.close();
	});
	it('freezes an attempted payload and obtains a durable single-uploader lease', async () => {
		const db = store();
		const value = await db.save({ ownerId: 'a', draft: draft(), photos: [] });
		const attempted = await db.claim(value.id, 'a');
		expect(attempted?.payload.title).toBe('A train');
		expect(await db.claim(value.id, 'a')).toBeUndefined();
		await expect(
			db.save({ id: value.id, ownerId: 'a', draft: { ...draft(), title: 'Edited' }, photos: [] })
		).rejects.toThrow(/retry|attempt|synchron/i);
		await db.release(value.id, 'a', 'Response lost');
		const retry = await db.claim(value.id, 'a');
		expect(retry?.operationId).toBe(value.operationId);
		expect(retry?.payload).toEqual(attempted?.payload);
		db.close();
	});
	it('propagates a quota failure without acknowledging a partial local save', async () => {
		const db = store();
		db.blobs.hook('creating', () => {
			throw new DOMException('Storage full', 'QuotaExceededError');
		});
		await expect(
			db.save({ ownerId: 'a', draft: draft(), photos: [new File(['x'], 'x.png')] })
		).rejects.toThrow('Storage full');
		expect(await db.list('a')).toEqual([]);
		db.close();
	});
	it('upgrades a previous outbox without losing pending metadata, blobs or operation IDs', async () => {
		const name = crypto.randomUUID();
		names.push(name);
		const old = new Dexie(name);
		old.version(1).stores({
			drafts: 'id,ownerKey,status,updatedAt',
			blobs: '[draftId+position],draftId',
			context: 'id'
		});
		const operationId = crypto.randomUUID();
		await old.table('drafts').put({
			id: 'pending',
			ownerId: 'a',
			ownerKey: 'a',
			operationId,
			draft: draft(),
			status: 'local',
			updatedAt: 1,
			createdAt: 1
		});
		await old.table('blobs').put({
			draftId: 'pending',
			position: 0,
			blob: new Blob(['legacy']),
			name: 'old.png',
			type: 'image/png',
			lastModified: 1
		});
		old.close();
		const upgraded = new DraftStore(name);
		expect((await upgraded.get('pending', 'a'))?.operationId).toBe(operationId);
		expect(await (await upgraded.files('pending', 'a'))[0].text()).toBe('legacy');
		upgraded.close();
	});
	it('refreshes identity before sending and preserves a draft under an account switch', async () => {
		const db = store();
		await db.remember(person('a'));
		const value = await db.save({ ownerId: 'a', draft: draft(), photos: [] });
		const sent: string[] = [];
		await syncDrafts(
			db,
			async (url) => {
				sent.push(String(url));
				return Response.json(person('b'));
			},
			'a'
		);
		expect(sent).toEqual(['/api/me']);
		expect((await db.get(value.id, 'a'))?.status).not.toBe('saved');
		expect(await db.list('b')).toEqual([]);
		db.close();
	});
	it('retries an ambiguous lost response using the original operation and only acknowledges a server response', async () => {
		const db = store();
		const value = await db.save({ ownerId: 'a', draft: draft(), photos: [] });
		const operations: string[] = [];
		let fail = true;
		const transport: typeof fetch = async (url, init) => {
			if (url === '/api/me') return Response.json(person('a'));
			const body = init?.body as FormData;
			operations.push(String(body.get('operationId')));
			if (fail) {
				fail = false;
				throw new TypeError('response lost');
			}
			return Response.json({
				operationId: value.operationId,
				productId: 'saved-product',
				entryIds: ['entry']
			});
		};
		await syncDrafts(db, transport, 'a');
		expect((await db.get(value.id, 'a'))?.status).toBe('needsattention');
		await syncDrafts(db, transport, 'a');
		expect(operations).toEqual([value.operationId, value.operationId]);
		expect((await db.get(value.id, 'a'))?.ack?.productId).toBe('saved-product');
		db.close();
	});
});

describe('unfinished capture drafts', () => {
	it('keeps unfinished drafts across reopening without uploading until an explicit save', async () => {
		const db = store();
		await db.remember(person('a'));
		const kept = await db.save({ ownerId: 'a', draft: draft(), photos: [], submit: false });
		db.close();
		const reopened = new DraftStore(db.name);
		expect((await reopened.get(kept.id, 'a'))?.readyToSync).toBe(false);
		const requests: string[] = [];
		await syncDrafts(reopened, async (url) => {
			requests.push(String(url));
			return Response.json(person('a'));
		});
		expect(requests).toEqual(['/api/me']);
		expect((await reopened.get(kept.id, 'a'))?.attemptedAt).toBeUndefined();
		const submitted = await reopened.save({
			id: kept.id,
			ownerId: 'a',
			draft: draft(),
			photos: [],
			submit: true
		});
		expect(submitted.operationId).toBe(kept.operationId);
		expect(await reopened.claim(kept.id, 'a')).toMatchObject({ status: 'syncing' });
		reopened.close();
	});
	it('does not let account adoption publish an unfinished share', async () => {
		const db = store();
		const kept = await db.save({ ownerId: null, draft: draft(), photos: [], submit: false });
		await db.adopt(kept.id, person('a'));
		expect((await db.get(kept.id, 'a'))?.readyToSync).toBe(false);
		expect(await db.claim(kept.id, 'a')).toBeUndefined();
		db.close();
	});
	it('continues to send legacy explicitly saved drafts without a readiness field', async () => {
		const db = store();
		const kept = await db.save({ ownerId: 'a', draft: draft(), photos: [] });
		await db.drafts.update(kept.id, { readyToSync: undefined });
		expect(await db.claim(kept.id, 'a')).toMatchObject({ operationId: kept.operationId });
		db.close();
	});
});

describe('continuing an idea with incoming material', () => {
	it('appends incoming evidence and photos while retaining target details, lists and operation', async () => {
		const db = store();
		await db.remember(person('a'));
		const target = await db.save({
			ownerId: 'a',
			draft: {
				...draft(),
				sourceUrl: 'https://shop.example/train',
				sourceText: 'Original evidence',
				description: 'My carefully edited description'
			},
			photos: [new File(['original photo'], 'original.jpg', { type: 'image/jpeg' })],
			submit: false
		});
		const incoming = await db.save({
			ownerId: null,
			draft: {
				...emptyDraft(),
				title: 'Screenshot of the train',
				sourceUrl: 'https://shop.example/second',
				sourceText: 'Original evidence'
			},
			photos: [new File(['new screenshot'], 'screen.png', { type: 'image/png' })],
			submit: false
		});
		const merged = await db.attachIncoming(incoming.id, target.id, 'a');
		expect(merged).toMatchObject({
			id: target.id,
			ownerId: 'a',
			operationId: target.operationId,
			readyToSync: false,
			draft: {
				title: 'A train',
				description: 'My carefully edited description',
				sourceUrl: 'https://shop.example/train',
				listIds: ['birthday']
			}
		});
		expect(merged.draft.sourceText.match(/Original evidence/g)).toHaveLength(1);
		expect(merged.draft.sourceText).toContain('https://shop.example/second');
		expect(merged.draft.sourceText).toContain('Screenshot of the train');
		const files = await db.files(target.id, 'a');
		expect(files.map((file) => file.name)).toEqual(['original.jpg', 'screen.png']);
		expect(await files[1].text()).toBe('new screenshot');
		expect(await db.get(incoming.id, null)).toBeUndefined();
		expect(await db.claim(target.id, 'a')).toBeUndefined();
		db.close();
	});
	it('fills only a missing source link without transferring an unbound draft to the remembered account', async () => {
		const db = store();
		await db.remember(person('a'));
		const target = await db.save({ ownerId: null, draft: draft(), photos: [], submit: false });
		const incoming = await db.save({
			ownerId: null,
			draft: { ...emptyDraft(), sourceUrl: 'https://shop.example/train' },
			photos: [],
			submit: false
		});
		const merged = await db.attachIncoming(incoming.id, target.id, null);
		expect(merged.ownerId).toBeNull();
		expect(merged.draft.sourceUrl).toBe('https://shop.example/train');
		expect(await db.list('a')).toEqual([]);
		db.close();
	});
	it('rolls the whole attachment back if storage cannot keep the added photo', async () => {
		const db = store();
		await db.remember(person('a'));
		const target = await db.save({ ownerId: 'a', draft: draft(), photos: [], submit: false });
		const incoming = await db.save({
			ownerId: null,
			draft: { ...emptyDraft(), sourceText: 'New evidence' },
			photos: [new File(['screenshot'], 'screen.png', { type: 'image/png' })],
			submit: false
		});
		db.blobs.hook('creating', (_key, value) => {
			if (value.draftId === target.id) throw new DOMException('Storage full', 'QuotaExceededError');
		});
		await expect(db.attachIncoming(incoming.id, target.id, 'a')).rejects.toThrow('Storage full');
		expect(await db.get(target.id, 'a')).toEqual(target);
		expect(await db.get(incoming.id, null)).toEqual(incoming);
		expect(await (await db.files(incoming.id, null))[0].text()).toBe('screenshot');
		expect(await db.files(target.id, 'a')).toEqual([]);
		db.close();
	});
	it('checks the current account again before attaching to an account-owned target', async () => {
		const db = store();
		await db.remember(person('a'));
		const target = await db.save({ ownerId: 'a', draft: draft(), photos: [], submit: false });
		const incoming = await db.save({ ownerId: null, draft: draft(), photos: [], submit: false });
		await db.remember(person('b'));
		await expect(db.attachIncoming(incoming.id, target.id, 'a')).rejects.toThrow(/account/i);
		expect(await db.get(incoming.id, null)).toBeDefined();
		expect(await db.get(target.id, 'a')).toEqual(target);
		db.close();
	});
	it('cannot consume incoming material that is already owned by another account', async () => {
		const db = store();
		await db.remember(person('a'));
		const target = await db.save({ ownerId: 'a', draft: draft(), photos: [], submit: false });
		const incoming = await db.save({ ownerId: 'b', draft: draft(), photos: [], submit: false });
		await expect(db.attachIncoming(incoming.id, target.id, 'a')).rejects.toThrow(/account/i);
		expect(await db.get(incoming.id, 'b')).toEqual(incoming);
		expect(await db.get(target.id, 'a')).toEqual(target);
		db.close();
	});
	it.each([
		{ name: 'an explicitly saved idea', submit: true, attempt: false },
		{ name: 'a frozen upload', submit: true, attempt: true }
	])('keeps both drafts when the target is $name', async ({ submit, attempt }) => {
		const db = store();
		await db.remember(person('a'));
		const target = await db.save({ ownerId: 'a', draft: draft(), photos: [], submit });
		if (attempt) await db.claim(target.id, 'a');
		const incoming = await db.save({ ownerId: null, draft: draft(), photos: [], submit: false });
		await expect(db.attachIncoming(incoming.id, target.id, 'a')).rejects.toThrow(
			/unfinished|saved|sending/i
		);
		expect(await db.get(incoming.id, null)).toBeDefined();
		expect((await db.get(target.id, 'a'))?.operationId).toBe(target.operationId);
		db.close();
	});
	it.each([
		{ backend: 'browser lock', fallback: false },
		{ backend: 'persisted fallback token', fallback: true }
	])('does not attach through another open editor using $backend', async ({ fallback }) => {
		if (fallback) vi.stubGlobal('navigator', {});
		const db = store();
		await db.remember(person('a'));
		const target = await db.save({ ownerId: 'a', draft: draft(), photos: [], submit: false });
		const incoming = await db.save({ ownerId: null, draft: draft(), photos: [], submit: false });
		const release = await db.lockEditor(target.id, 'a', 'another-editor');
		await expect(db.attachIncoming(incoming.id, target.id, 'a')).rejects.toThrow(/edited|tab/i);
		expect(await db.get(incoming.id, null)).toBeDefined();
		await release!();
		expect((await db.attachIncoming(incoming.id, target.id, 'a')).id).toBe(target.id);
		db.close();
	});
});

describe('sign-out coordination', () => {
	it('persists a sign-out pause so another tab cannot claim or edit drafts during logout', async () => {
		const db = store();
		await db.remember(person('a'));
		const record = await db.save({ ownerId: 'a', draft: draft(), photos: [] });
		await db.beginSignOut('a');
		const otherTab = new DraftStore(db.name);
		await otherTab.remember(person('a'));
		expect(await otherTab.claim(record.id, 'a')).toBeUndefined();
		await expect(otherTab.save({ ownerId: 'a', draft: draft(), photos: [] })).rejects.toThrow(
			/sign.out/i
		);
		await db.endSignOut('a');
		expect(await otherTab.claim(record.id, 'a')).toBeDefined();
		otherTab.close();
		db.close();
	});
	it('refuses to sign out while an upload could still be running', async () => {
		const db = store();
		await db.remember(person('a'));
		const record = await db.save({ ownerId: 'a', draft: draft(), photos: [] });
		await db.claim(record.id, 'a');
		await expect(db.beginSignOut('a')).rejects.toThrow(/synchron/i);
		db.close();
	});
});

describe('capture recovery boundaries', () => {
	it('discards an old identity response after a newer account refresh has committed', async () => {
		const db = store();
		const other = new DraftStore(db.name);
		let finish!: (response: Response) => void;
		const first = refreshCaptureIdentity(
			db,
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await refreshCaptureIdentity(other, async () => Response.json(person('b')));
		finish(Response.json(person('a')));
		expect(await first).toBeNull();
		expect((await db.current())?.ownerId).toBe('b');
		other.close();
		db.close();
	});
	it('discards an old unauthorised response after a newer account refresh has committed', async () => {
		const db = store();
		let finish!: (response: Response) => void;
		const first = refreshCaptureIdentity(
			db,
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await refreshCaptureIdentity(db, async () => Response.json(person('b')));
		finish(new Response('', { status: 401 }));
		await first;
		expect((await db.current())?.ownerId).toBe('b');
		db.close();
	});
	it('keeps an oversized collection of individually valid photos editable before any attempt', async () => {
		const db = store();
		const photo = new File([new Uint8Array(11 * 1024 * 1024)], 'photo.png', { type: 'image/png' });
		const record = await db.save({ ownerId: 'a', draft: draft(), photos: Array(6).fill(photo) });
		const requests: string[] = [];
		await syncDrafts(
			db,
			async (url) => {
				requests.push(String(url));
				return url === '/api/me'
					? Response.json(person('a'))
					: new Response('too large', { status: 413 });
			},
			'a'
		);
		expect(requests).toEqual(['/api/me']);
		expect((await db.get(record.id, 'a'))?.attemptedAt).toBeUndefined();
		await expect(
			db.save({ id: record.id, ownerId: 'a', draft: draft(), photos: [photo] })
		).resolves.toBeDefined();
		db.close();
	});
});

describe('bounded and coordinated recovery', () => {
	it('invalidates identity requests begun before sign-out', async () => {
		const db = store();
		await db.remember(person('a'));
		let finish!: (response: Response) => void;
		let started!: () => void;
		const received = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = refreshCaptureIdentity(db, () => {
			started();
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		await received;
		await db.beginSignOut('a');
		finish(Response.json(person('a')));
		expect(await pending).toBeNull();
		expect((await db.current())?.logoutUntil).toBeGreaterThan(Date.now());
		db.close();
	});
	it.each([
		{ backend: 'browser lock', fallback: false },
		{ backend: 'persisted fallback token', fallback: true }
	])('keeps an open $backend excluded while its tab is suspended', async ({ fallback }) => {
		if (fallback) vi.stubGlobal('navigator', {});
		const db = store();
		const value = await db.save({ ownerId: 'a', draft: draft(), photos: [] });
		const release = await db.lockEditor(value.id, 'a', 'editor-a');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 100_000);
		expect(await db.claim(value.id, 'a')).toBeUndefined();
		await release!();
		expect(await db.claim(value.id, 'a')).toBeDefined();
		db.close();
	});
	it('times out identity responses including a stalled body without changing the local account', async () => {
		const db = store();
		await db.remember(person('a'));
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		let started!: () => void;
		const received = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = refreshCaptureIdentity(db, async () => {
			started();
			return new Response(new ReadableStream({ start() {} }), {
				headers: { 'content-type': 'application/json' }
			});
		});
		const rejection = expect(pending).rejects.toThrow(/timed out/i);
		await received;
		await vi.advanceTimersByTimeAsync(10_001);
		await rejection;
		expect((await db.current())?.ownerId).toBe('a');
		db.close();
	});
	it('times out uploads while retaining the same operation and frozen payload for a safe retry', async () => {
		const db = store();
		const value = await db.save({ ownerId: 'a', draft: draft(), photos: [] });
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		let started!: () => void;
		let signal: AbortSignal | null | undefined;
		const received = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = syncDrafts(
			db,
			async (url, init) => {
				if (url === '/api/me') return Response.json(person('a'));
				signal = init?.signal;
				started();
				return new Promise(() => {});
			},
			'a'
		);
		await received;
		await vi.advanceTimersByTimeAsync(30_001);
		await pending;
		const retained = await db.get(value.id, 'a');
		expect(signal?.aborted).toBe(true);
		expect(retained?.leaseUntil).toBeUndefined();
		expect(retained?.attemptedAt).toBeDefined();
		expect(retained?.operationId).toBe(value.operationId);
		expect(retained?.payload?.title).toBe('A train');
		await expect(
			db.save({ id: value.id, ownerId: 'a', draft: { ...draft(), title: 'Changed' }, photos: [] })
		).rejects.toThrow(/attempted/i);
		db.close();
	});
});

describe('account-specific sign-out completion', () => {
	it('clears its own local identity and invalidates a response from before sign-out', async () => {
		const db = store();
		await db.remember(person('a'));
		let finish!: (response: Response) => void;
		let started!: () => void;
		const received = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = refreshCaptureIdentity(db, () => {
			started();
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		await received;
		expect(await db.forgetOwner('a')).toBe(true);
		finish(Response.json(person('a')));
		expect(await pending).toBeNull();
		expect(await db.current()).toBeUndefined();
		db.close();
	});
	it('cannot clear a newer account when an old account finishes signing out in another tab', async () => {
		const db = store();
		const other = new DraftStore(db.name);
		await db.remember(person('a'));
		const observedByOldSignOut = await db.current();
		await other.remember(person('b'));
		expect(await db.forgetOwner(observedByOldSignOut!.ownerId)).toBe(false);
		expect(await db.current()).toEqual(expect.objectContaining({ ownerId: 'b', name: 'b' }));
		other.close();
		db.close();
	});
});
