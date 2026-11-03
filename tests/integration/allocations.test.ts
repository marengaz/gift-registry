import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './identity-fixture';
import { createDatabase } from '../../src/lib/server/db/client';
import { acceptInvitation, createInvitation, setGrant } from '../../src/lib/server/invitations';
import { allocationGet, allocationPost, myGiftsGet } from '../../src/lib/server/allocations';
import { productGet, listsGet, productPatch } from '../../src/lib/server/catalogue';
import type { CatalogueEvent } from '../../src/lib/server/catalogue';
let context: ReturnType<typeof fixture>;
let directory: string;
beforeEach(() => {
	context = fixture();
	directory = mkdtempSync(join(tmpdir(), 'gift-buying-'));
	for (const id of ['guest', 'other'])
		acceptInvitation(
			context.connection,
			context.actor(id),
			createInvitation(context.connection, context.admin, {
				email: `${id}@example.test`,
				grants: [
					{ listId: 'visible', role: 'buyer' },
					{ listId: 'secret', role: 'buyer' }
				]
			}).token
		);
	context.connection.sqlite.exec(
		"INSERT INTO products(id,title,contributor_id) VALUES('game','Game','admin'); INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES('entry','game','visible',2000),('other-entry','game','secret',3000)"
	);
});
afterEach(() => {
	context.connection.close();
	rmSync(directory, { recursive: true, force: true });
});
function event(
	id: string | null,
	body?: unknown,
	origin = 'http://localhost:4173'
): CatalogueEvent {
	const url = new URL('http://localhost:4173/api/entries/entry/allocation');
	return {
		url,
		locals: { actor: id ? context.actor(id) : null },
		request: new Request(url, {
			method: body ? 'POST' : 'GET',
			headers: { origin, 'content-type': 'application/json' },
			...(body ? { body: JSON.stringify(body) } : {})
		})
	};
}
const command = (action: string, expectedVersion = 0, extra = {}) => ({
	action,
	expectedVersion,
	actionId: randomUUID(),
	...extra
});
async function act(id: string, action: string, expectedVersion = 0, extra = {}) {
	return allocationPost(
		context.connection,
		event(id, command(action, expectedVersion, extra)),
		'entry'
	);
}
describe('transactional buying HTTP contract', () => {
	for (const competitor of ['reserve', 'assign'])
		it(`gives one winner to competing reserve/${competitor} requests on separate connections`, async () => {
			const filename = join(directory, 'race.sqlite');
			writeFileSync(filename, context.connection.sqlite.serialize());
			const first = createDatabase({ filename });
			const second = createDatabase({ filename });
			try {
				const responses = await Promise.all([
					allocationPost(first, event('guest', command('reserve')), 'entry'),
					allocationPost(
						second,
						event(
							competitor === 'assign' ? 'admin' : 'other',
							command(competitor, 0, competitor === 'assign' ? { buyerId: 'other' } : {})
						),
						'entry'
					)
				]);
				expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
				expect(
					first.sqlite.prepare('SELECT state,version,buyer_id FROM entries WHERE id=?').get('entry')
				).toMatchObject({ state: 'allocated', version: 1 });
				expect(first.sqlite.prepare('SELECT * FROM allocation_history').all()).toHaveLength(1);
				const conflict = await responses.find((r) => r.status === 409)!.json();
				expect(JSON.stringify(conflict)).not.toMatch(/guest|other|buyerId|allocatedBy/);
			} finally {
				first.close();
				second.close();
			}
		});
	it('keeps an administrator assignment when it wins before a stale self-reservation', async () => {
		const filename = join(directory, 'assignment-race.sqlite');
		writeFileSync(filename, context.connection.sqlite.serialize());
		const first = createDatabase({ filename });
		const second = createDatabase({ filename });
		try {
			const responses = await Promise.all([
				allocationPost(first, event('admin', command('assign', 0, { buyerId: 'other' })), 'entry'),
				allocationPost(second, event('guest', command('reserve')), 'entry')
			]);
			expect(responses.map((response) => response.status)).toEqual([200, 409]);
			expect(
				second.sqlite
					.prepare('SELECT buyer_id,allocation_source,version FROM entries WHERE id=?')
					.get('entry')
			).toEqual({ buyer_id: 'other', allocation_source: 'administrator', version: 1 });
		} finally {
			first.close();
			second.close();
		}
	});
	it('replays a matching delivery once and rejects action ID reuse with another intent or target', async () => {
		const input = command('reserve');
		const one = await allocationPost(context.connection, event('guest', input), 'entry');
		const two = await allocationPost(context.connection, event('guest', input), 'entry');
		expect(one.status).toBe(200);
		expect(await two.json()).toEqual(await one.json());
		for (const [target, body] of [
			['entry', { ...input, action: 'release' }],
			['other-entry', input]
		] as const)
			expect((await allocationPost(context.connection, event('guest', body), target)).status).toBe(
				409
			);
		expect(
			context.connection.sqlite.prepare('SELECT * FROM allocation_history').all()
		).toHaveLength(1);
	});
	it('acknowledges an old retry without claiming ownership after administrator reassignment hides the entry', async () => {
		const input = command('reserve');
		expect((await allocationPost(context.connection, event('guest', input), 'entry')).status).toBe(
			200
		);
		await act('admin', 'clear', 1);
		await act('admin', 'assign', 2, { buyerId: 'other' });
		const replay = await allocationPost(context.connection, event('guest', input), 'entry');
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ acknowledged: true });
		expect((await allocationGet(context.connection, event('guest'), 'entry')).status).toBe(409);
		expect(
			context.connection.sqlite
				.prepare('SELECT state,buyer_id,version FROM entries WHERE id=?')
				.get('entry')
		).toEqual({ state: 'allocated', buyer_id: 'other', version: 3 });
		expect(
			context.connection.sqlite.prepare('SELECT * FROM allocation_history').all()
		).toHaveLength(3);
		await act('admin', 'clear', 3);
		const clearedReplay = await allocationPost(context.connection, event('guest', input), 'entry');
		expect(await clearedReplay.json()).toMatchObject({
			entry: { state: 'available', buyerId: null, version: 4 }
		});
	});
	it('keeps each list independent and hides another buyer from current responses and My gifts', async () => {
		expect((await act('guest', 'reserve')).status).toBe(200);
		const other = await (await productGet(context.connection, event('other'), 'game')).json();
		expect(other.entries.map((e: { id: string }) => e.id)).toEqual(['other-entry']);
		expect(JSON.stringify(other)).not.toContain('guest');
		expect(
			(await (await listsGet(context.connection, event('other'), 'visible')).json()).products
		).toEqual([]);
		const hidden = await allocationGet(context.connection, event('other'), 'entry');
		expect(hidden.status).toBe(409);
		expect(JSON.stringify(await hidden.json())).not.toContain('guest');
		const own = await allocationGet(context.connection, event('guest'), 'entry');
		expect(own.headers.get('cache-control')).toContain('no-store');
		expect(await own.json()).not.toHaveProperty('history');
		const mine = await (await myGiftsGet(context.connection, event('guest'))).json();
		expect(mine.products[0].entries.map((e: { id: string }) => e.id)).toEqual(['entry']);
		expect((await (await myGiftsGet(context.connection, event('other'))).json()).products).toEqual(
			[]
		);
	});
	it('releases only own self-reservations and requires explicit undo before clearing or reassigning purchases', async () => {
		expect((await act('guest', 'reserve')).status).toBe(200);
		expect((await act('other', 'release', 1)).status).toBe(403);
		expect((await act('guest', 'release', 1)).status).toBe(200);
		expect((await act('admin', 'assign', 2, { buyerId: 'guest' })).status).toBe(200);
		expect((await act('guest', 'release', 3)).status).toBe(403);
		expect((await act('guest', 'purchase', 3, { actualPence: 0 })).status).toBe(200);
		expect((await act('admin', 'clear', 4)).status).toBe(409);
		expect((await act('admin', 'assign', 4, { buyerId: 'other' })).status).toBe(409);
		expect((await act('admin', 'undo', 4)).status).toBe(200);
		expect(
			context.connection.sqlite
				.prepare('SELECT state,buyer_id,actual_pence FROM entries WHERE id=?')
				.get('entry')
		).toEqual({ state: 'allocated', buyer_id: 'guest', actual_pence: null });
		expect((await act('admin', 'assign', 5, { buyerId: 'other' })).status).toBe(200);
		expect((await act('admin', 'clear', 6)).status).toBe(200);
		expect(
			context.connection.sqlite
				.prepare('SELECT state,buyer_id FROM entries WHERE id=?')
				.get('entry')
		).toEqual({ state: 'available', buyer_id: null });
	});
	it('allows viewer assignment visibility but only administrator purchase, and rejects ineligible targets', async () => {
		setGrant(context.connection, context.admin, 'guest', { listId: 'visible', role: 'viewer' });
		expect((await act('guest', 'reserve')).status).toBe(403);
		expect((await act('admin', 'assign', 0, { buyerId: 'missing' })).status).toBe(400);
		expect((await act('admin', 'assign', 0, { buyerId: 'guest' })).status).toBe(200);
		expect(
			(await (await myGiftsGet(context.connection, event('guest'))).json()).products
		).toHaveLength(1);
		expect((await act('guest', 'purchase', 1)).status).toBe(403);
		expect((await act('other', 'purchase', 1)).status).toBe(403);
		expect((await act('admin', 'purchase', 1, { actualPence: 2500 })).status).toBe(200);
	});
	it('rechecks grants and sessions, validates pence and origin, and prevents archived new allocations', async () => {
		const stale = event('guest', command('reserve'));
		setGrant(context.connection, context.admin, 'guest', { listId: 'visible', role: null });
		expect((await allocationPost(context.connection, stale, 'entry')).status).toBe(403);
		expect(
			(await allocationPost(context.connection, event(null, command('reserve')), 'entry')).status
		).toBe(401);
		expect(
			(
				await allocationPost(
					context.connection,
					event('admin', command('reserve'), 'https://bad.test'),
					'entry'
				)
			).status
		).toBe(403);
		expect((await act('admin', 'purchase', 0, { actualPence: 1.5 })).status).toBe(400);
		const expired = event('other', command('reserve'));
		context.connection.sqlite
			.prepare('UPDATE session SET expires_at=0 WHERE id=?')
			.run('session-other');
		expect((await allocationPost(context.connection, expired, 'entry')).status).toBe(401);
		context.connection.sqlite
			.prepare('UPDATE session SET expires_at=? WHERE id=?')
			.run(Date.now() + 3600000, 'session-other');
		context.connection.sqlite.prepare('UPDATE lists SET archived_at=1 WHERE id=?').run('visible');
		expect((await act('other', 'reserve')).status).toBe(403);
		expect((await act('admin', 'assign', 0, { buyerId: 'admin' })).status).toBe(409);
	});
	it('keeps allocation history visible to the administrator after archiving', async () => {
		await act('admin', 'assign', 0, { buyerId: 'guest' });
		context.connection.sqlite.prepare('UPDATE lists SET archived_at=1 WHERE id=?').run('visible');
		const response = await allocationGet(context.connection, event('admin'), 'entry');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			entry: { buyerId: 'guest', state: 'allocated' },
			history: [
				{ action: 'assign', fromState: 'available', toState: 'allocated', resultingVersion: 1 }
			]
		});
		expect((await allocationGet(context.connection, event('guest'), 'entry')).status).toBe(403);
	});
	it('does not let a removed-entry retry allocate a re-added membership', async () => {
		const input = command('reserve');
		await allocationPost(context.connection, event('guest', input), 'entry');
		await act('admin', 'clear', 1);
		expect(
			(
				await productPatch(
					context.connection,
					event('admin', { title: 'Game', listIds: ['secret'] }),
					'game'
				)
			).status
		).toBe(200);
		expect(
			(
				await productPatch(
					context.connection,
					event('admin', { title: 'Game', listIds: ['secret', 'visible'] }),
					'game'
				)
			).status
		).toBe(200);
		expect((await allocationPost(context.connection, event('guest', input), 'entry')).status).toBe(
			404
		);
		expect(
			context.connection.sqlite.prepare('SELECT state FROM entries WHERE list_id=?').get('visible')
		).toEqual({ state: 'available' });
	});
});
