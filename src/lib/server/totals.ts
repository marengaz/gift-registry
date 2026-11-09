import { and, eq, isNull } from 'drizzle-orm';
import { AccessError, requireAdministrator } from './access';
import type { CatalogueEvent } from './catalogue';
import type { DatabaseConnection } from './db/client';
import { entries, lists, products } from './db/schema';
import { apiResponse } from './http';
export type ValueTotal = { pence: number; unknown: number; count: number };
export type ListTotals = {
	all: ValueTotal;
	allocated: ValueTotal;
	purchased: ValueTotal & { estimatedCount: number };
};
export function calculateListTotals(
	connection: DatabaseConnection,
	actor: CatalogueEvent['locals']['actor'],
	listId: string
): ListTotals {
	requireAdministrator(connection, actor);
	if (
		!connection.db
			.select()
			.from(lists)
			.where(and(eq(lists.id, listId), isNull(lists.deletedAt)))
			.get()
	)
		throw new AccessError(404, 'List not found.');
	const totals: ListTotals = {
		all: { pence: 0, unknown: 0, count: 0 },
		allocated: { pence: 0, unknown: 0, count: 0 },
		purchased: { pence: 0, unknown: 0, count: 0, estimatedCount: 0 }
	};
	for (const { entry } of connection.db
		.select({ entry: entries })
		.from(entries)
		.innerJoin(products, eq(entries.productId, products.id))
		.where(and(eq(entries.listId, listId), isNull(products.deletedAt)))
		.all()) {
		add(totals.all, entry.estimatePence);
		if (entry.state !== 'available') add(totals.allocated, entry.estimatePence);
		if (entry.state === 'purchased') {
			add(totals.purchased, entry.actualPence ?? entry.estimatePence);
			if (entry.actualPence === null && entry.estimatePence !== null)
				totals.purchased.estimatedCount++;
		}
	}
	return totals;
}
function add(total: ValueTotal, pence: number | null) {
	total.count++;
	if (pence === null) total.unknown++;
	else {
		total.pence += pence;
		if (!Number.isSafeInteger(total.pence))
			throw new AccessError(400, 'The total is too large to represent safely.');
	}
}
export function listTotalsGet(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	listId: string
) {
	return apiResponse(() => calculateListTotals(connection, event.locals.actor, listId));
}
