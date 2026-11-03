import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fixture } from './identity-fixture';
import { acceptInvitation, createInvitation, setGrant } from '../../src/lib/server/invitations';
import { capturesPost } from '../../src/lib/server/capture-sync';
import type { CatalogueEvent } from '../../src/lib/server/catalogue';
let context: ReturnType<typeof fixture>;
let directory: string;
beforeEach(() => {
	context = fixture();
	directory = mkdtempSync(join(tmpdir(), 'gift-sync-'));
});
afterEach(() => {
	context.connection.close();
	rmSync(directory, { recursive: true, force: true });
});
function event(
	id: string | null,
	operationId: string,
	draft: unknown = { title: 'Train', listIds: ['visible'] },
	ownerId = id,
	photo?: File
): CatalogueEvent {
	const url = new URL('http://localhost:4173/api/captures');
	const body = new FormData();
	body.set('operationId', operationId);
	body.set('ownerId', ownerId ?? '');
	body.set('draft', JSON.stringify(draft));
	if (photo) body.append('photos', photo);
	return {
		url,
		locals: { actor: id ? context.actor(id) : null },
		request: new Request(url, { method: 'POST', headers: { origin: url.origin }, body })
	};
}
function post(value: CatalogueEvent) {
	return capturesPost(context.connection, value, { mediaRoot: directory });
}
function invite() {
	acceptInvitation(
		context.connection,
		context.actor('guest'),
		createInvitation(context.connection, context.admin, {
			email: 'guest@example.test',
			grants: [{ listId: 'visible', role: 'contributor' }]
		}).token
	);
}
describe('capture operation receipts over HTTP', () => {
	it('acknowledges a lost-response retry once with minimal saved IDs and no duplicate media', async () => {
		invite();
		const operationId = crypto.randomUUID();
		const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
			.png()
			.toBuffer();
		const photo = new File([bytes], 'train.png', { type: 'image/png' });
		const saved = await (await post(event('guest', operationId, undefined, 'guest', photo))).json();
		context.connection.sqlite
			.prepare(
				"UPDATE entries SET state='allocated',buyer_id='other',allocated_by_id='admin',allocation_source='administrator' WHERE product_id=?"
			)
			.run(saved.productId);
		setGrant(context.connection, context.admin, 'guest', { listId: 'visible', role: 'viewer' });
		const retried = await post(event('guest', operationId, undefined, 'guest', photo));
		expect(retried.status).toBe(200);
		expect(await retried.json()).toEqual(saved);
		expect(Object.keys(saved).sort()).toEqual(['entryIds', 'operationId', 'productId']);
		for (const table of ['products', 'entries', 'media', 'capture_receipts'])
			expect(context.connection.sqlite.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(1);
		expect(readdirSync(directory)).toHaveLength(1);
		expect(retried.headers.get('cache-control')).toContain('no-store');
	});
	it('rejects reuse of a UUID with changed payload or file content', async () => {
		const operationId = crypto.randomUUID();
		expect((await post(event('admin', operationId))).status).toBe(200);
		expect(
			(await post(event('admin', operationId, { title: 'Different', listIds: ['visible'] }))).status
		).toBe(409);
		expect(context.connection.sqlite.prepare('SELECT * FROM products').all()).toHaveLength(1);
	});
	it('never accepts another account’s owner and rechecks expired sessions', async () => {
		expect((await post(event('admin', crypto.randomUUID(), undefined, 'guest'))).status).toBe(409);
		const stale = event('admin', crypto.randomUUID());
		context.connection.sqlite
			.prepare("UPDATE session SET expires_at=1 WHERE user_id='admin'")
			.run();
		expect((await post(stale)).status).toBe(401);
		expect(context.connection.sqlite.prepare('SELECT * FROM products').all()).toHaveLength(0);
	});
	it('rolls back all lists and cleans staged files on revoked or missing target permission', async () => {
		invite();
		const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
			.png()
			.toBuffer();
		const response = await post(
			event(
				'guest',
				crypto.randomUUID(),
				{ title: 'Rejected', listIds: ['visible', 'secret'] },
				'guest',
				new File([bytes], 'x.png', { type: 'image/png' })
			)
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ editable: true });
		for (const table of ['products', 'entries', 'media', 'capture_receipts'])
			expect(context.connection.sqlite.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(0);
		expect(readdirSync(directory)).toEqual([]);
	});
	it('rolls back the saved product and cleans files if receipt insertion fails', async () => {
		context.connection.sqlite.exec(
			"CREATE TRIGGER reject_receipt BEFORE INSERT ON capture_receipts BEGIN SELECT RAISE(ABORT, 'receipt failed'); END"
		);
		await expect(post(event('admin', crypto.randomUUID()))).rejects.toThrow('receipt failed');
		expect(context.connection.sqlite.prepare('SELECT * FROM products').all()).toHaveLength(0);
	});
});

it('allows correction after a definite validation rejection without losing its operation', async () => {
	const operationId = crypto.randomUUID();
	const rejected = await post(event('admin', operationId, { title: '', listIds: [] }));
	expect(rejected.status).toBe(400);
	expect(await rejected.json()).toMatchObject({ editable: true });
	const fixed = await post(event('admin', operationId, { title: 'Corrected', listIds: [] }));
	expect(fixed.status).toBe(200);
	expect(context.connection.sqlite.prepare('SELECT * FROM products').all()).toHaveLength(1);
});

it('serialises simultaneous deliveries and fingerprints the photo contents', async () => {
	const operationId = crypto.randomUUID();
	const image = async (background: string) =>
		new File(
			[
				await sharp({ create: { width: 2, height: 2, channels: 3, background } })
					.png()
					.toBuffer()
			],
			'same-name.png',
			{ type: 'image/png' }
		);
	const photo = await image('red');
	const responses = await Promise.all([
		post(event('admin', operationId, undefined, 'admin', photo)),
		post(event('admin', operationId, undefined, 'admin', photo))
	]);
	expect(responses.map((response) => response.status)).toEqual([200, 200]);
	expect(await responses[0].json()).toEqual(await responses[1].json());
	const changed = await post(event('admin', operationId, undefined, 'admin', await image('blue')));
	expect(changed.status).toBe(409);
	for (const table of ['products', 'entries', 'media', 'capture_receipts'])
		expect(context.connection.sqlite.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(1);
	expect(readdirSync(directory)).toHaveLength(1);
});
