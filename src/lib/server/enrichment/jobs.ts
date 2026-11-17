import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { and, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import sharp from 'sharp';
import {
	AccessError,
	canIdentifyProduct,
	canReadProduct,
	hasIdentifyRole,
	requireAdministrator,
	requireMember,
	resolveActor,
	type Actor
} from '../access';
import type { CatalogueEvent } from '../catalogue';
import type { DatabaseConnection } from '../db/client';
import { lookupJobs } from '../db/enrichment-schema';
import { products, media } from '../db/schema';
import { acceptSuggestedOffer, invalidateOfferChecks } from '../offer-review';
import { apiResponse, assertSameOrigin } from '../http';
import {
	mediaRoot,
	prepareMedia,
	MAX_IMAGE_PIXELS,
	MAX_IMAGE_BYTES,
	type MediaOptions
} from '../media';
import { allowanceSummary, reserveAllowance, getIdentificationSettings } from './allowance';
import { createSerpApiProvider, type SerpApiProvider } from './serpapi';
import { serpapiStatus, reserveSerpApiSearch } from './serpapi-allowance';
import { publicFetch } from './fetch';
import { extractMetadata } from './metadata';
import { createVisionProvider, visionConfiguration, type VisionProvider } from './vision';
import type { LookupResult, ProductSuggestion } from './types';
type Job = typeof lookupJobs.$inferSelect;
export type WorkerOptions = MediaOptions & {
	provider?: VisionProvider | null;
	serpapiProvider?: SerpApiProvider | null;
	fetchPage?: typeof publicFetch;
	now?: () => number;
};
function accessible(
	connection: DatabaseConnection,
	actor: Actor | null,
	productId: string,
	contributor = false
) {
	const fresh = requireMember(connection, actor);
	if (contributor && !hasIdentifyRole(connection, fresh, productId))
		throw new AccessError(403, 'Contributor permission is needed to identify an idea.');
	if (!canReadProduct(connection, fresh, productId)) throw new AccessError(404, 'Idea not found.');
	return fresh;
}
function publicJob(job: Job, actor: Actor) {
	return {
		id: job.id,
		...(job.actorId === actor.userId ? { operationId: job.operationId } : {}),
		kind: job.kind,
		provider: job.provider,
		mediaId: job.mediaId,
		state: job.state,
		createdAt: job.createdAt,
		finishedAt: job.finishedAt,
		result: job.resultJson ? (JSON.parse(job.resultJson) as LookupResult) : null,
		message: job.errorText
	};
}
const queueSchema = z.object({
	operationId: z.uuid(),
	kind: z.enum(['metadata', 'vision']),
	provider: z.enum(['vision', 'serpapi']).optional(),
	mediaId: z.string().min(1).optional()
});
export function identifyPost(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	productId: string
) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const parsed = queueSchema.safeParse(await event.request.json());
		if (!parsed.success)
			throw new AccessError(
				400,
				'Choose metadata or image identification and a valid request identifier.'
			);
		const input = parsed.data;
		if (input.kind !== 'vision' && input.provider !== undefined)
			throw new AccessError(400, 'Retailer metadata does not accept a provider override.');
		const provider = input.provider ?? 'vision';
		return connection.sqlite
			.transaction(() => {
				const actor = accessible(connection, event.locals.actor, productId, true);
				const legacyFingerprint = JSON.stringify({
					productId,
					kind: input.kind,
					mediaId: input.mediaId ?? null
				});
				const fingerprint = JSON.stringify({
					productId,
					kind: input.kind,
					provider,
					mediaId: input.mediaId ?? null
				});
				const existing = connection.db
					.select()
					.from(lookupJobs)
					.where(
						and(eq(lookupJobs.actorId, actor.userId), eq(lookupJobs.operationId, input.operationId))
					)
					.get();
				if (existing) {
					if (
						existing.provider !== provider ||
						(existing.fingerprint !== fingerprint &&
							!(
								input.provider === undefined &&
								provider === 'vision' &&
								existing.fingerprint === legacyFingerprint
							))
					)
						throw new AccessError(409, 'This request identifier was used for different details.');
					return publicJob(existing, actor);
				}
				if (input.kind === 'metadata' && input.mediaId)
					throw new AccessError(400, 'Retailer metadata uses the saved source link.');
				const product = connection.db
					.select()
					.from(products)
					.where(eq(products.id, productId))
					.get()!;
				if (input.kind === 'metadata' && !product.sourceUrl)
					throw new AccessError(400, 'Add a source link, or use a photo for image identification.');
				if (input.kind === 'vision') {
					const summary = allowanceSummary(connection);
					if (!summary.enabled)
						throw new AccessError(
							409,
							'Paid identification is disabled. Retailer metadata is still available.'
						);
					if (provider === 'serpapi') {
						const status = serpapiStatus(connection);
						if (!status.configured)
							throw new AccessError(
								409,
								'Photo search is not configured. Ask the administrator to set SERPAPI_API_KEY.'
							);
						if (!status.remaining)
							throw new AccessError(
								409,
								'The monthly photo-search allowance is exhausted. Your saved idea is safe; try in a later month.'
							);
						if (!input.mediaId) throw new AccessError(400, 'Choose a photo attached to this idea.');
					}
					if (provider === 'vision' && summary.remainingMicrodollars < summary.unitMicrodollars)
						throw new AccessError(409, 'The monthly identification allowance is exhausted.');
					if (
						input.mediaId &&
						!connection.db
							.select()
							.from(media)
							.where(and(eq(media.id, input.mediaId), eq(media.productId, productId)))
							.get()
					)
						throw new AccessError(404, 'Choose a photo attached to this idea.');
					if (!input.mediaId && !product.sourceUrl)
						throw new AccessError(
							400,
							'Attach a photo or screenshot before identifying this idea.'
						);
				}
				const job = connection.db
					.insert(lookupJobs)
					.values({
						id: randomUUID(),
						productId,
						actorId: actor.userId,
						actorSessionId: actor.sessionId,
						operationId: input.operationId,
						fingerprint,
						kind: input.kind,
						provider,
						mediaId: input.mediaId ?? null
					})
					.returning()
					.get()!;
				return publicJob(job, actor);
			})
			.immediate();
	});
}
export function identifyGet(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	productId: string
) {
	return apiResponse(() => {
		const actor = accessible(connection, event.locals.actor, productId);
		return {
			jobs: connection.db
				.select()
				.from(lookupJobs)
				.where(eq(lookupJobs.productId, productId))
				.orderBy(desc(lookupJobs.createdAt), desc(lookupJobs.id))
				.limit(25)
				.all()
				.filter((job) => job.kind !== 'attachment')
				.map((job) => publicJob(job, actor)),
			canIdentify: canIdentifyProduct(connection, actor, productId),
			administrator: actor.administrator,
			visionConfigured: visionConfiguration().ready,
			serpapi: serpapiStatus(connection),
			enabled: allowanceSummary(connection).enabled
		};
	});
}
export function recoverInterruptedJobs(connection: DatabaseConnection, now = Date.now()) {
	connection.sqlite
		.prepare(
			"UPDATE lookup_jobs SET state=CASE WHEN dispatched_at IS NULL THEN 'failed' ELSE 'uncertain' END,finished_at=?,lease_until=NULL,error_text=CASE WHEN dispatched_at IS NULL THEN 'The lookup stopped before dispatch. Make a new explicit request to try again.' ELSE 'The lookup stopped after possible paid dispatch. Its allowance remains reserved; a new explicit request is needed.' END WHERE state='running' AND lease_until<=?"
		)
		.run(now, now);
}
function actorForJob(connection: DatabaseConnection, job: Job) {
	const actor = resolveActor(connection, job.actorSessionId);
	if (!actor || actor.userId !== job.actorId)
		throw new AccessError(403, 'The requesting session has ended. Sign in and make a new request.');
	return accessible(connection, actor, job.productId, true);
}
async function htmlSuggestions(url: string, fetchPage: typeof publicFetch) {
	const page = await fetchPage(url);
	const type = String(page.headers['content-type'] ?? '');
	if (
		!type.toLowerCase().includes('text/html') &&
		!type.toLowerCase().includes('application/xhtml+xml')
	)
		throw new Error('The source did not return a product page.');
	return extractMetadata(page.body.toString('utf8'), page.url);
}
async function sourceImage(
	connection: DatabaseConnection,
	job: Job,
	options: WorkerOptions,
	fetchPage: typeof publicFetch
) {
	if (job.mediaId) {
		const image = connection.db
			.select()
			.from(media)
			.where(and(eq(media.id, job.mediaId), eq(media.productId, job.productId)))
			.get();
		if (!image) throw new Error('The selected photo is unavailable.');
		const root = mediaRoot(options);
		const path = resolve(root, image.storagePath);
		if (!path.startsWith(root + '/')) throw new Error('The selected photo is unavailable.');
		return readFile(join(path, '..', 'preview.webp'));
	}
	const product = connection.db
		.select()
		.from(products)
		.where(eq(products.id, job.productId))
		.get()!;
	if (!product.sourceUrl) throw new Error('Add a screenshot or photo before image identification.');
	const candidates = await htmlSuggestions(product.sourceUrl, fetchPage);
	const url = candidates.find((candidate) => candidate.imageUrl)?.imageUrl;
	if (!url)
		throw new Error(
			'This post has no accessible product image. Add a screenshot or a shop photo, or enter the details manually.'
		);
	const image = await fetchPage(url, { maxBytes: MAX_IMAGE_BYTES });
	return image.body;
}
export async function runNextJob(
	connection: DatabaseConnection,
	options: WorkerOptions = {}
): Promise<boolean> {
	const now = options.now ?? Date.now;
	recoverInterruptedJobs(connection, now());
	const job = connection.sqlite
		.transaction(() => {
			const next = connection.db
				.select()
				.from(lookupJobs)
				.where(eq(lookupJobs.state, 'queued'))
				.orderBy(lookupJobs.createdAt)
				.get();
			if (!next) return;
			return connection.db
				.update(lookupJobs)
				.set({ state: 'running', startedAt: now(), leaseUntil: now() + 120000 })
				.where(and(eq(lookupJobs.id, next.id), eq(lookupJobs.state, 'queued')))
				.returning()
				.get();
		})
		.immediate();
	if (!job) return false;
	const fetchPage = options.fetchPage ?? publicFetch;
	let dispatched = false;
	try {
		actorForJob(connection, job);
		let result: LookupResult;
		if (job.kind === 'metadata') {
			const product = connection.db
				.select()
				.from(products)
				.where(eq(products.id, job.productId))
				.get()!;
			const suggestions = await htmlSuggestions(product.sourceUrl!, fetchPage);
			result = {
				suggestions,
				labels: [],
				matchingPages: [],
				message: suggestions.length
					? 'Review this page evidence before confirming any details.'
					: 'No product metadata was found. Add a screenshot or enter the details manually.'
			};
		} else if (job.provider === 'serpapi') {
			const provider =
				options.serpapiProvider === undefined ? createSerpApiProvider() : options.serpapiProvider;
			if (!provider)
				throw new AccessError(
					409,
					'Photo search is not configured. Ask the administrator to set SERPAPI_API_KEY.'
				);
			const guard = () => {
				actorForJob(connection, job);
				if (!getIdentificationSettings(connection).enabled)
					throw new AccessError(409, 'Image identification is disabled. Your saved idea is safe.');
				if (
					!job.mediaId ||
					!connection.db
						.select()
						.from(media)
						.where(and(eq(media.id, job.mediaId), eq(media.productId, job.productId)))
						.get()
				)
					throw new AccessError(404, 'Choose a photo attached to this idea.');
				const current = connection.db
					.select()
					.from(lookupJobs)
					.where(eq(lookupJobs.id, job.id))
					.get();
				if (current?.state !== 'running' || (current.leaseUntil ?? 0) <= now())
					throw new AccessError(409, 'This request no longer owns the lookup.');
			};
			guard();
			const bytes = await sourceImage(connection, job, options, fetchPage);
			connection.sqlite
				.transaction(() => {
					guard();
					reserveSerpApiSearch(connection, job.id, now());
					connection.db
						.update(lookupJobs)
						.set({ dispatchedAt: now() })
						.where(eq(lookupJobs.id, job.id))
						.run();
				})
				.immediate();
			dispatched = true;
			const imageId = await provider.upload(bytes, guard);
			guard();
			const suggestions = await provider.search(imageId);
			for (const suggestion of suggestions.slice(0, 3)) {
				guard();
				try {
					const evidence = (await htmlSuggestions(suggestion.sourceUrl, fetchPage))[0];
					if (evidence) {
						suggestion.title = evidence.title ?? suggestion.title;
						suggestion.description = evidence.description;
						suggestion.variant = evidence.variant;
						if (
							evidence.offer &&
							new URL(evidence.offer.url).origin === new URL(suggestion.sourceUrl).origin
						)
							suggestion.offer = { ...evidence.offer, url: suggestion.sourceUrl };
						suggestion.uncertainty = [...suggestion.uncertainty, ...evidence.uncertainty];
					}
				} catch {
					suggestion.uncertainty.push(
						'The retailer page could not be read; inspect the destination yourself.'
					);
				}
			}
			guard();
			result = {
				provider: 'serpapi',
				suggestions,
				labels: [],
				matchingPages: suggestions.map((item) => item.sourceUrl),
				message: suggestions.length
					? 'Possible image matches. Inspect the exact product and variant before adding a link; adding does not check it.'
					: 'No buying pages were matched. Your photo is safe; try another photo or enter a shopping link manually.'
			};
		} else {
			const provider = options.provider === undefined ? createVisionProvider() : options.provider;
			if (!provider)
				throw new Error(
					'Personal Vision credentials are not configured. Add a screenshot and enter the details manually.'
				);
			const bytes = await sourceImage(connection, job, options, fetchPage);
			const derivative = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false })
				.rotate()
				.resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
				.jpeg({ quality: 85 })
				.toBuffer();
			connection.sqlite
				.transaction(() => {
					actorForJob(connection, job);
					const current = connection.db
						.select()
						.from(lookupJobs)
						.where(eq(lookupJobs.id, job.id))
						.get();
					if (current?.state !== 'running' || (current.leaseUntil ?? 0) <= now())
						throw new Error('This request no longer owns the lookup.');
					reserveAllowance(connection, job.id, provider.projectId, now());
					connection.db
						.update(lookupJobs)
						.set({ dispatchedAt: now() })
						.where(eq(lookupJobs.id, job.id))
						.run();
				})
				.immediate();
			dispatched = true;
			const matches = await provider.detect(derivative);
			const suggestions: ProductSuggestion[] = [];
			for (const url of matches.pages.slice(0, 3)) {
				try {
					suggestions.push(...(await htmlSuggestions(url, fetchPage)).slice(0, 3));
				} catch {
					suggestions.push({
						title: null,
						description: null,
						variant: null,
						imageUrl: null,
						sourceUrl: url,
						retrievedAt: now(),
						source: 'vision-page',
						offer: {
							url,
							retailer: null,
							priceMinor: null,
							currency: null,
							priceText: null,
							fromPrice: false
						},
						uncertainty: ['Image match only; check the product and variant at the retailer.']
					});
				}
			}
			result = {
				suggestions: suggestions.slice(0, 8),
				labels: matches.labels,
				matchingPages: matches.pages,
				message: suggestions.length
					? 'Image matches are suggestions. Check the exact product, variant and retailer price.'
					: 'No buying pages were matched. Keep this photo and enter the details manually.'
			};
		}
		connection.sqlite
			.transaction(() => {
				actorForJob(connection, job);
				if (job.provider === 'serpapi') {
					if (
						!getIdentificationSettings(connection).enabled ||
						!job.mediaId ||
						!connection.db
							.select()
							.from(media)
							.where(and(eq(media.id, job.mediaId), eq(media.productId, job.productId)))
							.get()
					)
						throw new AccessError(
							409,
							'Photo search access or settings changed. Make a new explicit request after reviewing them.'
						);
				}
				connection.db
					.update(lookupJobs)
					.set({
						state: 'succeeded',
						resultJson: JSON.stringify(result),
						finishedAt: now(),
						leaseUntil: null
					})
					.where(and(eq(lookupJobs.id, job.id), eq(lookupJobs.state, 'running')))
					.run();
			})
			.immediate();
	} catch (error) {
		const message = dispatched
			? job.provider === 'serpapi'
				? 'The photo-search result is uncertain or unavailable. Its search slot remains reserved. Make a new explicit request to try again.'
				: 'The paid result is uncertain or unavailable. Its allowance remains reserved. Make a new explicit request to try again.'
			: error instanceof AccessError
				? error.message
				: 'This source could not be read or identified. Add a screenshot or photo, or enter the details manually.';
		connection.db
			.update(lookupJobs)
			.set({
				state: dispatched ? 'uncertain' : 'failed',
				errorText: message,
				finishedAt: now(),
				leaseUntil: null
			})
			.where(and(eq(lookupJobs.id, job.id), eq(lookupJobs.state, 'running')))
			.run();
	}
	return true;
}
const confirmSchema = z.object({
	jobId: z.string().min(1),
	index: z.number().int().min(0).max(7),
	fields: z.array(z.enum(['title', 'description', 'variant', 'offer', 'image'])).min(1)
});
export function confirmSuggestion(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	productId: string,
	options: MediaOptions & { fetchPage?: typeof publicFetch } = {}
) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		requireAdministrator(connection, event.locals.actor);
		const parsed = confirmSchema.safeParse(await event.request.json());
		if (!parsed.success)
			throw new AccessError(400, 'Choose the suggested fields you want to confirm.');
		const input = parsed.data;
		function candidate() {
			const actor = requireAdministrator(connection, event.locals.actor);
			accessible(connection, actor, productId);
			const job = connection.db
				.select()
				.from(lookupJobs)
				.where(and(eq(lookupJobs.id, input.jobId), eq(lookupJobs.productId, productId)))
				.get();
			const suggestion =
				job?.state === 'succeeded' && job.resultJson
					? (JSON.parse(job.resultJson) as LookupResult).suggestions[input.index]
					: undefined;
			if (!suggestion) throw new AccessError(404, 'Suggestion not found.');
			return { suggestion, job: job! };
		}
		const { suggestion } = candidate();
		let prepared: Awaited<ReturnType<typeof prepareMedia>> | undefined;
		let committed = false;
		const filename = `retailer-${input.jobId}-${input.index}.image`;
		try {
			if (
				input.fields.includes('image') &&
				suggestion.imageUrl &&
				!connection.db
					.select()
					.from(media)
					.where(and(eq(media.productId, productId), eq(media.originalName, filename)))
					.get()
			) {
				const response = await (options.fetchPage ?? publicFetch)(suggestion.imageUrl, {
					maxBytes: MAX_IMAGE_BYTES
				});
				prepared = await prepareMedia(
					[new File([new Uint8Array(response.body)], filename)],
					options
				);
			}
			connection.sqlite
				.transaction(() => {
					const { suggestion: current, job } = candidate();
					const product = connection.db
						.select()
						.from(products)
						.where(eq(products.id, productId))
						.get()!;
					const updates: Partial<typeof products.$inferInsert> = { updatedAt: Date.now() };
					for (const field of ['title', 'description', 'variant'] as const)
						if (input.fields.includes(field) && current[field]) updates[field] = current[field];
					if (
						(updates.title !== undefined && updates.title !== product.title) ||
						(updates.variant !== undefined && updates.variant !== product.variant)
					)
						invalidateOfferChecks(connection, productId);
					connection.db.update(products).set(updates).where(eq(products.id, productId)).run();
					if (input.fields.includes('offer') && current.offer)
						acceptSuggestedOffer(connection, {
							productId,
							jobId: job.id,
							index: input.index,
							suggestion: current,
							provider: job.provider,
							kind: job.kind
						});
					if (
						prepared &&
						!connection.db
							.select()
							.from(media)
							.where(and(eq(media.productId, productId), eq(media.originalName, filename)))
							.get()
					) {
						for (const image of prepared.media)
							connection.db
								.insert(media)
								.values({ ...image, productId })
								.run();
						committed = true;
					}
				})
				.immediate();
			return { confirmed: true };
		} catch (error) {
			committed = false;
			throw error;
		} finally {
			if (prepared && !committed) await prepared.cleanup();
		}
	});
}
export function attachIdentificationPhoto(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	productId: string,
	options: MediaOptions = {}
) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const actor = requireAdministrator(connection, event.locals.actor);
		const body = await event.request.formData();
		const operationId = body.get('operationId');
		const file = body.get('photo');
		if (
			typeof operationId !== 'string' ||
			!z.uuid().safeParse(operationId).success ||
			!(file instanceof File)
		)
			throw new AccessError(400, 'Choose a photo and a valid upload identifier.');
		accessible(connection, actor, productId);
		const digest = createHash('sha256')
			.update(productId)
			.update(Buffer.from(await file.arrayBuffer()))
			.digest('hex');
		const prepared = await prepareMedia([file], options);
		let committed = false;
		try {
			return connection.sqlite
				.transaction(() => {
					requireAdministrator(connection, event.locals.actor);
					accessible(connection, event.locals.actor, productId);
					const existing = connection.db
						.select()
						.from(lookupJobs)
						.where(
							and(eq(lookupJobs.actorId, actor.userId), eq(lookupJobs.operationId, operationId))
						)
						.get();
					if (existing) {
						if (existing.kind !== 'attachment' || existing.fingerprint !== digest)
							throw new AccessError(
								409,
								'This upload identifier was already used for different details.'
							);
						return { attached: true };
					}
					for (const image of prepared.media)
						connection.db
							.insert(media)
							.values({ ...image, productId })
							.run();
					connection.db
						.insert(lookupJobs)
						.values({
							id: randomUUID(),
							productId,
							actorId: actor.userId,
							actorSessionId: actor.sessionId,
							operationId,
							fingerprint: digest,
							kind: 'attachment',
							state: 'succeeded',
							finishedAt: Date.now()
						})
						.run();
					committed = true;
					return { attached: true };
				})
				.immediate();
		} catch (error) {
			committed = false;
			throw error;
		} finally {
			if (!committed) await prepared.cleanup();
		}
	});
}
