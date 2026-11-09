import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createDatabase,
	migrateDatabase,
	type DatabaseConnection
} from '../../src/lib/server/db/client';
import { addProductToList } from '../../src/lib/server/db/catalogue';
import { entries, lists, products, recipients } from '../../src/lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

let directory: string;
let connection: DatabaseConnection;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'gift-model-'));
	connection = createDatabase({ filename: join(directory, 'catalogue.sqlite') });
	migrateDatabase(connection);
});
afterEach(() => {
	connection?.close();
	rmSync(directory, { recursive: true, force: true });
});
function seed() {
	connection.db
		.insert(recipients)
		.values([
			{ id: 'luke', name: 'Luke' },
			{ id: 'max', name: 'Max' }
		])
		.run();
	connection.db
		.insert(lists)
		.values([
			{ id: 'luke-birthday', recipientId: 'luke', name: 'Birthday', occasion: 'Birthday 2026' },
			{ id: 'max-christmas', recipientId: 'max', name: 'Christmas', occasion: 'Christmas 2026' }
		])
		.run();
	connection.db
		.insert(products)
		.values({ id: 'card-game', title: 'Card game', contributorId: 'person-1' })
		.run();
}
describe('persistent catalogue boundaries', () => {
	it('upgrades a populated earlier database and retains durable catalogue recovery on reopen', () => {
		connection.close();
		const earlier = join(directory, 'earlier');
		mkdirSync(join(earlier, 'meta'), { recursive: true });
		const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
		journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 4);
		writeFileSync(join(earlier, 'meta/_journal.json'), JSON.stringify(journal));
		for (const entry of journal.entries)
			copyFileSync(`drizzle/${entry.tag}.sql`, join(earlier, `${entry.tag}.sql`));
		const filename = join(directory, 'earlier.sqlite');
		connection = createDatabase({ filename });
		migrate(connection.db, { migrationsFolder: earlier });
		connection.sqlite.exec(`
			INSERT INTO recipients (id,name) VALUES ('luke','Luke');
			INSERT INTO lists (id,recipient_id,name,occasion) VALUES ('luke-birthday','luke','Birthday','Birthday 2026');
			INSERT INTO products (id,title,contributor_id) VALUES ('card-game','Card game','person-1');
			INSERT INTO entries (id,product_id,list_id,estimate_pence) VALUES ('entry','card-game','luke-birthday',2050);
		`);
		migrateDatabase(connection);
		const columns = connection.sqlite.prepare('PRAGMA table_info(products)').all() as {
			name: string;
		}[];
		expect(columns.map((column) => column.name)).toEqual(
			expect.arrayContaining(['deleted_at', 'deletion_token'])
		);
		expect(
			connection.sqlite.prepare('SELECT deleted_at, deletion_token FROM products').get()
		).toEqual({ deleted_at: null, deletion_token: null });
		connection.sqlite
			.prepare(
				`INSERT INTO catalogue_actions (id,actor_id,operation_id,fingerprint,kind,snapshots_json,result_json) VALUES (?,?,?,?,?,?,?)`
			)
			.run('action', 'admin', 'operation', 'canonical', 'add', '[]', '{}');
		connection.sqlite
			.prepare('INSERT INTO catalogue_latest_actions (actor_id,action_id) VALUES (?,?)')
			.run('admin', 'action');
		connection.close();
		connection = createDatabase({ filename });
		migrateDatabase(connection);
		expect(connection.sqlite.prepare('SELECT estimate_pence FROM entries').get()).toEqual({
			estimate_pence: 2050
		});
		expect(
			connection.sqlite.prepare('SELECT action_id FROM catalogue_latest_actions').get()
		).toEqual({ action_id: 'action' });
		expect(connection.sqlite.prepare('SELECT fingerprint FROM catalogue_actions').get()).toEqual({
			fingerprint: 'canonical'
		});
	});
	it('reopens migrated records with their integer-pence valuation', () => {
		seed();
		const entry = addProductToList(connection, {
			productId: 'card-game',
			listId: 'luke-birthday',
			estimatePence: 2050
		});
		connection.close();
		connection = createDatabase({ filename: join(directory, 'catalogue.sqlite') });
		migrateDatabase(connection);
		expect(connection.db.select().from(products).all()).toMatchObject([
			{ title: 'Card game', contributorId: 'person-1' }
		]);
		expect(connection.db.select().from(lists).all()).toHaveLength(2);
		expect(connection.db.select().from(entries).get()).toMatchObject({
			id: entry.id,
			estimatePence: 2050
		});
	});
	it('returns the existing entry when re-added, preserving buyer and valuation', () => {
		seed();
		const original = addProductToList(connection, {
			productId: 'card-game',
			listId: 'luke-birthday',
			estimatePence: 2050
		});
		connection.db
			.update(entries)
			.set({
				state: 'allocated',
				buyerId: 'buyer-1',
				allocationSource: 'self',
				allocatedById: 'buyer-1'
			})
			.where(eq(entries.id, original.id))
			.run();
		const repeated = addProductToList(connection, {
			productId: 'card-game',
			listId: 'luke-birthday',
			estimatePence: 9900
		});
		expect(repeated).toMatchObject({
			id: original.id,
			state: 'allocated',
			buyerId: 'buyer-1',
			estimatePence: 2050
		});
		expect(connection.db.select().from(entries).all()).toHaveLength(1);
	});
	it('keeps entries for different recipients and occasions independent', () => {
		seed();
		const luke = addProductToList(connection, { productId: 'card-game', listId: 'luke-birthday' });
		const max = addProductToList(connection, { productId: 'card-game', listId: 'max-christmas' });
		connection.db
			.update(entries)
			.set({
				state: 'purchased',
				buyerId: 'buyer-1',
				allocationSource: 'self',
				allocatedById: 'buyer-1',
				actualPence: 2500
			})
			.where(eq(entries.id, luke.id))
			.run();
		expect(connection.db.select().from(entries).where(eq(entries.id, max.id)).get()).toMatchObject({
			state: 'available',
			buyerId: null,
			actualPence: null
		});
		expect(luke.id).not.toBe(max.id);
	});
	it('rejects duplicate named and general list scopes while allowing different occasions', () => {
		seed();
		expect(() =>
			connection.db
				.insert(lists)
				.values({ id: 'duplicate', recipientId: 'luke', name: 'Other', occasion: 'Birthday 2026' })
				.run()
		).toThrow();
		connection.db
			.insert(lists)
			.values({ id: 'general', recipientId: 'luke', name: 'General ideas' })
			.run();
		expect(() =>
			connection.db
				.insert(lists)
				.values({ id: 'general-again', recipientId: 'luke', name: 'General again' })
				.run()
		).toThrow();
		connection.db
			.insert(lists)
			.values({
				id: 'christmas',
				recipientId: 'luke',
				name: 'Christmas',
				occasion: 'Christmas 2026'
			})
			.run();
		expect(connection.db.select().from(lists).all()).toHaveLength(4);
	});
	it('rejects missing references and invalid allocation or money records', () => {
		seed();
		expect(() =>
			addProductToList(connection, { productId: 'missing', listId: 'luke-birthday' })
		).toThrow();
		expect(() =>
			connection.db
				.insert(lists)
				.values({ id: 'orphan', recipientId: 'missing', name: 'Orphan' })
				.run()
		).toThrow();
		const entry = addProductToList(connection, { productId: 'card-game', listId: 'luke-birthday' });
		expect(() =>
			connection.db
				.update(entries)
				.set({ state: 'purchased' })
				.where(eq(entries.id, entry.id))
				.run()
		).toThrow();
		expect(() =>
			connection.db
				.update(entries)
				.set({ state: 'allocated', buyerId: 'buyer-1', allocatedById: 'buyer-1' })
				.where(eq(entries.id, entry.id))
				.run()
		).toThrow();
		expect(() =>
			connection.db
				.update(entries)
				.set({ estimatePence: 1.5 })
				.where(eq(entries.id, entry.id))
				.run()
		).toThrow();
		expect(() =>
			connection.db.update(entries).set({ estimatePence: -1 }).where(eq(entries.id, entry.id)).run()
		).toThrow();
	});
});
