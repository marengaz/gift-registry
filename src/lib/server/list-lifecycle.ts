import { createHash } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type {
	ListDeleteCommand,
	ListDeletionAcknowledgement,
	ListDeletionFailure,
	ListDeletionImpact,
	ListVisibilityFailure
} from '../shared/list-lifecycle';
import { AccessError, requireAdministrator } from './access';
import type { CatalogueEvent } from './catalogue';
import type { DatabaseConnection } from './db/client';
import { entries, listDeletionReceipts, lists, products, recipients } from './db/schema';
import { apiResponse, assertSameOrigin, privateJson } from './http';

const commandSchema = z.strictObject({
	operationId: z.uuid(),
	deleteOrphans: z.boolean(),
	impactFingerprint: z.string().min(1)
});
const fingerprint = (value: unknown) =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex');

class ListLifecycleError extends AccessError {
	constructor(
		public result: ListDeletionFailure | ListVisibilityFailure,
		status = 409
	) {
		super(status, result.message);
	}
}

async function lifecycleResponse(action: () => unknown | Promise<unknown>) {
	try {
		return privateJson(await action());
	} catch (error) {
		if (error instanceof ListLifecycleError) return privateJson(error.result, error.status);
		return apiResponse(() => {
			throw error;
		});
	}
}

function deletionImpact(connection: DatabaseConnection, administratorId: string, listId: string) {
	const target = connection.db
		.select({ list: lists, recipientName: recipients.name })
		.from(lists)
		.innerJoin(recipients, eq(recipients.id, lists.recipientId))
		.where(and(eq(lists.id, listId), isNull(lists.deletedAt)))
		.get();
	if (!target) throw new AccessError(404, 'This list is unavailable.');
	const targetEntries = connection.db
		.select({ entry: entries })
		.from(entries)
		.innerJoin(products, eq(products.id, entries.productId))
		.where(and(eq(entries.listId, listId), isNull(products.deletedAt)))
		.orderBy(asc(entries.id))
		.all()
		.map(({ entry }) => entry);
	const memberships = connection.sqlite
		.prepare(
			`SELECT e.product_id AS productId,e.list_id AS listId,e.id AS entryId
			 FROM entries e JOIN lists l ON l.id=e.list_id
			 JOIN entries target ON target.product_id=e.product_id AND target.list_id=?
			 JOIN products p ON p.id=e.product_id
			 WHERE l.deleted_at IS NULL AND p.deleted_at IS NULL
			 ORDER BY e.product_id,e.list_id,e.id`
		)
		.all(listId) as { productId: string; listId: string; entryId: string }[];
	const sharedProductIds = new Set(
		memberships
			.filter((membership) => membership.listId !== listId)
			.map(({ productId }) => productId)
	);
	const productIds = targetEntries.map(({ productId }) => productId).sort();
	const orphanProductIds = productIds.filter((id) => !sharedProductIds.has(id));
	const impact: ListDeletionImpact = {
		administratorId,
		listId,
		listName: target.list.name,
		recipientName: target.recipientName,
		fingerprint: fingerprint({ target, productIds, memberships, targetEntries }),
		productCount: productIds.length,
		orphanProductCount: orphanProductIds.length,
		allocatedCount: targetEntries.filter(({ state }) => state === 'allocated').length,
		purchasedCount: targetEntries.filter(({ state }) => state === 'purchased').length
	};
	return { impact, orphanProductIds };
}

export function listDeletionImpactGet(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	id: string
) {
	return lifecycleResponse(() =>
		connection.sqlite
			.transaction(() => {
				const actor = requireAdministrator(connection, event.locals.actor);
				return deletionImpact(connection, actor.userId, id).impact;
			})
			.immediate()
	);
}

export function listDelete(connection: DatabaseConnection, event: CatalogueEvent, id: string) {
	return lifecycleResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const parsed = commandSchema.safeParse(await event.request.json());
		if (!parsed.success)
			throw new AccessError(
				400,
				'Choose whether to keep ideas and review the current deletion impact.'
			);
		const input: ListDeleteCommand = parsed.data;
		const requestFingerprint = fingerprint({
			listId: id,
			deleteOrphans: input.deleteOrphans,
			impactFingerprint: input.impactFingerprint
		});
		return connection.sqlite
			.transaction(() => {
				const actor = requireAdministrator(connection, event.locals.actor);
				const receipt = connection.db
					.select()
					.from(listDeletionReceipts)
					.where(
						and(
							eq(listDeletionReceipts.actorId, actor.userId),
							eq(listDeletionReceipts.operationId, input.operationId)
						)
					)
					.get();
				if (receipt) {
					if (receipt.fingerprint !== requestFingerprint)
						throw new ListLifecycleError({
							reason: 'operation-reused',
							administratorId: actor.userId,
							listId: id,
							operationId: input.operationId,
							message: 'This operation ID was already used for a different request.'
						});
					return JSON.parse(receipt.resultJson) as ListDeletionAcknowledgement;
				}
				let reviewed;
				try {
					reviewed = deletionImpact(connection, actor.userId, id);
				} catch (error) {
					if (error instanceof AccessError && error.status === 404)
						throw new ListLifecycleError(
							{
								reason: 'list-unavailable',
								administratorId: actor.userId,
								listId: id,
								operationId: input.operationId,
								message: error.message
							},
							404
						);
					throw error;
				}
				const { impact, orphanProductIds } = reviewed;
				if (input.impactFingerprint !== impact.fingerprint)
					throw new ListLifecycleError({
						reason: 'refresh-impact',
						message:
							'This list has changed. Review the current ideas, reservations and purchases before deleting it.',
						impact
					});
				const deletedAt = Date.now();
				connection.db.update(lists).set({ deletedAt }).where(eq(lists.id, id)).run();
				if (input.deleteOrphans) {
					const tombstone = connection.sqlite.prepare(
						'UPDATE products SET deleted_at=?,deletion_token=? WHERE id=? AND deleted_at IS NULL'
					);
					const deletionToken = `list-deletion:${actor.userId}:${input.operationId}`;
					for (const productId of orphanProductIds)
						tombstone.run(deletedAt, deletionToken, productId);
				}
				const deletedProductCount = input.deleteOrphans ? orphanProductIds.length : 0;
				const acknowledgement: ListDeletionAcknowledgement = {
					administratorId: actor.userId,
					listId: id,
					operationId: input.operationId,
					deleteOrphans: input.deleteOrphans,
					productCount: impact.productCount,
					deletedProductCount,
					keptProductCount: impact.productCount - deletedProductCount
				};
				connection.db
					.insert(listDeletionReceipts)
					.values({
						actorId: actor.userId,
						operationId: input.operationId,
						listId: id,
						fingerprint: requestFingerprint,
						resultJson: JSON.stringify(acknowledgement)
					})
					.run();
				return acknowledgement;
			})
			.immediate();
	});
}

export function listVisibilityPatch(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	id: string
) {
	return lifecycleResponse(async () => {
		assertSameOrigin(event.request, event.url);
		requireAdministrator(connection, event.locals.actor);
		const parsed = z.object({ archived: z.boolean() }).safeParse(await event.request.json());
		if (!parsed.success) throw new AccessError(400, 'Choose whether this list is archived.');
		return connection.sqlite
			.transaction(() => {
				const actor = requireAdministrator(connection, event.locals.actor);
				if (
					!connection.db
						.select()
						.from(lists)
						.where(and(eq(lists.id, id), isNull(lists.deletedAt)))
						.get()
				)
					throw new ListLifecycleError(
						{
							reason: 'list-unavailable',
							administratorId: actor.userId,
							listId: id,
							archived: parsed.data.archived,
							message: 'List not found.'
						},
						404
					);
				connection.db
					.update(lists)
					.set({ archivedAt: parsed.data.archived ? Date.now() : null })
					.where(eq(lists.id, id))
					.run();
				return { ok: true };
			})
			.immediate();
	});
}
