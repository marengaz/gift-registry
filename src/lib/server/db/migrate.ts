import { createDatabase, migrateDatabase } from './client';

const connection = createDatabase({ filename: process.env.DATABASE_PATH ?? './data/gifts.sqlite' });
try {
	migrateDatabase(connection);
	console.info('Database migrations applied.');
} finally {
	connection.close();
}
