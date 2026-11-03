import { load } from 'cheerio';
import { parsePriceMinor } from '../../catalogue-types';
import type { ProductSuggestion } from './types';
type Data = Record<string, unknown>;
function object(value: unknown): Data {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
}
function plain(value: unknown): string | null {
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const text = load(String(value)).text().trim().slice(0, 4000);
	return text || null;
}
export function evidenceUrl(value: unknown, base: string): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value, base);
		return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}
function image(value: unknown, base: string): string | null {
	if (Array.isArray(value)) return image(value[0], base);
	return evidenceUrl(
		typeof value === 'object' ? (object(value).url ?? object(value).contentUrl) : value,
		base
	);
}
function kind(value: unknown, name: string) {
	return (Array.isArray(value) ? value : [value]).some(
		(type) => typeof type === 'string' && (type === name || type === `https://schema.org/${name}`)
	);
}
export function extractMetadata(
	html: string,
	sourceUrl: string,
	retrievedAt = Date.now()
): ProductSuggestion[] {
	const $ = load(html);
	const meta = (name: string) =>
		$(`meta[property="${name}"],meta[name="${name}"]`).first().attr('content');
	const fallbackImage = image(meta('og:image'), sourceUrl);
	const found: Data[] = [];
	let visited = 0;
	function walk(value: unknown, depth = 0) {
		if (depth > 8 || ++visited > 500) return;
		if (Array.isArray(value)) {
			for (const part of value) walk(part, depth + 1);
			return;
		}
		const node = object(value);
		if (kind(node['@type'], 'Product') || kind(node['@type'], 'ProductGroup')) {
			found.push(node);
			return;
		}
		for (const [key, child] of Object.entries(node))
			if (key === '@graph' || key === 'mainEntity' || key === 'itemListElement' || key === 'item')
				walk(child, depth + 1);
	}
	$('script[type="application/ld+json"]').each((_, script) => {
		try {
			walk(JSON.parse($(script).text()));
		} catch {}
	});
	const suggestions = found.slice(0, 8).map((node) => {
		const uncertainty: string[] = [];
		const rawOffers = Array.isArray(node.offers) ? node.offers : [node.offers];
		const offer = object(rawOffers[0]);
		const fromPrice = kind(offer['@type'], 'AggregateOffer') || offer.lowPrice !== undefined;
		const priceText = plain(offer.price ?? offer.lowPrice);
		const currency =
			typeof offer.priceCurrency === 'string' && /^[A-Z]{3}$/.test(offer.priceCurrency)
				? offer.priceCurrency
				: null;
		let priceMinor: number | null = null;
		if (priceText && currency) {
			try {
				priceMinor = parsePriceMinor(priceText, currency);
			} catch {
				uncertainty.push('The published price could not be read reliably.');
			}
		}
		if (priceText && !currency) uncertainty.push('The price currency is missing.');
		if (fromPrice)
			uncertainty.push('This is a from-price; check the chosen variant at the retailer.');
		const variants = Array.isArray(node.hasVariant) && node.hasVariant.length > 1;
		if (variants || rawOffers.length > 1)
			uncertainty.push('Several variants or offers are shown; confirm the exact variant.');
		const variant = variants
			? null
			: [plain(node.color), plain(node.size), plain(node.model)].filter(Boolean).join(' · ') ||
				null;
		return {
			title: plain(node.name),
			description: plain(node.description),
			variant,
			imageUrl: image(node.image, sourceUrl) ?? fallbackImage,
			sourceUrl,
			retrievedAt,
			source: 'json-ld' as const,
			offer: Object.keys(offer).length
				? {
						url: evidenceUrl(offer.url, sourceUrl) ?? sourceUrl,
						retailer: plain(object(offer.seller).name) ?? plain(meta('og:site_name')),
						priceMinor,
						currency,
						priceText,
						fromPrice
					}
				: null,
			uncertainty
		};
	});
	if (suggestions.length) return suggestions;
	const title = plain(meta('og:title')) ?? plain($('title').first().text());
	const description = plain(meta('og:description')) ?? plain(meta('description'));
	const priceText = plain(meta('product:price:amount') ?? meta('og:price:amount'));
	const rawCurrency = meta('product:price:currency') ?? meta('og:price:currency');
	const currency = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;
	const uncertainty = ['Page metadata may describe a post rather than a product.'];
	let priceMinor: number | null = null;
	if (priceText && currency) {
		try {
			priceMinor = parsePriceMinor(priceText, currency);
		} catch {
			uncertainty.push('The published price could not be read reliably.');
		}
	}
	if (priceText && !currency) uncertainty.push('The price currency is missing.');
	const offer = priceText
		? {
				url: sourceUrl,
				retailer: plain(meta('og:site_name')),
				priceMinor,
				currency,
				priceText,
				fromPrice: false
			}
		: null;
	return title || description || fallbackImage || offer
		? [
				{
					title,
					description,
					variant: null,
					imageUrl: fallbackImage,
					sourceUrl,
					retrievedAt,
					source: 'open-graph',
					offer,
					uncertainty
				}
			]
		: [];
}
