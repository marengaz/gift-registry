import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DatabaseConnection } from './client';
import { entries } from './schema';

export function addProductToList(
	connection: DatabaseConnection,
	input: { productId: string; listId: string; estimatePence?: number | null }
) {
	return connection.sqlite.transaction(() => {
		connection.db
			.insert(entries)
			.values({ id: randomUUID(), ...input })
			.onConflictDoNothing({ target: [entries.productId, entries.listId] })
			.run();
		return connection.db
			.select()
			.from(entries)
			.where(and(eq(entries.productId, input.productId), eq(entries.listId, input.listId)))
			.get()!;
	})();
}
