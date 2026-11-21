import { reconcileOffers } from './offer-review';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
	AccessError,
	canCapture,
	canEditProduct,
	canReadProduct,
	listRole,
	projectProduct,
	requireAdministrator,
	requireCollaborator,
	requireListRole,
	requireMember,
	visibleEntries,
	visibleLists,
	type Actor
} from './access';
import type { DatabaseConnection } from './db/client';
import {
	allocationHistory,
	entries,
	labels,
	lists,
	media,
	productLabels,
	products,
	recipients
} from './db/schema';
import { addProductToList } from './db/catalogue';
import { apiResponse, assertSameOrigin } from './http';
import { prepareMedia, type MediaOptions, type PreparedMedia } from './media';
import { listVisibilityPatch } from './list-lifecycle';

export type CatalogueEvent = { locals: { actor: Actor | null }; request: Request; url: URL };
const text = z.string().trim().min(1);
const optionalText = z
	.string()
	.trim()
	.nullable()
	.optional()
	.transform((value) => value || null);
const url = z
	.url()
	.refine(
		(value) => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol),
		'Use an HTTP or HTTPS link.'
	);
const optionalUrl = url
	.nullable()
	.optional()
	.or(z.literal(''))
	.transform((value) => value || null);
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const offer = z
	.object({
		id: text.optional(),
		url,
		retailer: optionalText,
		priceMinor: money.optional(),
		currency: z
			.string()
			.regex(/^[A-Z]{3}$/)
			.nullable()
			.optional()
	})
	.refine(
		(value) => value.priceMinor == null || !!value.currency,
		'A priced shopping link needs its currency.'
	);
const optionalCouponCode = z
	.string()
	.trim()
	.max(255, 'Coupon code must be 255 characters or fewer.')
	.nullable()
	.optional()
	.transform((value) => value || null);
export const captureSchema = z.object({
	title: text,
	description: optionalText,
	variant: optionalText,
	sourceUrl: optionalUrl,
	sourceText: optionalText,
	couponCode: optionalCouponCode,
	listIds: z.array(text).default([]),
	estimatePence: money.optional(),
	entryEstimates: z.record(z.string(), money).optional(),
	labels: z.array(text).default([]),
	offers: z.array(offer).default([])
});
export type CaptureInput = z.infer<typeof captureSchema>;
export function parseCapture(input: unknown): CaptureInput {
	const parsed = captureSchema.safeParse(input);
	if (!parsed.success) {
		const issue = parsed.error.issues[0]?.message;
		throw new AccessError(
			400,
			issue === 'Use an HTTP or HTTPS link.'
				? 'Use an HTTP or HTTPS shopping or source link.'
				: issue === 'Coupon code must be 255 characters or fewer.'
					? issue
					: 'Check the title, links and prices. Leave prices unknown if you do not know them.'
		);
	}
	return parsed.data;
}
function projection(connection: DatabaseConnection, actor: Actor, id: string) {
	const product = projectProduct(connection, actor, id);
	if (!product) throw new AccessError(404, 'Idea not found.');
	const canSeeContributor = actor.administrator || actor.collaborator;
	const contributorName = canSeeContributor
		? ((
				connection.sqlite
					.prepare('SELECT name FROM user WHERE id=?')
					.get((product as { contributorId?: string }).contributorId) as
					{ name: string } | undefined
			)?.name ?? 'Former member')
		: undefined;
	return { ...product, ...(canSeeContributor ? { contributorName } : {}) };
}
function requireCapture(connection: DatabaseConnection, actor: Actor | null) {
	const current = requireMember(connection, actor);
	if (!canCapture(connection, current))
		throw new AccessError(403, 'Contributor permission is needed to add an idea.');
	return current;
}
function checkTargets(
	connection: DatabaseConnection,
	actor: Actor,
	listIds: string[],
	existingIds: string[] = []
) {
	for (const id of new Set(listIds)) {
		requireListRole(connection, actor, id, ['contributor', 'buyer']);
		const list = connection.db.select().from(lists).where(eq(lists.id, id)).get();
		if (!list || list.deletedAt !== null || (list.archivedAt !== null && !existingIds.includes(id)))
			throw new AccessError(403, 'Choose an active list you can contribute to.');
	}
}
function setDetails(connection: DatabaseConnection, id: string, input: CaptureInput) {
	connection.db.delete(productLabels).where(eq(productLabels.productId, id)).run();
	for (const name of new Set(input.labels)) {
		connection.db.insert(labels).values({ id: randomUUID(), name }).onConflictDoNothing().run();
		const label = connection.db.select().from(labels).where(eq(labels.name, name)).get()!;
		connection.db.insert(productLabels).values({ productId: id, labelId: label.id }).run();
	}
	try {
		reconcileOffers(connection, id, input.offers);
	} catch (error) {
		if (error instanceof Error && error.message === 'foreign-offer-id')
			throw new AccessError(400, 'Choose shopping links belonging to this idea.');
		throw error;
	}
}
/** Synchronous, current-grant checked write; callers may include this in an outer receipt transaction. */
export function saveCapture(
	connection: DatabaseConnection,
	actor: Actor | null,
	input: CaptureInput,
	images: PreparedMedia[] = []
) {
	return connection.sqlite
		.transaction(() => {
			const current = requireCapture(connection, actor);
			checkTargets(connection, current, input.listIds);
			const id = randomUUID();
			connection.db
				.insert(products)
				.values({
					id,
					title: input.title,
					description: input.description,
					variant: input.variant,
					sourceUrl: input.sourceUrl,
					sourceText: input.sourceText,
					couponCode: input.couponCode,
					contributorId: current.userId
				})
				.run();
			for (const listId of new Set(input.listIds))
				addProductToList(connection, {
					productId: id,
					listId,
					estimatePence:
						input.entryEstimates && listId in input.entryEstimates
							? input.entryEstimates[listId]
							: (input.estimatePence ?? null)
				});
			setDetails(connection, id, input);
			for (const image of images)
				connection.db
					.insert(media)
					.values({ ...image, productId: id })
					.run();
			return projection(connection, current, id);
		})
		.immediate();
}
export function productsGet(connection: DatabaseConnection, event: CatalogueEvent) {
	return apiResponse(() => {
		const actor = requireMember(connection, event.locals.actor);
		const inbox = event.url.searchParams.get('inbox') === '1';
		if (!inbox) requireCollaborator(connection, actor);
		const q = event.url.searchParams.get('q')?.trim().toLocaleLowerCase('en-GB') ?? '';
		const label = event.url.searchParams.get('label');
		const unlisted = event.url.searchParams.get('unlisted') === '1';
		const result = connection.db
			.select()
			.from(products)
			.where(isNull(products.deletedAt))
			.orderBy(products.createdAt)
			.all()
			.reverse()
			.flatMap((product) => {
				const empty = !connection.sqlite
					.prepare(
						'SELECT 1 FROM entries e JOIN lists l ON l.id=e.list_id WHERE e.product_id=? AND l.deleted_at IS NULL'
					)
					.get(product.id);
				const include =
					(!inbox ||
						(empty &&
							(actor.administrator ||
								actor.collaborator ||
								product.contributorId === actor.userId))) &&
					(!unlisted || empty);
				if (!include) return [];
				const projected = projection(connection, actor, product.id);
				if (actor.collaborator && !actor.administrator && !empty && projected.entries.length === 0)
					return [{ ...projected, hasHiddenEntries: true }];
				return [projected];
			})
			.filter(
				(product) =>
					(!label || product.labels.some((l) => l.id === label)) &&
					(!q ||
						product.title.toLocaleLowerCase('en-GB').includes(q) ||
						product.labels.some((l) => l.name.toLocaleLowerCase('en-GB').includes(q)))
			);
		return {
			products: result,
			lists: visibleLists(connection, actor),
			labels:
				actor.administrator || actor.collaborator ? connection.db.select().from(labels).all() : [],
			administrator: actor.administrator,
			collaborator: actor.collaborator
		};
	});
}
export function productGet(connection: DatabaseConnection, event: CatalogueEvent, id: string) {
	return apiResponse(() =>
		projection(connection, requireMember(connection, event.locals.actor), id)
	);
}
export function productsPost(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	options: MediaOptions = {}
) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const actor = requireCapture(connection, event.locals.actor);
		let input: CaptureInput;
		let files: File[] = [];
		if (event.request.headers.get('content-type')?.includes('multipart/form-data')) {
			const form = await event.request.formData();
			const draft = form.get('draft');
			if (typeof draft !== 'string') throw new AccessError(400, 'The capture draft is missing.');
			input = parseCapture(JSON.parse(draft));
			files = form.getAll('photos').filter((value): value is File => value instanceof File);
		} else input = parseCapture(await event.request.json());
		checkTargets(connection, actor, input.listIds);
		const prepared = await prepareMedia(files, options);
		try {
			return saveCapture(connection, actor, input, prepared.media);
		} catch (error) {
			await prepared.cleanup();
			throw error;
		}
	});
}
export function productPatch(connection: DatabaseConnection, event: CatalogueEvent, id: string) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const actor = requireMember(connection, event.locals.actor);
		const input = parseCapture(await event.request.json());
		return connection.sqlite
			.transaction(() => {
				if (!canEditProduct(connection, actor, id)) {
					if (actor.administrator || actor.collaborator)
						throw new AccessError(404, 'Idea not found.');
					throw new AccessError(
						403,
						'Only administrators, collaborators, or the person who added this idea can edit it.'
					);
				}
				const existing = visibleEntries(connection, actor, { productId: id });
				const existingIds = existing.map((e) => e.listId);
				const addedListIds = input.listIds.filter((listId) => !existingIds.includes(listId));
				checkTargets(connection, actor, addedListIds, existingIds);
				const removed = existing.filter((e) => !input.listIds.includes(e.listId));
				for (const entry of removed)
					if (listRole(connection, actor, entry.listId) !== 'contributor')
						throw new AccessError(
							403,
							'List collaborator permission is needed to remove an idea from this list.'
						);
				if (removed.some((e) => e.state !== 'available'))
					throw new AccessError(409, 'Clear the allocation before removing this idea from a list.');
				connection.db
					.update(products)
					.set({
						title: input.title,
						description: input.description,
						variant: input.variant,
						sourceUrl: input.sourceUrl,
						sourceText: input.sourceText,
						couponCode: input.couponCode,
						updatedAt: Date.now()
					})
					.where(eq(products.id, id))
					.run();
				for (const entry of removed) {
					connection.db
						.delete(allocationHistory)
						.where(eq(allocationHistory.entryId, entry.id))
						.run();
					connection.db.delete(entries).where(eq(entries.id, entry.id)).run();
				}
				for (const listId of new Set(input.listIds)) {
					const entry = addProductToList(connection, {
						productId: id,
						listId,
						estimatePence:
							input.entryEstimates && listId in input.entryEstimates
								? input.entryEstimates[listId]
								: (input.estimatePence ?? null)
					});
					const canEditListEstimate =
						actor.administrator ||
						['contributor', 'buyer'].includes(listRole(connection, actor, listId) ?? '');
					if (
						input.entryEstimates &&
						listId in input.entryEstimates &&
						canEditListEstimate &&
						(actor.administrator || entry.state === 'available' || entry.buyerId === actor.userId)
					)
						connection.db
							.update(entries)
							.set({ estimatePence: input.entryEstimates[listId], updatedAt: Date.now() })
							.where(eq(entries.id, entry.id))
							.run();
				}
				setDetails(connection, id, input);
				return canReadProduct(connection, actor, id)
					? projection(connection, actor, id)
					: { id, updated: true };
			})
			.immediate();
	});
}
export function listsGet(connection: DatabaseConnection, event: CatalogueEvent, id?: string) {
	return apiResponse(() => {
		const actor = requireMember(connection, event.locals.actor);
		const available = visibleLists(connection, actor);
		if (!id)
			return {
				lists: available,
				administrator: actor.administrator,
				collaborator: actor.collaborator,
				...(actor.administrator ? { administratorId: actor.userId } : {}),
				canCapture: canCapture(connection, actor),
				recipients: actor.administrator ? connection.db.select().from(recipients).all() : []
			};
		const list = available.find((item) => item.id === id);
		if (!list) throw new AccessError(404, 'List not found.');
		const productIds = [
			...new Set(visibleEntries(connection, actor, { listId: id }).map((entry) => entry.productId))
		];
		return {
			list,
			products: productIds.map((productId) => projection(connection, actor, productId)),
			lists: available,
			administrator: actor.administrator,
			collaborator: actor.collaborator
		};
	});
}
const listSchema = z.object({ recipientId: text, name: text, occasion: optionalText });
export function listsPost(connection: DatabaseConnection, event: CatalogueEvent) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		requireAdministrator(connection, event.locals.actor);
		const parsed = listSchema.safeParse(await event.request.json());
		if (!parsed.success) throw new AccessError(400, 'Choose a recipient and name for this list.');
		if (
			!connection.db
				.select()
				.from(recipients)
				.where(eq(recipients.id, parsed.data.recipientId))
				.get()
		)
			throw new AccessError(400, 'Choose an existing recipient.');
		const duplicate = connection.sqlite
			.prepare('SELECT 1 FROM lists WHERE recipient_id=? AND occasion IS ? AND deleted_at IS NULL')
			.get(parsed.data.recipientId, parsed.data.occasion);
		if (duplicate)
			throw new AccessError(
				409,
				'This recipient already has a list for that occasion. Open the existing list.'
			);
		const value = { id: randomUUID(), ...parsed.data };
		connection.db.insert(lists).values(value).run();
		return value;
	});
}
export function listPatch(connection: DatabaseConnection, event: CatalogueEvent, id: string) {
	return listVisibilityPatch(connection, event, id);
}
export function recipientsPost(connection: DatabaseConnection, event: CatalogueEvent) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		requireAdministrator(connection, event.locals.actor);
		const parsed = z.object({ name: text }).safeParse(await event.request.json());
		if (!parsed.success) throw new AccessError(400, 'Enter the recipient’s name.');
		const value = { id: randomUUID(), name: parsed.data.name };
		connection.db.insert(recipients).values(value).run();
		return value;
	});
}
export function labelsPost(connection: DatabaseConnection, event: CatalogueEvent) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		requireCollaborator(connection, event.locals.actor);
		const parsed = z.object({ name: text }).safeParse(await event.request.json());
		if (!parsed.success) throw new AccessError(400, 'Enter a label name.');
		const existing = connection.db
			.select()
			.from(labels)
			.where(eq(labels.name, parsed.data.name))
			.get();
		if (existing) return existing;
		const value = { id: randomUUID(), name: parsed.data.name };
		connection.db.insert(labels).values(value).run();
		return value;
	});
}
export function listEntryDelete(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	listId: string,
	entryId: string
) {
	return apiResponse(() => {
		assertSameOrigin(event.request, event.url);
		return connection.sqlite
			.transaction(() => {
				const actor = requireListRole(connection, event.locals.actor as Actor, listId, [
					'contributor'
				]);
				const entry = connection.db
					.select({ entry: entries })
					.from(entries)
					.innerJoin(products, eq(entries.productId, products.id))
					.innerJoin(lists, eq(entries.listId, lists.id))
					.where(
						and(
							eq(entries.id, entryId),
							eq(entries.listId, listId),
							isNull(products.deletedAt),
							isNull(lists.deletedAt)
						)
					)
					.get()?.entry;
				if (!entry) throw new AccessError(404, 'List item not found.');
				if (entry.state !== 'available')
					throw new AccessError(
						409,
						actor.administrator || entry.buyerId === actor.userId
							? 'Clear the allocation before removing this idea from a list.'
							: 'This gift has changed or is no longer available. Refresh the list.'
					);
				connection.db
					.delete(allocationHistory)
					.where(eq(allocationHistory.entryId, entry.id))
					.run();
				connection.db.delete(entries).where(eq(entries.id, entry.id)).run();
				return { removed: true, entryId, listId };
			})
			.immediate();
	});
}
