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
import { fixture } from './identity-fixture';
import { visibleLists } from '../../src/lib/server/access';

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
function openEarlierDatabase(beforeMigration: number) {
	connection.close();
	const earlier = join(directory, 'earlier');
	mkdirSync(join(earlier, 'meta'), { recursive: true });
	const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
	journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < beforeMigration);
	writeFileSync(join(earlier, 'meta/_journal.json'), JSON.stringify(journal));
	for (const entry of journal.entries)
		copyFileSync(`drizzle/${entry.tag}.sql`, join(earlier, `${entry.tag}.sql`));
	const filename = join(directory, 'earlier.sqlite');
	connection = createDatabase({ filename });
	migrate(connection.db, { migrationsFolder: earlier });
	return filename;
}
describe('persistent catalogue boundaries', () => {
	it('keeps the established public list shape without internal deletion state', () => {
		const context = fixture();
		try {
			const list = context.connection.db.select().from(lists).where(eq(lists.id, 'visible')).get()!;
			expect(
				visibleLists(context.connection, context.admin).find(({ id }) => id === list.id)
			).toEqual({
				id: list.id,
				recipientId: list.recipientId,
				name: list.name,
				occasion: list.occasion,
				archivedAt: list.archivedAt,
				createdAt: list.createdAt,
				recipientName: 'Child',
				role: 'administrator'
			});
		} finally {
			context.connection.close();
		}
	});
	it('upgrades a populated earlier database and retains durable catalogue recovery on reopen', () => {
		const filename = openEarlierDatabase(4);
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
	it('upgrades populated lists without changing memberships, buying history or earlier receipts', () => {
		openEarlierDatabase(5);
		connection.sqlite.exec(`
			INSERT INTO recipients (id,name) VALUES ('luke','Luke'),('max','Max');
			INSERT INTO lists (id,recipient_id,name,occasion,archived_at) VALUES
				('named','luke','Birthday','Birthday 2026',NULL),
				('general','luke','General',NULL,NULL),
				('hidden-named','max','Birthday','Birthday 2026',1000),
				('hidden-general','max','General',NULL,1000);
			INSERT INTO products (id,title,contributor_id) VALUES
				('game','Card game','author'),('book','Book','author');
			INSERT INTO entries (id,product_id,list_id,state,buyer_id,allocation_source,allocated_by_id,estimate_pence,actual_pence,version,allocated_at,purchased_at) VALUES
				('purchased','game','named','purchased','buyer','self','buyer',2050,2500,3,1000,2000),
				('reserved','book','hidden-named','allocated','buyer','administrator','admin',1500,NULL,2,1000,NULL);
			INSERT INTO entries (id,product_id,list_id) VALUES ('general-entry','game','general'),('hidden-entry','game','hidden-general');
			INSERT INTO allocation_history (id,entry_id,actor_id,action_id,action,from_state,to_state,from_buyer_id,to_buyer_id,resulting_version,result_json)
				VALUES ('history','purchased','buyer','buy','purchase','allocated','purchased','buyer','buyer',3,'{"version":3}');
			INSERT INTO media (id,product_id,storage_path,mime_type,byte_size) VALUES ('photo','game','fixture-photo','image/jpeg',100);
			INSERT INTO capture_receipts (actor_id,operation_id,product_id,result_json) VALUES ('author','capture','game','{}');
			INSERT INTO catalogue_actions (id,actor_id,operation_id,fingerprint,kind,snapshots_json,result_json) VALUES ('action','admin','add','canonical','add','[]','{}');
			INSERT INTO catalogue_latest_actions (actor_id,action_id) VALUES ('admin','action');
		`);
		const retainedTables = [
			'recipients',
			'lists',
			'products',
			'entries',
			'allocation_history',
			'media',
			'capture_receipts',
			'catalogue_actions',
			'catalogue_latest_actions'
		];
		const snapshots = retainedTables.map((table) => {
			const columns = connection.sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
				name: string;
			}[];
			const query = `SELECT ${columns.map(({ name }) => name).join(',')} FROM ${table} ORDER BY rowid`;
			return { query, rows: connection.sqlite.prepare(query).all() };
		});
		migrateDatabase(connection);
		expect(connection.sqlite.prepare('SELECT deleted_at FROM lists').all()).toEqual([
			{ deleted_at: null },
			{ deleted_at: null },
			{ deleted_at: null },
			{ deleted_at: null }
		]);
		for (const { query, rows } of snapshots)
			expect(connection.sqlite.prepare(query).all()).toEqual(rows);
		expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
		expect(connection.sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
		connection.sqlite.exec(`UPDATE lists SET deleted_at=3000 WHERE id IN ('named','general');
			INSERT INTO lists (id,recipient_id,name,occasion) VALUES ('new-named','luke','Birthday','Birthday 2026'),('new-general','luke','General',NULL);`);
		for (const [recipient, occasion] of [
			['luke', 'Birthday 2026'],
			['luke', null],
			['max', 'Birthday 2026'],
			['max', null]
		]) {
			expect(() =>
				connection.sqlite
					.prepare('INSERT INTO lists (id,recipient_id,name,occasion) VALUES (?,?,?,?)')
					.run('duplicate', recipient, 'Duplicate', occasion)
			).toThrow(/UNIQUE/);
		}
		expect(connection.sqlite.prepare('SELECT list_id FROM entries ORDER BY id').all()).toEqual([
			{ list_id: 'general' },
			{ list_id: 'hidden-general' },
			{ list_id: 'named' },
			{ list_id: 'hidden-named' }
		]);
		expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
	});
	it.each(['fresh', 'upgraded'])(
		'retains one list-deletion receipt per actor and operation on a %s database',
		(database) => {
			const filename =
				database === 'upgraded' ? openEarlierDatabase(5) : join(directory, 'catalogue.sqlite');
			migrateDatabase(connection);
			connection.sqlite.exec(`INSERT INTO recipients (id,name) VALUES ('luke','Luke');
			INSERT INTO lists (id,recipient_id,name) VALUES ('general','luke','General');`);
			const acknowledgement = JSON.stringify({
				administratorId: 'admin',
				listId: 'general',
				operationId: 'delete-operation',
				deleteOrphans: false,
				productCount: 0,
				deletedProductCount: 0,
				keptProductCount: 0
			});
			const insert = connection.sqlite.prepare(
				'INSERT INTO list_deletion_receipts (actor_id,operation_id,list_id,fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?)'
			);
			insert.run('admin', 'delete-operation', 'general', 'canonical', acknowledgement, 3000);
			expect(() =>
				insert.run('admin', 'delete-operation', 'general', 'changed', '{}', 4000)
			).toThrow(/UNIQUE/);
			expect(() =>
				insert.run('other', 'another-operation', 'missing', 'canonical', '{}', 4000)
			).toThrow(/FOREIGN KEY/);
			insert.run('other', 'delete-operation', 'general', 'other-canonical', '{}', 4000);
			connection.close();
			connection = createDatabase({ filename });
			migrateDatabase(connection);
			expect(
				connection.sqlite
					.prepare('SELECT * FROM list_deletion_receipts WHERE actor_id=?')
					.get('admin')
			).toEqual({
				actor_id: 'admin',
				operation_id: 'delete-operation',
				list_id: 'general',
				fingerprint: 'canonical',
				result_json: acknowledgement,
				created_at: 3000
			});
			expect(
				connection.sqlite.prepare('SELECT COUNT(*) AS count FROM list_deletion_receipts').get()
			).toEqual({ count: 2 });
			expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
		}
	);
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
