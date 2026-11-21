import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDatabase, migrateDatabase } from '../../src/lib/server/db/client';
import { productGet, productPatch, productsPost } from '../../src/lib/server/catalogue';
import { quidcoLookup, resetQuidcoCache } from '../../src/lib/server/enrichment/quidco';
import { fixture } from './identity-fixture';

const ORIGIN = 'https://gifts.example.test';
function jsonEvent(
	actor: ReturnType<ReturnType<typeof fixture>['actor']> | null,
	path: string,
	method: string,
	body?: unknown
) {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method,
		headers: {
			origin: ORIGIN,
			...(body !== undefined ? { 'content-type': 'application/json' } : {})
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return { locals: { actor }, request, url };
}

describe('coupon code persistence, validation, migration, and Quidco API', () => {
	beforeEach(() => {
		resetQuidcoCache();
	});

	afterEach(() => {
		resetQuidcoCache();
	});

	it('creates, reads, updates, and clears a 255-character plain-text coupon code', async () => {
		const context = fixture();
		try {
			const maxCode = 'A'.repeat(255);
			const createdResponse = await productsPost(
				context.connection,
				jsonEvent(context.admin, '/api/products', 'POST', {
					title: 'Wooden train set',
					sourceUrl: 'https://www.boots.com/train',
					couponCode: `  ${maxCode}  `,
					listIds: ['visible']
				})
			);
			expect(createdResponse.status).toBe(200);
			const created = await createdResponse.json();
			expect(created.couponCode).toBe(maxCode);

			const fetchedResponse = await productGet(
				context.connection,
				jsonEvent(context.admin, `/api/products/${created.id}`, 'GET'),
				created.id
			);
			expect((await fetchedResponse.json()).couponCode).toBe(maxCode);

			// Manual override to a voucher code
			const updatedResponse = await productPatch(
				context.connection,
				jsonEvent(context.admin, `/api/products/${created.id}`, 'PATCH', {
					title: 'Wooden train set',
					sourceUrl: 'https://www.boots.com/train',
					couponCode: 'SAVE20',
					listIds: ['visible']
				}),
				created.id
			);
			expect(updatedResponse.status).toBe(200);
			expect((await updatedResponse.json()).couponCode).toBe('SAVE20');

			// Clearing back to empty string stores null
			const clearedResponse = await productPatch(
				context.connection,
				jsonEvent(context.admin, `/api/products/${created.id}`, 'PATCH', {
					title: 'Wooden train set',
					sourceUrl: 'https://www.boots.com/train',
					couponCode: '   ',
					listIds: ['visible']
				}),
				created.id
			);
			expect(clearedResponse.status).toBe(200);
			expect((await clearedResponse.json()).couponCode).toBeNull();
		} finally {
			context.connection.close();
		}
	});

	it('rejects coupon codes longer than 255 characters in both API validation and SQLite CHECK constraint', async () => {
		const context = fixture();
		try {
			const tooLong = 'B'.repeat(256);
			const response = await productsPost(
				context.connection,
				jsonEvent(context.admin, '/api/products', 'POST', {
					title: 'Board game',
					couponCode: tooLong,
					listIds: ['visible']
				})
			);
			expect(response.status).toBe(400);
			expect((await response.json()).message).toBe('Coupon code must be 255 characters or fewer.');

			expect(() =>
				context.connection.sqlite
					.prepare(
						"INSERT INTO products (id, title, coupon_code, contributor_id) VALUES ('bad-coupon', 'Game', ?, 'admin')"
					)
					.run(tooLong)
			).toThrow();
		} finally {
			context.connection.close();
		}
	});

	it('upgrades an existing migration-7 database cleanly with nullable coupon_code', () => {
		const dir = mkdtempSync(join(tmpdir(), 'gift-coupon-mig-'));
		try {
			const earlier = join(dir, 'earlier');
			mkdirSync(join(earlier, 'meta'), { recursive: true });
			const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
			journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 8);
			writeFileSync(join(earlier, 'meta/_journal.json'), JSON.stringify(journal));
			for (const entry of journal.entries)
				copyFileSync(`drizzle/${entry.tag}.sql`, join(earlier, `${entry.tag}.sql`));

			const connection = createDatabase({ filename: join(dir, 'upgrade.sqlite') });
			try {
				migrate(connection.db, { migrationsFolder: earlier });
				connection.sqlite.exec(
					"INSERT INTO products (id, title, contributor_id) VALUES ('legacy-idea', 'Legacy idea', 'admin')"
				);
				migrateDatabase(connection);
				const row = connection.sqlite
					.prepare("SELECT id, coupon_code FROM products WHERE id = 'legacy-idea'")
					.get() as { id: string; coupon_code: string | null };
				expect(row).toEqual({ id: 'legacy-idea', coupon_code: null });
			} finally {
				connection.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('enforces contributor access on /api/quidco and returns cashback or graceful fallback', async () => {
		const context = fixture();
		try {
			// Unauthenticated rejected
			const unauth = await quidcoLookup(
				context.connection,
				jsonEvent(null, '/api/quidco?url=https://www.boots.com/item', 'GET')
			);
			expect(unauth.status).toBe(401);

			// Non-contributor guest rejected
			const guest = await quidcoLookup(
				context.connection,
				jsonEvent(context.actor('guest'), '/api/quidco?url=https://www.boots.com/item', 'GET')
			);
			expect(guest.status).toBe(403);

			// Contributor gets Quidco cashback when feed responds 200
			const fetchOk = vi.fn<typeof fetch>().mockResolvedValue(
				new Response(
					JSON.stringify({
						merchants: [
							{
								name: 'Boots',
								domain: 'boots.com',
								reward: 'Up to 3.75% cashback',
								url: 'https://www.quidco.com/boots/'
							}
						]
					}),
					{ status: 200 }
				)
			);
			const okRes = await quidcoLookup(
				context.connection,
				jsonEvent(context.admin, '/api/quidco?url=https://www.boots.com/item', 'GET'),
				{ catalogUrl: 'https://example.test/quidco.json', fetchImpl: fetchOk }
			);
			expect(okRes.status).toBe(200);
			expect(await okRes.json()).toEqual({
				cashback: 'Quidco: Up to 3.75% cashback',
				merchantName: 'Boots',
				quidcoUrl: 'https://www.quidco.com/boots/',
				searchUrl: 'https://www.quidco.com/search/?q=boots',
				available: true
			});

			// Graceful fallback on 403
			resetQuidcoCache();
			const fetchBlocked = vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response('Forbidden', { status: 403 }));
			const blockedRes = await quidcoLookup(
				context.connection,
				jsonEvent(context.admin, '/api/quidco?url=https://www.boots.com/item', 'GET'),
				{ catalogUrl: 'https://example.test/blocked.json', fetchImpl: fetchBlocked }
			);
			expect(blockedRes.status).toBe(200);
			expect(await blockedRes.json()).toEqual({
				cashback: null,
				merchantName: null,
				quidcoUrl: null,
				searchUrl: 'https://www.quidco.com/search/?q=boots',
				available: false
			});
		} finally {
			context.connection.close();
		}
	});
});
