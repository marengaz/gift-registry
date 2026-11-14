import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, expect, it } from 'vitest';
import {
	createDatabase,
	migrateDatabase,
	type DatabaseConnection
} from '../../src/lib/server/db/client';

let connection: DatabaseConnection;
let directory: string;
afterEach(() => {
	connection?.close();
	if (directory) rmSync(directory, { recursive: true, force: true });
});
function priorDatabase() {
	directory = mkdtempSync(join(tmpdir(), 'photo-shopping-model-'));
	const folder = join(directory, 'migrations');
	mkdirSync(join(folder, 'meta'), { recursive: true });
	const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
	journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 6);
	writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
	for (const entry of journal.entries)
		copyFileSync(`drizzle/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`));
	connection = createDatabase({ filename: ':memory:' });
	migrate(connection.db, { migrationsFolder: folder });
	connection.sqlite.exec(`INSERT INTO recipients(id,name) VALUES ('child','Child');
 INSERT INTO lists(id,recipient_id,name) VALUES ('list','child','Birthday');
 INSERT INTO products(id,title,contributor_id) VALUES ('game','Game','admin'),('other','Other','admin');
 INSERT INTO entries(id,product_id,list_id,state,buyer_id,allocation_source,allocated_by_id,actual_pence) VALUES ('entry','game','list','purchased','buyer','self','buyer',2000);
 INSERT INTO offers(id,product_id,url,retailer,price_minor,currency,observed_at) VALUES ('manual','game','https://shop.example/manual','vision-page',1000,'GBP',123);
 `);
}
function legacyJob(id: string, kind = 'vision', state = 'succeeded', productId = 'game') {
	connection.sqlite
		.prepare(
			`INSERT INTO lookup_jobs(id,product_id,actor_id,actor_session_id,operation_id,fingerprint,kind,state,result_json) VALUES (?,?,'admin','session',?,'fixture',?,?,?)`
		)
		.run(
			id,
			productId,
			id,
			kind,
			state,
			JSON.stringify({ suggestions: [{ offer: { url: 'https://shop.example/found' } }] })
		);
}
it('upgrades prior records unchanged and recognises only a successful associated Vision candidate', () => {
	priorDatabase();
	legacyJob('trusted');
	legacyJob('metadata', 'metadata');
	legacyJob('failed', 'vision', 'failed');
	legacyJob('foreign', 'vision', 'succeeded', 'other');
	for (const id of [
		'lookup-trusted-0',
		'lookup-metadata-0',
		'lookup-failed-0',
		'lookup-foreign-0',
		'lookup-trusted-00',
		'lookup-invented-0'
	])
		connection.sqlite
			.prepare(
				`INSERT INTO offers(id,product_id,url) VALUES (?,'game','https://shop.example/found')`
			)
			.run(id);
	const retained = ['products', 'lists', 'entries'].map((table) => ({
		table,
		rows: connection.sqlite.prepare(`SELECT * FROM ${table}`).all()
	}));
	const manual = connection.sqlite
		.prepare("SELECT * FROM offers WHERE id='manual'")
		.get() as Record<string, unknown>;
	migrateDatabase(connection);
	for (const { table, rows } of retained)
		expect(connection.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
	expect(connection.sqlite.prepare("SELECT * FROM offers WHERE id='manual'").get()).toMatchObject(
		manual
	);
	expect(
		connection.sqlite.prepare('SELECT id FROM offers WHERE reverse_provider IS NOT NULL').all()
	).toEqual([{ id: 'lookup-trusted-0' }]);
	expect(connection.sqlite.prepare('SELECT provider FROM lookup_jobs').all()).toEqual(
		Array(4).fill({ provider: 'vision' })
	);
	expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
	expect(connection.sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
});
it.each(['fresh', 'upgraded'])(
	'enforces pinned providers, whole search reservations and coherent checks on a %s fixture',
	(mode) => {
		if (mode === 'upgraded') priorDatabase();
		else connection = createDatabase({ filename: ':memory:' });
		migrateDatabase(connection);
		if (mode === 'fresh')
			connection.sqlite.exec(
				"INSERT INTO products(id,title,contributor_id) VALUES ('game','Game','admin')"
			);
		legacyJob('search');
		expect(() =>
			connection.sqlite.exec("UPDATE lookup_jobs SET provider='invented' WHERE id='search'")
		).toThrow(/CHECK/);
		connection.sqlite.exec(
			"UPDATE lookup_jobs SET provider='serpapi' WHERE id='search'; INSERT INTO serpapi_search_reservations(job_id,month) VALUES ('search','2026-11')"
		);
		expect(() =>
			connection.sqlite.exec(
				"INSERT INTO serpapi_search_reservations(job_id,month) VALUES ('search','2026-12')"
			)
		).toThrow(/UNIQUE/);
		expect(() =>
			connection.sqlite.exec(
				"INSERT INTO serpapi_search_reservations(job_id,month) VALUES ('missing','2026-11')"
			)
		).toThrow(/FOREIGN KEY/);
		expect(() =>
			connection.sqlite.exec("UPDATE serpapi_search_reservations SET month='2026-13'")
		).toThrow(/CHECK/);
		expect(() =>
			connection.sqlite.exec(
				"INSERT INTO offers(id,product_id,url,checked_at) VALUES ('broken','game','https://shop.example',123)"
			)
		).toThrow(/CHECK/);
		expect(() =>
			connection.sqlite.exec(
				"INSERT INTO offers(id,product_id,url,reverse_provider) VALUES ('bad-origin','game','https://shop.example','manual')"
			)
		).toThrow(/CHECK/);
	}
);
