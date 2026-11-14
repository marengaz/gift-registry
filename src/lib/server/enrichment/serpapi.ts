import sharp from 'sharp';
import { MAX_IMAGE_PIXELS } from '../media';
import { publicUrl } from './fetch';
import type { ProductSuggestion } from './types';

export type SerpApiProvider = {
	upload(bytes: Buffer, beforeDispatch?: () => void): Promise<string>;
	search(imageId: string): Promise<ProductSuggestion[]>;
};
export function serpapiConfigured() {
	return !!process.env.SERPAPI_API_KEY?.trim();
}
export async function prepareSerpApiImage(bytes: Buffer): Promise<Buffer> {
	for (const width of [1200, 900, 640, 400]) {
		for (const quality of [85, 65, 45]) {
			const derivative = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false })
				.rotate()
				.resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
				.jpeg({ quality })
				.toBuffer();
			if (derivative.length <= 480000) return derivative;
		}
	}
	throw new Error('The photo could not be compressed for image search.');
}
function text(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null;
}
function destination(value: unknown) {
	try {
		if (typeof value !== 'string') return null;
		const url = publicUrl(value);
		if (
			/(^|\.)serpapi\.com$/.test(url.hostname) ||
			(/(^|\.)google\.[a-z.]+$/.test(url.hostname) && /^\/(search|lens)(\/|$)/.test(url.pathname))
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}
export function serpapiCandidates(value: unknown, now = Date.now()): ProductSuggestion[] {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Image search returned an unreadable result.');
	const body = value as Record<string, unknown>;
	if (body.error) throw new Error('Image search did not provide a result.');
	const matches = body.visual_matches;
	if (
		matches === undefined &&
		(body.search_metadata as { status?: unknown } | undefined)?.status === 'Success'
	)
		return [];
	if (!Array.isArray(matches)) throw new Error('Image search returned an unreadable result.');
	const seen = new Set<string>();
	const candidates: ProductSuggestion[] = [];
	for (const match of matches) {
		if (!match || typeof match !== 'object') continue;
		const url = destination(match.link);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const price = match.price;
		const currency =
			price &&
			typeof price === 'object' &&
			typeof price.currency === 'string' &&
			['GBP', 'USD', 'EUR'].includes(price.currency.toUpperCase())
				? price.currency.toUpperCase()
				: price?.currency === '£'
					? 'GBP'
					: null;
		const amount = typeof price?.extracted_value === 'number' ? price.extracted_value : NaN;
		const minor =
			currency &&
			Number.isFinite(amount) &&
			amount >= 0 &&
			Number.isSafeInteger(Math.round(amount * 100))
				? Math.round(amount * 100)
				: null;
		candidates.push({
			title: text(match.title),
			description: null,
			variant: null,
			imageUrl: null,
			sourceUrl: url,
			retrievedAt: now,
			source: 'serpapi',
			offer: {
				url,
				retailer: text(match.source) ?? new URL(url).hostname,
				priceMinor: minor,
				currency,
				priceText: text(price?.value),
				fromPrice: /\bfrom\b|starting|\+$|[-–]\s*[£$€]?\d/i.test(text(price?.value) ?? '')
			},
			uncertainty: [
				'Possible image match only; check the exact product and variant at the retailer.',
				...(minor === null
					? ['A supported current price and currency could not be confirmed.']
					: ['Search-result price may be out of date.'])
			]
		});
	}
	return candidates
		.sort(
			(a, b) =>
				Number(/\.(co\.uk|org\.uk|uk)$/.test(new URL(b.sourceUrl).hostname)) -
				Number(/\.(co\.uk|org\.uk|uk)$/.test(new URL(a.sourceUrl).hostname))
		)
		.slice(0, 6);
}
export function createSerpApiProvider(
	options: {
		apiKey?: string;
		fetch?: typeof fetch;
		timeoutMs?: number;
		maxBytes?: number;
		now?: () => number;
	} = {}
): SerpApiProvider | null {
	const key = options.apiKey ?? process.env.SERPAPI_API_KEY?.trim();
	if (!key) return null;
	const fetcher = options.fetch ?? fetch;
	async function request(url: string | URL, init: RequestInit) {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			return await Promise.race([
				(async () => {
					const response = await fetcher(url, {
						...init,
						redirect: 'error',
						signal: controller.signal
					});
					if (!response.ok || response.redirected || !response.body) throw new Error();
					const maximum = options.maxBytes ?? 1024 * 1024;
					if (Number(response.headers.get('content-length')) > maximum) throw new Error();
					reader = response.body.getReader();
					const chunks: Uint8Array[] = [];
					let size = 0;
					while (true) {
						const part = await reader.read();
						if (part.done) break;
						size += part.value.length;
						if (size > maximum) throw new Error();
						chunks.push(part.value);
					}
					return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
				})(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						void reader?.cancel().catch(() => {});
						reject(new Error());
					}, options.timeoutMs ?? 30000);
				})
			]);
		} catch {
			controller.abort();
			void reader?.cancel().catch(() => {});
			throw new Error(
				'Image search is unavailable or returned an unreadable response. Its result may be uncertain.'
			);
		} finally {
			clearTimeout(timer);
		}
	}
	return {
		async upload(bytes, beforeDispatch) {
			const derivative = await prepareSerpApiImage(bytes);
			const body = new FormData();
			body.set('api_key', key);
			body.set(
				'image',
				new Blob([new Uint8Array(derivative)], { type: 'image/jpeg' }),
				'photo.jpg'
			);
			beforeDispatch?.();
			const result = (await request('https://serpapi.com/image', { method: 'POST', body })) as {
				image_id?: unknown;
				error?: unknown;
			};
			if (
				!result ||
				result.error ||
				typeof result.image_id !== 'string' ||
				!result.image_id ||
				result.image_id.length > 2048
			)
				throw new Error('Image search could not accept the photo.');
			return result.image_id;
		},
		async search(imageId) {
			const url = new URL('https://serpapi.com/search.json');
			url.search = new URLSearchParams({
				engine: 'google_lens',
				image_id: imageId,
				type: 'visual_matches',
				country: 'gb',
				hl: 'en-gb',
				safe: 'active',
				api_key: key
			}).toString();
			return serpapiCandidates(await request(url, { method: 'GET' }), options.now?.());
		}
	};
}
