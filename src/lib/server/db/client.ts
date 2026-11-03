import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

export function createDatabase({ filename }: { filename: string }) {
	if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
	const sqlite = new Database(filename);
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('journal_mode = WAL');
	const db = drizzle(sqlite, { schema });
	return { sqlite, db, close: () => sqlite.close() };
}
export type DatabaseConnection = ReturnType<typeof createDatabase>;

export function migrateDatabase(connection: DatabaseConnection) {
	migrate(connection.db, { migrationsFolder: resolve('drizzle') });
}

let runtimeConnection: DatabaseConnection | undefined;

export function getDatabase() {
	if (!runtimeConnection) {
		const connection = createDatabase({
			filename: process.env.DATABASE_PATH ?? './data/gifts.sqlite'
		});
		try {
			migrateDatabase(connection);
			runtimeConnection = connection;
		} catch (error) {
			connection.close();
			throw error;
		}
	}
	return runtimeConnection;
}
