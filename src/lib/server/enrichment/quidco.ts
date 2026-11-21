import { AccessError, canCapture, requireMember } from '../access';
import type { CatalogueEvent } from '../catalogue';
import type { DatabaseConnection } from '../db/client';
import { apiResponse } from '../http';
import { quidcoSearchUrl, registrableDomain } from '../../shared/quidco';

export { quidcoSearchUrl, registrableDomain };

export const DEFAULT_QUIDCO_MERCHANTS_URL =
	'https://tbd.cashbacksrv.com/quidco_com/p/merchants.json';
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
const MAX_COUPON_LENGTH = 255;

export type QuidcoMerchant = {
	domain: string;
	name: string;
	reward: string;
	rewardP2?: string | null;
	url?: string | null;
};

export type QuidcoCatalog = {
	merchantsByDomain: Map<string, QuidcoMerchant>;
};

export type QuidcoLookupResult = {
	domain: string | null;
	cashback: string | null;
	merchantName: string | null;
	quidcoUrl: string | null;
	searchUrl: string | null;
	available: boolean;
};

export type QuidcoLookupOptions = {
	catalogUrl?: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
};

type CacheState = {
	sourceUrl: string;
	catalog: QuidcoCatalog | null;
	etag: string | null;
	fetchedAt: number;
	failedUntil: number;
	inFlight: Promise<QuidcoCatalog | null> | null;
};

let cache: CacheState = {
	sourceUrl: '',
	catalog: null,
	etag: null,
	fetchedAt: 0,
	failedUntil: 0,
	inFlight: null
};

export function resetQuidcoCache() {
	cache = {
		sourceUrl: '',
		catalog: null,
		etag: null,
		fetchedAt: 0,
		failedUntil: 0,
		inFlight: null
	};
}

function safeQuidcoUrl(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim() || !URL.canParse(value.trim())) return null;
	const parsed = new URL(value.trim());
	if (parsed.protocol !== 'https:') return null;
	const host = parsed.hostname.toLowerCase();
	if (host !== 'quidco.com' && host !== 'www.quidco.com') return null;
	return parsed.href;
}

export function formatCashbackCode(reward: string): string | null {
	const trimmed = reward.trim().replace(/\s+/g, ' ');
	if (!trimmed || !/\d/.test(trimmed)) return null;
	return `Quidco: ${trimmed}`.slice(0, MAX_COUPON_LENGTH);
}

function normaliseCatalogEntry(raw: string): { host: string; hasPath: boolean } | null {
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/^www\d*\./, '')
		.replace(/\/+$/, '');
	if (!cleaned) return null;
	const slash = cleaned.indexOf('/');
	const host = slash === -1 ? cleaned : cleaned.slice(0, slash);
	return host ? { host, hasPath: slash !== -1 } : null;
}

export function parseQuidcoCatalog(raw: unknown): QuidcoCatalog {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		throw new Error('Invalid Quidco catalog');
	const record = raw as Record<string, unknown>;
	const rawMerchants = Array.isArray(record.merchants) ? record.merchants : [];
	const merchantsByDomain = new Map<string, QuidcoMerchant>();
	const ranks = new Map<string, number>();

	for (const item of rawMerchants) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
		const entry = item as Record<string, unknown>;
		const parsedDomain =
			typeof entry.domain === 'string' ? normaliseCatalogEntry(entry.domain) : null;
		const reward = typeof entry.reward === 'string' ? entry.reward.trim() : '';
		if (!parsedDomain || !reward) continue;
		const topDomain = registrableDomain(parsedDomain.host);
		if (!topDomain) continue;

		// Prefer exact top-level domain entries (rank 2) over subdomain entries (rank 1) over path-scoped entries (rank 0).
		const rank = parsedDomain.hasPath ? 0 : parsedDomain.host === topDomain ? 2 : 1;
		const existingRank = ranks.get(topDomain) ?? -1;
		if (rank <= existingRank) continue;

		const name = typeof entry.name === 'string' ? entry.name.trim() : topDomain;
		ranks.set(topDomain, rank);
		merchantsByDomain.set(topDomain, {
			domain: topDomain,
			name: name || topDomain,
			reward,
			rewardP2: typeof entry.reward_p2 === 'string' ? entry.reward_p2.trim() || null : null,
			url: safeQuidcoUrl(entry.url)
		});
	}
	return { merchantsByDomain };
}

export function matchQuidcoMerchant(
	rawUrlOrDomain: string,
	catalog: QuidcoCatalog
): QuidcoMerchant | null {
	const topDomain = registrableDomain(rawUrlOrDomain);
	if (!topDomain) return null;
	return catalog.merchantsByDomain.get(topDomain) ?? null;
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) {
		const text = await response.text();
		if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Quidco catalog too large');
		return text;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new Error('Quidco catalog too large');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function fetchCatalog(
	sourceUrl: string,
	fetchImpl: typeof fetch,
	now: () => number
): Promise<QuidcoCatalog | null> {
	if (cache.sourceUrl !== sourceUrl) {
		cache = {
			sourceUrl,
			catalog: null,
			etag: null,
			fetchedAt: 0,
			failedUntil: 0,
			inFlight: null
		};
	}
	const activeCache = cache;
	const timestamp = now();
	if (activeCache.catalog && timestamp - activeCache.fetchedAt < CATALOG_TTL_MS)
		return activeCache.catalog;
	if (timestamp < activeCache.failedUntil) return activeCache.catalog;
	if (activeCache.inFlight) return activeCache.inFlight;

	const request = (async () => {
		try {
			const headers: Record<string, string> = {
				Accept: 'application/json',
				'User-Agent': 'FamilyGiftCatalogue/1.0'
			};
			if (activeCache.etag && activeCache.catalog) headers['If-None-Match'] = activeCache.etag;
			const response = await fetchImpl(sourceUrl, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
			});
			if (cache !== activeCache) return null;
			if (response.status === 304 && activeCache.catalog) {
				activeCache.fetchedAt = now();
				activeCache.failedUntil = 0;
				return activeCache.catalog;
			}
			if (!response.ok) {
				activeCache.failedUntil = now() + FAILURE_BACKOFF_MS;
				return activeCache.catalog;
			}
			const declaredLength = Number(response.headers.get('content-length') ?? '0');
			if (declaredLength > MAX_CATALOG_BYTES) {
				activeCache.failedUntil = now() + FAILURE_BACKOFF_MS;
				return activeCache.catalog;
			}
			const text = await readResponseTextWithLimit(response, MAX_CATALOG_BYTES);
			if (cache !== activeCache) return null;
			const parsed = parseQuidcoCatalog(JSON.parse(text));
			activeCache.catalog = parsed;
			activeCache.etag = response.headers.get('etag');
			activeCache.fetchedAt = now();
			activeCache.failedUntil = 0;
			return parsed;
		} catch {
			if (cache === activeCache) activeCache.failedUntil = now() + FAILURE_BACKOFF_MS;
			return activeCache.catalog;
		} finally {
			if (cache === activeCache) activeCache.inFlight = null;
		}
	})();

	activeCache.inFlight = request;
	return request;
}

export async function lookupQuidcoCashback(
	rawUrlOrDomain: string,
	options: QuidcoLookupOptions = {}
): Promise<QuidcoLookupResult> {
	const domain = registrableDomain(rawUrlOrDomain);
	const searchUrl = domain ? quidcoSearchUrl(domain) : null;
	if (!domain || !searchUrl) {
		return {
			domain: null,
			cashback: null,
			merchantName: null,
			quidcoUrl: null,
			searchUrl: null,
			available: true
		};
	}
	const rawConfigured = (options.catalogUrl ?? process.env.QUIDCO_MERCHANTS_URL ?? '').trim();
	if (rawConfigured.toLowerCase() === 'disabled') {
		return {
			domain,
			cashback: null,
			merchantName: null,
			quidcoUrl: null,
			searchUrl,
			available: false
		};
	}
	const configuredUrl = rawConfigured || DEFAULT_QUIDCO_MERCHANTS_URL;
	const catalog = await fetchCatalog(
		configuredUrl,
		options.fetchImpl ?? fetch,
		options.now ?? Date.now
	);
	if (!catalog) {
		return {
			domain,
			cashback: null,
			merchantName: null,
			quidcoUrl: null,
			searchUrl,
			available: false
		};
	}
	const merchant = matchQuidcoMerchant(domain, catalog);
	if (!merchant) {
		return {
			domain,
			cashback: null,
			merchantName: null,
			quidcoUrl: null,
			searchUrl,
			available: true
		};
	}
	const cashback = formatCashbackCode(merchant.reward);
	return {
		domain,
		cashback,
		merchantName: cashback ? merchant.name : null,
		quidcoUrl: cashback ? (merchant.url ?? null) : null,
		searchUrl,
		available: true
	};
}

export function quidcoLookup(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	options: QuidcoLookupOptions = {}
) {
	return apiResponse(async () => {
		const actor = requireMember(connection, event.locals.actor);
		if (!canCapture(connection, actor))
			throw new AccessError(403, 'Contributor permission is needed to check cashback rates.');
		const source = event.url.searchParams.get('domain') ?? event.url.searchParams.get('url') ?? '';
		if (source.length > 4000) throw new AccessError(400, 'This link is too long.');
		return lookupQuidcoCashback(source, options);
	});
}
