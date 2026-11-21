import { emptyDraft, type CaptureDraft } from '../catalogue-types';
import type { WishlistImportedItem, WishlistImportResponse } from '../server/enrichment/wishlist';
import { DuplicateIndex } from '../shared/wishlist';
import { draftStore, type DraftStore, type LocalDraft } from './drafts';
import { refreshCaptureIdentity } from './sync';

export type WishlistIngestProgress = {
	phase: 'fetching-list' | 'saving-drafts' | 'fetching-images' | 'done';
	completed: number;
	total: number;
};

export type WishlistIngestResult = {
	listTitle: string | null;
	importedDrafts: LocalDraft[];
	totalFound: number;
	skippedDuplicates: number;
};

export function draftFromWishlistItem(
	item: WishlistImportedItem,
	listTitle: string | null
): CaptureDraft {
	const draft = emptyDraft();
	draft.title = item.title;
	draft.sourceUrl = item.sourceUrl;
	const notes: string[] = [];
	if (item.brand && !item.title.toLowerCase().includes(item.brand.toLowerCase()))
		notes.push(`Brand: ${item.brand}`);
	if (listTitle) notes.push(`Imported from Amazon list: ${listTitle}`);
	if (item.priceText) notes.push(`Observed price: ${item.priceText} (${item.currency})`);
	draft.sourceText = notes.join('\n');
	if (item.currency === 'GBP' && item.price) {
		draft.estimate = item.price;
	}
	draft.offers = [
		{
			url: item.sourceUrl,
			retailer: item.retailer || 'Amazon',
			price: item.price,
			currency: item.currency || 'GBP'
		}
	];
	if (item.imageUrl) {
		draft.browserCapture = {
			sourceUrl: item.sourceUrl,
			imageUrl: item.imageUrl,
			capturedAt: Date.now(),
			pendingReview: false
		};
	}
	return draft;
}

const inFlightThumbnails = new Map<string, Promise<boolean>>();

export async function downloadDraftThumbnail(
	record: LocalDraft,
	store: DraftStore = draftStore,
	transport: typeof fetch = fetch,
	signal?: AbortSignal
): Promise<boolean> {
	const imageUrl = record.draft.browserCapture?.imageUrl;
	if (!imageUrl) return false;
	const dedupKey = `${store.name}:${record.id}`;
	const existingTask = inFlightThumbnails.get(dedupKey);
	if (existingTask) return existingTask;
	const task = (async () => {
		try {
			const existing = await store.firstPhoto(record.id, record.ownerId);
			if (existing) return true;
			const response = await transport('/api/metadata/image', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: imageUrl }),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(12000)])
					: AbortSignal.timeout(12000)
			});
			if (!response.ok) return false;
			const blob = await response.blob();
			const file = new File([blob], 'wishlist-image.webp', { type: 'image/webp' });
			return await store.attachThumbnail(record.id, record.ownerId, file);
		} catch {
			return false;
		} finally {
			inFlightThumbnails.delete(dedupKey);
		}
	})();
	inFlightThumbnails.set(dedupKey, task);
	return task;
}

export async function ingestAmazonWishlist(options: {
	url: string;
	store?: DraftStore;
	transport?: typeof fetch;
	onProgress?: (progress: WishlistIngestProgress) => void;
	signal?: AbortSignal;
	awaitThumbnails?: boolean;
}): Promise<WishlistIngestResult> {
	const store = options.store ?? draftStore;
	const transport = options.transport ?? fetch;

	options.onProgress?.({ phase: 'fetching-list', completed: 0, total: 0 });

	let ownerId = (await store.current())?.ownerId ?? null;
	if (!ownerId && (typeof navigator === 'undefined' || navigator.onLine)) {
		try {
			const person = await refreshCaptureIdentity(store, transport);
			if (person?.member) ownerId = person.id;
		} catch {}
	}

	const response = await transport('/api/wishlist', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ url: options.url.trim() }),
		signal: options.signal
			? AbortSignal.any([options.signal, AbortSignal.timeout(60000)])
			: AbortSignal.timeout(60000)
	});
	const result = (await response.json().catch(() => null)) as
		(WishlistImportResponse & { message?: string }) | null;
	if (!response.ok || !result || !Array.isArray(result.items)) {
		throw new Error(
			result?.message ||
				'We could not import this Amazon wishlist. Check that the link is a public Amazon wishlist or idea list.'
		);
	}

	const existingOwn = ownerId ? await store.list(ownerId) : [];
	const existingUnbound = await store.list(null);
	const localActive = [...existingOwn, ...existingUnbound].filter(
		(record) => record.status !== 'saved'
	);

	const duplicateIndex = new DuplicateIndex(
		localActive.map((record) => ({
			title: record.draft.title,
			sourceUrl: record.draft.sourceUrl,
			offers: record.draft.offers
		}))
	);

	let skippedDuplicates = result.skippedDuplicates ?? 0;
	const toCreate: WishlistImportedItem[] = [];
	for (const item of result.items) {
		const candidate = {
			title: item.title,
			sourceUrl: item.sourceUrl,
			offers: [{ url: item.sourceUrl }]
		};
		if (duplicateIndex.has(candidate)) {
			skippedDuplicates++;
			continue;
		}
		duplicateIndex.add(candidate);
		toCreate.push(item);
	}

	options.onProgress?.({
		phase: 'saving-drafts',
		completed: 0,
		total: toCreate.length
	});

	const importedDrafts: LocalDraft[] = [];
	for (let i = 0; i < toCreate.length; i++) {
		if (options.signal?.aborted) break;
		const item = toCreate[i];
		const draft = draftFromWishlistItem(item, result.listTitle);
		const saved = await store.save({
			ownerId,
			draft,
			photos: [],
			submit: false,
			incomingShare: false
		});
		importedDrafts.push(saved);
		options.onProgress?.({
			phase: 'saving-drafts',
			completed: i + 1,
			total: toCreate.length
		});
	}

	const withImages = importedDrafts.filter((record) => !!record.draft.browserCapture?.imageUrl);
	if (withImages.length > 0) {
		const downloadAll = async () => {
			let completed = 0;
			const concurrency = 4;
			const queue = [...withImages];
			const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
				while (queue.length > 0 && !options.signal?.aborted) {
					const next = queue.shift();
					if (!next) break;
					await downloadDraftThumbnail(next, store, transport, options.signal);
					completed++;
					options.onProgress?.({
						phase: 'fetching-images',
						completed,
						total: withImages.length
					});
				}
			});
			await Promise.all(workers);
		};
		if (options.awaitThumbnails) {
			await downloadAll();
		} else {
			void downloadAll();
		}
	}

	options.onProgress?.({
		phase: 'done',
		completed: importedDrafts.length,
		total: importedDrafts.length
	});

	return {
		listTitle: result.listTitle,
		importedDrafts,
		totalFound: result.totalFound,
		skippedDuplicates
	};
}
