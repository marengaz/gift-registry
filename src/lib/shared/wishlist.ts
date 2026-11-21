export function extractAmazonAsin(value: string): string | null {
	const raw = value.trim();
	if (!raw) return null;
	const rawMatch = raw.match(/^amzn1\.asin\.([A-Z0-9]{10})(?:[:?#]|$)/i);
	if (rawMatch) return rawMatch[1].toUpperCase();
	try {
		const url = new URL(raw);
		if (!['http:', 'https:'].includes(url.protocol)) return null;
		const host = url.hostname.toLowerCase().replace(/^www\d*\./, '');
		const isAmazon =
			host === 'a.co' ||
			host === 'amzn.to' ||
			host === 'amzn.eu' ||
			host === 'amazon.com' ||
			host.startsWith('amazon.');
		if (!isAmazon) return null;
		const pathMatch = url.pathname.match(
			/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/exec\/obidos\/ASIN\/|\/product\/)([A-Z0-9]{10})(?:[/?&#]|$)/i
		);
		if (pathMatch) return pathMatch[1].toUpperCase();
		const paramAsin = url.searchParams.get('creativeASIN') ?? url.searchParams.get('asin');
		if (paramAsin && /^[A-Z0-9]{10}$/i.test(paramAsin)) return paramAsin.toUpperCase();
	} catch {}
	return null;
}

export function normaliseProductUrl(value: string): string {
	try {
		const url = new URL(value.trim());
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
		const asin = extractAmazonAsin(url.href);
		if (asin) {
			const host = url.hostname.toLowerCase().replace(/^www\d*\./, '');
			const domain = host.startsWith('amazon.') ? `www.${host}` : 'www.amazon.com';
			return `https://${domain}/dp/${asin}`;
		}
		url.hash = '';
		for (const key of [...url.searchParams.keys()])
			if (
				/^utm_/i.test(key) ||
				[
					'fbclid',
					'gclid',
					'ref',
					'ref_',
					'tag',
					'linkCode',
					'creativeASIN',
					'asc_item-id',
					'social_share',
					'originMarketplaceId'
				].includes(key)
			)
				url.searchParams.delete(key);
		url.searchParams.sort();
		return url.href;
	} catch {
		return '';
	}
}

export function normaliseProductTitle(value: string): string {
	return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
}

export type DuplicateCheckCandidate = {
	title?: string | null;
	sourceUrl?: string | null;
	offers?: Array<{ url?: string | null }>;
};

export function candidateIdentityKeys(candidate: DuplicateCheckCandidate): {
	asins: string[];
	urls: string[];
	title: string;
} {
	const asins = new Set<string>();
	const urls = new Set<string>();
	const allUrls = [
		candidate.sourceUrl ?? '',
		...(candidate.offers ?? []).map((offer) => offer.url ?? '')
	];
	for (const rawUrl of allUrls) {
		if (!rawUrl.trim()) continue;
		const asin = extractAmazonAsin(rawUrl);
		if (asin) asins.add(asin);
		const norm = normaliseProductUrl(rawUrl);
		if (norm) urls.add(norm);
	}
	return {
		asins: [...asins],
		urls: [...urls],
		title: normaliseProductTitle(candidate.title ?? '')
	};
}

export class DuplicateIndex {
	private asins = new Set<string>();
	private urls = new Set<string>();
	private titles = new Set<string>();

	constructor(existing: DuplicateCheckCandidate[] = []) {
		for (const item of existing) this.add(item);
	}

	has(candidate: DuplicateCheckCandidate): boolean {
		const keys = candidateIdentityKeys(candidate);
		for (const asin of keys.asins) if (this.asins.has(asin)) return true;
		for (const url of keys.urls) if (this.urls.has(url)) return true;
		if (keys.title && this.titles.has(keys.title)) return true;
		return false;
	}

	add(candidate: DuplicateCheckCandidate): void {
		const keys = candidateIdentityKeys(candidate);
		for (const asin of keys.asins) this.asins.add(asin);
		for (const url of keys.urls) this.urls.add(url);
		if (keys.title) this.titles.add(keys.title);
	}
}
