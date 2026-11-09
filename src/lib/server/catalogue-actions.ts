import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type {
	CatalogueActionAcknowledgement,
	CatalogueActionConflictReason,
	CatalogueActionRequest,
	CatalogueActionResult,
	CatalogueActionStatus,
	CatalogueDeleteImpact
} from '../shared/catalogue-actions';
import { AccessError, requireAdministrator } from './access';
import type { CatalogueEvent } from './catalogue';
import { addProductToList } from './db/catalogue';
import type { DatabaseConnection } from './db/client';
import { catalogueActions, catalogueLatestActions, entries, products } from './db/schema';
import { apiResponse, assertSameOrigin, privateJson } from './http';

const ids = z.array(z.string().min(1)).min(1);
const actionSchema = z.discriminatedUnion('kind', [
	z.strictObject({ operationId: z.uuid(), kind: z.literal('add'), productIds: ids, listIds: ids }),
	z.strictObject({
		operationId: z.uuid(),
		kind: z.literal('delete'),
		productIds: ids,
		impactFingerprint: z.string().min(1).optional()
	})
]);
const undoSchema = z.strictObject({ operationId: z.uuid(), expectedActionId: z.uuid() });
type Entry = typeof entries.$inferSelect;
type Product = typeof products.$inferSelect;
type Receipt = typeof catalogueActions.$inferSelect;
type Snapshots = { entries: Entry[]; products: Product[] };

class CatalogueConflict extends AccessError {
	constructor(
		public reason: CatalogueActionConflictReason,
		message: string,
		public impact?: CatalogueDeleteImpact
	) {
		super(409, message);
	}
}

async function actionResponse(action: () => unknown | Promise<unknown>) {
	try {
		return privateJson(await action());
	} catch (error) {
		if (error instanceof CatalogueConflict)
			return privateJson(
				{
					message: error.message,
					reason: error.reason,
					...(error.impact ? { impact: error.impact } : {})
				},
				error.status
			);
		return apiResponse(() => {
			throw error;
		});
	}
}
const canonicalIds = (values: string[]) => [...new Set(values)].sort();
const fingerprint = (value: unknown) =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex');

function currentStatus(
	connection: DatabaseConnection,
	administratorId: string
): CatalogueActionStatus {
	const latest = connection.db
		.select({ action: catalogueActions })
		.from(catalogueLatestActions)
		.innerJoin(catalogueActions, eq(catalogueActions.id, catalogueLatestActions.actionId))
		.where(eq(catalogueLatestActions.actorId, administratorId))
		.get()?.action;
	if (!latest || latest.undoneAt !== null || latest.kind === 'undo')
		return { administratorId, undo: null };
	const result = JSON.parse(latest.resultJson) as CatalogueActionAcknowledgement;
	return {
		administratorId,
		undo: {
			actionId: latest.id,
			kind: latest.kind,
			productCount: result.productCount,
			entryCount: result.entryCount,
			createdAt: latest.createdAt
		}
	};
}

function replay(
	connection: DatabaseConnection,
	actorId: string,
	operationId: string,
	requestFingerprint: string
): CatalogueActionResult | undefined {
	const receipt = connection.db
		.select()
		.from(catalogueActions)
		.where(
			and(eq(catalogueActions.actorId, actorId), eq(catalogueActions.operationId, operationId))
		)
		.get();
	if (!receipt) return;
	if (receipt.fingerprint !== requestFingerprint)
		throw new CatalogueConflict(
			'operation-reused',
			'This operation ID was already used for a different request.'
		);
	return {
		acknowledgement: JSON.parse(receipt.resultJson) as CatalogueActionAcknowledgement,
		...currentStatus(connection, actorId)
	};
}

function record(
	connection: DatabaseConnection,
	actorId: string,
	requestFingerprint: string,
	acknowledgement: CatalogueActionAcknowledgement,
	snapshots: Snapshots
): CatalogueActionResult {
	connection.db
		.insert(catalogueActions)
		.values({
			id: acknowledgement.actionId,
			actorId,
			operationId: acknowledgement.operationId,
			fingerprint: requestFingerprint,
			kind: acknowledgement.kind,
			snapshotsJson: JSON.stringify(snapshots),
			resultJson: JSON.stringify(acknowledgement)
		})
		.run();
	if (acknowledgement.effective && acknowledgement.kind !== 'undo')
		connection.db
			.insert(catalogueLatestActions)
			.values({ actorId, actionId: acknowledgement.actionId })
			.onConflictDoUpdate({
				target: catalogueLatestActions.actorId,
				set: { actionId: acknowledgement.actionId }
			})
			.run();
	return { acknowledgement, ...currentStatus(connection, actorId) };
}

function liveProducts(connection: DatabaseConnection, productIds: string[]): Product[] {
	// Each lookup has one binding, regardless of the size of the selection.
	const query = connection.sqlite.prepare(
		'SELECT id FROM products WHERE id=? AND deleted_at IS NULL'
	);
	return productIds.map((id) => {
		if (!query.get(id))
			throw new CatalogueConflict(
				'stale-target',
				'An idea is missing or has been deleted. Refresh the catalogue.'
			);
		return connection.db.select().from(products).where(eq(products.id, id)).get()!;
	});
}

function productEntries(connection: DatabaseConnection, productId: string) {
	return connection.db
		.select()
		.from(entries)
		.where(eq(entries.productId, productId))
		.all()
		.sort((a, b) => a.id.localeCompare(b.id));
}

function initialEstimate(connection: DatabaseConnection, productId: string): number | null {
	const existing = connection.sqlite
		.prepare(
			'SELECT e.estimate_pence AS estimate FROM entries e JOIN lists l ON l.id=e.list_id WHERE e.product_id=? AND l.archived_at IS NULL'
		)
		.all(productId) as { estimate: number | null }[];
	if (existing.length)
		return existing[0].estimate !== null &&
			existing.every((entry) => entry.estimate === existing[0].estimate)
			? existing[0].estimate
			: null;
	const prices = connection.sqlite
		.prepare(
			"SELECT DISTINCT price_minor AS price FROM offers WHERE product_id=? AND currency='GBP' AND price_minor IS NOT NULL"
		)
		.all(productId) as { price: number }[];
	return prices.length === 1 ? prices[0].price : null;
}

function addToLists(
	connection: DatabaseConnection,
	input: Extract<CatalogueActionRequest, { kind: 'add' }>
): Snapshots {
	const list = connection.sqlite.prepare('SELECT id FROM lists WHERE id=? AND archived_at IS NULL');
	for (const id of input.listIds)
		if (!list.get(id))
			throw new CatalogueConflict(
				'stale-target',
				'A destination list is missing or archived. Refresh the list picker.'
			);
	const snapshots: Snapshots = { entries: [], products: [] };
	const exists = connection.sqlite.prepare(
		'SELECT id FROM entries WHERE product_id=? AND list_id=?'
	);
	for (const productId of input.productIds) {
		const estimatePence = initialEstimate(connection, productId);
		for (const listId of input.listIds) {
			if (exists.get(productId, listId)) continue;
			snapshots.entries.push(addProductToList(connection, { productId, listId, estimatePence }));
		}
	}
	return snapshots;
}

function deleteProducts(
	connection: DatabaseConnection,
	input: Extract<CatalogueActionRequest, { kind: 'delete' }>,
	targets: Product[],
	actionId: string
): Snapshots {
	const affected = targets.flatMap((product) => productEntries(connection, product.id));
	const nonAvailable = affected
		.filter((entry) => entry.state !== 'available')
		.sort((a, b) => a.id.localeCompare(b.id));
	const reviewed = nonAvailable.map((entry) => ({
		entryId: entry.id,
		productId: entry.productId,
		listId: entry.listId,
		state: entry.state as 'allocated' | 'purchased',
		version: entry.version
	}));
	const impact: CatalogueDeleteImpact = {
		fingerprint: fingerprint(reviewed),
		entries: reviewed,
		allocatedCount: reviewed.filter((entry) => entry.state === 'allocated').length,
		purchasedCount: reviewed.filter((entry) => entry.state === 'purchased').length
	};
	if (
		(input.impactFingerprint !== undefined && input.impactFingerprint !== impact.fingerprint) ||
		(reviewed.length && input.impactFingerprint === undefined)
	)
		throw new CatalogueConflict(
			'refresh-impact',
			'Review the current reservations and purchases before deleting these ideas.',
			impact
		);
	const deletedAt = Date.now();
	for (const product of targets)
		connection.db
			.update(products)
			.set({ deletedAt, deletionToken: actionId })
			.where(eq(products.id, product.id))
			.run();
	return {
		entries: affected,
		products: targets.map((product) => ({ ...product, deletedAt, deletionToken: actionId }))
	};
}

export function catalogueActionsGet(connection: DatabaseConnection, event: CatalogueEvent) {
	return actionResponse(() =>
		connection.sqlite
			.transaction(() => {
				const actor = requireAdministrator(connection, event.locals.actor);
				return currentStatus(connection, actor.userId);
			})
			.immediate()
	);
}

export function catalogueActionsPost(connection: DatabaseConnection, event: CatalogueEvent) {
	return actionResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const parsed = actionSchema.safeParse(await event.request.json());
		if (!parsed.success)
			throw new AccessError(
				400,
				'Choose at least one idea and valid destinations or reviewed deletion impact.'
			);
		const input: CatalogueActionRequest =
			parsed.data.kind === 'add'
				? {
						...parsed.data,
						productIds: canonicalIds(parsed.data.productIds),
						listIds: canonicalIds(parsed.data.listIds)
					}
				: { ...parsed.data, productIds: canonicalIds(parsed.data.productIds) };
		const requestFingerprint = fingerprint(
			input.kind === 'add'
				? { kind: input.kind, productIds: input.productIds, listIds: input.listIds }
				: {
						kind: input.kind,
						productIds: input.productIds,
						impactFingerprint: input.impactFingerprint ?? null
					}
		);
		return connection.sqlite
			.transaction(() => {
				const actor = requireAdministrator(connection, event.locals.actor);
				const repeated = replay(connection, actor.userId, input.operationId, requestFingerprint);
				if (repeated) return repeated;
				const targets = liveProducts(connection, input.productIds);
				const actionId = randomUUID();
				const snapshots =
					input.kind === 'add'
						? addToLists(connection, input)
						: deleteProducts(connection, input, targets, actionId);
				const productCount =
					input.kind === 'delete'
						? targets.length
						: new Set(snapshots.entries.map((entry) => entry.productId)).size;
				return record(
					connection,
					actor.userId,
					requestFingerprint,
					{
						operationId: input.operationId,
						actionId,
						kind: input.kind,
						productCount,
						entryCount: snapshots.entries.length,
						effective: productCount > 0
					},
					snapshots
				);
			})
			.immediate();
	});
}

function unsafeUndo(): never {
	throw new CatalogueConflict(
		'unsafe-undo',
		'These ideas have changed since the action. Undo cannot safely reverse it.'
	);
}

function reverseAction(connection: DatabaseConnection, receipt: Receipt, snapshots: Snapshots) {
	if (receipt.kind === 'add') {
		const history = connection.sqlite.prepare(
			'SELECT 1 FROM allocation_history WHERE entry_id=? LIMIT 1'
		);
		for (const saved of snapshots.entries) {
			const current = connection.db.select().from(entries).where(eq(entries.id, saved.id)).get();
			const product = connection.db
				.select()
				.from(products)
				.where(eq(products.id, saved.productId))
				.get();
			if (
				!product ||
				product.deletedAt !== null ||
				current?.state !== 'available' ||
				!isDeepStrictEqual(current, saved) ||
				history.get(saved.id)
			)
				unsafeUndo();
		}
		for (const saved of snapshots.entries)
			connection.db.delete(entries).where(eq(entries.id, saved.id)).run();
	} else if (receipt.kind === 'delete') {
		const entriesByProduct = new Map<string, Entry[]>();
		for (const entry of snapshots.entries) {
			const group = entriesByProduct.get(entry.productId) ?? [];
			group.push(entry);
			entriesByProduct.set(entry.productId, group);
		}
		for (const saved of snapshots.products) {
			const current = connection.db.select().from(products).where(eq(products.id, saved.id)).get();
			if (current?.deletionToken !== receipt.id || !isDeepStrictEqual(current, saved)) unsafeUndo();
			const savedEntries = (entriesByProduct.get(saved.id) ?? []).sort((a, b) =>
				a.id.localeCompare(b.id)
			);
			if (!isDeepStrictEqual(productEntries(connection, saved.id), savedEntries)) unsafeUndo();
		}
		for (const saved of snapshots.products)
			connection.db
				.update(products)
				.set({ deletedAt: null, deletionToken: null })
				.where(eq(products.id, saved.id))
				.run();
	} else unsafeUndo();
}

export function catalogueActionsUndoPost(connection: DatabaseConnection, event: CatalogueEvent) {
	return actionResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const parsed = undoSchema.safeParse(await event.request.json());
		if (!parsed.success)
			throw new AccessError(400, 'Choose the displayed latest action and a valid operation ID.');
		const input = parsed.data;
		const requestFingerprint = fingerprint({
			kind: 'undo',
			expectedActionId: input.expectedActionId
		});
		return connection.sqlite
			.transaction(() => {
				const actor = requireAdministrator(connection, event.locals.actor);
				const repeated = replay(connection, actor.userId, input.operationId, requestFingerprint);
				if (repeated) return repeated;
				const status = currentStatus(connection, actor.userId);
				if (status.undo?.actionId !== input.expectedActionId)
					throw new CatalogueConflict(
						'stale-undo',
						'The latest catalogue action has changed. Refresh Undo before trying again.'
					);
				const receipt = connection.db
					.select()
					.from(catalogueActions)
					.where(eq(catalogueActions.id, input.expectedActionId))
					.get()!;
				const snapshots = JSON.parse(receipt.snapshotsJson) as Snapshots;
				reverseAction(connection, receipt, snapshots);
				connection.db
					.update(catalogueActions)
					.set({ undoneAt: Date.now() })
					.where(eq(catalogueActions.id, receipt.id))
					.run();
				return record(
					connection,
					actor.userId,
					requestFingerprint,
					{
						operationId: input.operationId,
						actionId: randomUUID(),
						kind: 'undo',
						effective: true,
						productCount: status.undo.productCount,
						entryCount: status.undo.entryCount
					},
					{ entries: [], products: [] }
				);
			})
			.immediate();
	});
}
