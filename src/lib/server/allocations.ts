import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import {
	AccessError,
	eligibleListMembers,
	projectProduct,
	requireAdministrator,
	requireListRole,
	requireMember,
	visibleEntries,
	visibleLists
} from './access';
import type { CatalogueEvent } from './catalogue';
import type { DatabaseConnection } from './db/client';
import { allocationHistory, entries, lists } from './db/schema';
import { apiResponse, assertSameOrigin } from './http';

const commandSchema = z.object({
	actionId: z.uuid(),
	expectedVersion: z.number().int().nonnegative(),
	action: z.enum(['reserve', 'release', 'assign', 'clear', 'purchase', 'undo']),
	buyerId: z.string().min(1).optional(),
	actualPence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional()
});
type Command = z.infer<typeof commandSchema>;
function authorisedEntry(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	id: string,
	mutating = false
) {
	const actor = requireMember(connection, event.locals.actor);
	const entry = connection.db.select().from(entries).where(eq(entries.id, id)).get();
	if (!entry) throw new AccessError(404, 'Gift entry not found.');
	requireListRole(
		connection,
		actor,
		entry.listId,
		mutating ? ['buyer', 'contributor'] : ['buyer', 'contributor', 'viewer']
	);
	return { actor, entry };
}
function unavailable(): never {
	throw new AccessError(409, 'This gift has changed or is no longer available. Refresh the list.');
}
export function allocationGet(connection: DatabaseConnection, event: CatalogueEvent, id: string) {
	return apiResponse(() => {
		const { actor, entry } = authorisedEntry(connection, event, id);
		if (!actor.administrator && entry.state !== 'available' && entry.buyerId !== actor.userId)
			unavailable();
		return {
			entry,
			administrator: actor.administrator,
			members: actor.administrator ? eligibleListMembers(connection, actor, entry.listId) : [],
			...(actor.administrator
				? {
						history: connection.db
							.select({
								action: allocationHistory.action,
								createdAt: allocationHistory.createdAt,
								fromState: allocationHistory.fromState,
								toState: allocationHistory.toState,
								resultingVersion: allocationHistory.resultingVersion
							})
							.from(allocationHistory)
							.where(eq(allocationHistory.entryId, entry.id))
							.orderBy(allocationHistory.resultingVersion)
							.all()
					}
				: {})
		};
	});
}
export function allocationPost(connection: DatabaseConnection, event: CatalogueEvent, id: string) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const parsed = commandSchema.safeParse(await event.request.json());
		if (!parsed.success)
			throw new AccessError(400, 'Check the buying action, version and GBP amount.');
		const input = parsed.data;
		if (
			(input.action === 'assign') !== (input.buyerId !== undefined) ||
			(input.action !== 'purchase' && input.actualPence !== undefined)
		)
			throw new AccessError(400, 'Check the buying action details.');
		return connection.sqlite
			.transaction(() => {
				const { actor, entry } = authorisedEntry(connection, event, id, true);
				if (['assign', 'clear', 'undo'].includes(input.action))
					requireAdministrator(connection, actor);
				const fingerprint = JSON.stringify({
					entryId: id,
					action: input.action,
					expectedVersion: input.expectedVersion,
					buyerId: input.buyerId ?? null,
					actualPence: input.actualPence ?? null
				});
				const receipt = connection.db
					.select()
					.from(allocationHistory)
					.where(
						and(
							eq(allocationHistory.actorId, actor.userId),
							eq(allocationHistory.actionId, input.actionId)
						)
					)
					.get();
				if (receipt) {
					const saved = JSON.parse(receipt.resultJson) as {
						fingerprint: string;
					};
					if (saved.fingerprint !== fingerprint)
						throw new AccessError(409, 'This action ID was already used for a different request.');
					return actor.administrator ||
						entry.state === 'available' ||
						entry.buyerId === actor.userId
						? { entry }
						: { acknowledged: true };
				}
				if (entry.version !== input.expectedVersion) unavailable();
				const list = connection.db.select().from(lists).where(eq(lists.id, entry.listId)).get()!;
				if (list.archivedAt !== null && ['reserve', 'assign'].includes(input.action))
					throw new AccessError(409, 'Restore this list before making a new allocation.');
				const update = transition(connection, actor, entry, input);
				const updated = connection.db
					.update(entries)
					.set({ ...update, version: entry.version + 1, updatedAt: Date.now() })
					.where(and(eq(entries.id, id), eq(entries.version, input.expectedVersion)))
					.returning()
					.get();
				if (!updated) unavailable();
				const result = { entry: updated };
				connection.db
					.insert(allocationHistory)
					.values({
						id: randomUUID(),
						entryId: id,
						actorId: actor.userId,
						actionId: input.actionId,
						action: input.action,
						fromState: entry.state,
						toState: updated.state,
						fromBuyerId: entry.buyerId,
						toBuyerId: updated.buyerId,
						resultingVersion: updated.version,
						resultJson: JSON.stringify({ fingerprint, result })
					})
					.run();
				return result;
			})
			.immediate();
	});
}
function transition(
	connection: DatabaseConnection,
	actor: ReturnType<typeof requireMember>,
	entry: typeof entries.$inferSelect,
	input: Command
): Partial<typeof entries.$inferInsert> {
	switch (input.action) {
		case 'reserve':
			if (entry.state !== 'available') unavailable();
			return {
				state: 'allocated',
				buyerId: actor.userId,
				allocationSource: 'self',
				allocatedById: actor.userId,
				allocatedAt: Date.now(),
				purchasedAt: null,
				actualPence: null
			};
		case 'assign':
			if (entry.state === 'purchased')
				throw new AccessError(409, 'Undo the purchase before reassigning this gift.');
			if (
				!eligibleListMembers(connection, actor, entry.listId).some(
					(member) => member.id === input.buyerId
				)
			)
				throw new AccessError(400, 'Choose an existing signed-in member with access to this list.');
			return {
				state: 'allocated',
				buyerId: input.buyerId!,
				allocationSource: 'administrator',
				allocatedById: actor.userId,
				allocatedAt: Date.now(),
				purchasedAt: null,
				actualPence: null
			};
		case 'release':
			if (entry.buyerId !== actor.userId || entry.allocationSource !== 'self')
				throw new AccessError(
					403,
					'Only your own reservation can be released. Ask the administrator to change an assignment.'
				);
			if (entry.state !== 'allocated')
				throw new AccessError(409, 'Ask the administrator to undo the purchase first.');
			return cleared();
		case 'clear':
			if (entry.state !== 'allocated')
				throw new AccessError(
					409,
					'Only an unpurchased allocation can be cleared. Undo a purchase first.'
				);
			return cleared();
		case 'purchase':
			if (!actor.administrator && entry.buyerId !== actor.userId)
				throw new AccessError(403, 'Only your own allocation can be marked purchased.');
			if (entry.state !== 'allocated') unavailable();
			return {
				state: 'purchased',
				actualPence: input.actualPence ?? null,
				purchasedAt: Date.now()
			};
		case 'undo':
			if (entry.state !== 'purchased')
				throw new AccessError(409, 'This gift is not marked purchased.');
			return { state: 'allocated', actualPence: null, purchasedAt: null };
	}
}
function cleared(): Partial<typeof entries.$inferInsert> {
	return {
		state: 'available',
		buyerId: null,
		allocationSource: null,
		allocatedById: null,
		allocatedAt: null,
		purchasedAt: null,
		actualPence: null
	};
}
export function myGiftsGet(connection: DatabaseConnection, event: CatalogueEvent) {
	return apiResponse(() => {
		const actor = requireMember(connection, event.locals.actor);
		const own = visibleEntries(connection, actor).filter(
			(entry) =>
				entry.buyerId === actor.userId &&
				entry.state !== 'available' &&
				connection.db.select().from(lists).where(eq(lists.id, entry.listId)).get()?.archivedAt ===
					null
		);
		const products = [...new Set(own.map((entry) => entry.productId))].map((id) => ({
			...projectProduct(connection, actor, id)!,
			entries: own.filter((entry) => entry.productId === id)
		}));
		return {
			products,
			lists: visibleLists(connection, actor),
			userId: actor.userId,
			administrator: actor.administrator
		};
	});
}
