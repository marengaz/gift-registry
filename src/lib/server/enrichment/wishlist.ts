import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { z } from 'zod';
import { parsePriceMinor, priceInput } from '../../catalogue-types';
import { AccessError, canCapture, projectProduct, requireMember } from '../access';
import type { CatalogueEvent } from '../catalogue';
import type { DatabaseConnection } from '../db/client';
import { apiResponse, assertSameOrigin } from '../http';
import { DuplicateIndex, extractAmazonAsin, normaliseProductUrl } from '../../shared/wishlist';
import { publicFetch, PublicFetchError } from './fetch';
import { evidenceUrl } from './metadata';

export type WishlistImportedItem = {
	asin: string | null;
	title: string;
	brand: string | null;
	sourceUrl: string;
	imageUrl: string | null;
	price: string;
	priceMinor: number | null;
	currency: string;
	priceText: string | null;
	retailer: string;
};

export type WishlistImportResponse = {
	listTitle: string | null;
	sourceUrl: string;
	items: WishlistImportedItem[];
	totalFound: number;
	skippedDuplicates: number;
};

const MAX_WISHLIST_PAGES = 15;
const MAX_WISHLIST_ITEMS = 300;

function plain(value: unknown): string | null {
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const text = String(value).replace(/\s+/g, ' ').trim().slice(0, 1000);
	return text || null;
}

function defaultCurrencyForHost(hostname: string): string {
	const host = hostname.toLowerCase();
	if (host.endsWith('.co.uk')) return 'GBP';
	if (
		host.endsWith('.de') ||
		host.endsWith('.fr') ||
		host.endsWith('.es') ||
		host.endsWith('.it') ||
		host.endsWith('.nl') ||
		host.endsWith('.ie')
	)
		return 'EUR';
	if (host.endsWith('.ca')) return 'CAD';
	if (host.endsWith('.com.au')) return 'AUD';
	if (host.endsWith('.co.jp')) return 'JPY';
	return 'USD';
}

function parsePriceAndCurrency(
	rawText: string | null,
	fallbackCurrency: string
): { price: string; priceMinor: number | null; currency: string; priceText: string | null } {
	if (!rawText) return { price: '', priceMinor: null, currency: fallbackCurrency, priceText: null };
	const text = rawText.trim();
	const match = text.match(
		/(£|\$|€|CA\$|AU\$|¥|GBP|USD|EUR|CAD|AUD|JPY)\s*([\d,]+(?:\.\d{1,2})?)/i
	);
	if (!match) return { price: '', priceMinor: null, currency: fallbackCurrency, priceText: null };
	const symbol = match[1].toUpperCase();
	const amountRaw = match[2].replaceAll(',', '');
	const currency =
		symbol === '£' || symbol === 'GBP'
			? 'GBP'
			: symbol === '€' || symbol === 'EUR'
				? 'EUR'
				: symbol === 'CA$' || symbol === 'CAD'
					? 'CAD'
					: symbol === 'AU$' || symbol === 'AUD'
						? 'AUD'
						: symbol === '¥' || symbol === 'JPY'
							? 'JPY'
							: symbol === '$'
								? fallbackCurrency === 'CAD' || fallbackCurrency === 'AUD'
									? fallbackCurrency
									: 'USD'
								: 'USD';
	try {
		const priceMinor = parsePriceMinor(amountRaw, currency);
		return {
			price: priceInput(priceMinor, currency),
			priceMinor,
			currency,
			priceText: `${match[1]}${match[2]}`
		};
	} catch {
		return { price: '', priceMinor: null, currency, priceText: null };
	}
}

function parseItemFromElement(
	$: CheerioAPI,
	el: Cheerio<AnyNode>,
	baseUrl: string,
	fallbackCurrency: string
): WishlistImportedItem | null {
	const rawAsin =
		el.attr('data-asin') ||
		el.find('[data-asin]').first().attr('data-asin') ||
		el.attr('data-csa-c-item-id') ||
		'';
	const linkEl = el
		.find(
			'a.single-product-item-link, a[id^="itemName_"], a[href*="/dp/"], a[href*="/gp/product/"]'
		)
		.first();
	const href = linkEl.attr('href') || el.find('a[href]').first().attr('href') || '';
	const resolvedLink = evidenceUrl(href, baseUrl);
	const asin =
		extractAmazonAsin(rawAsin) ??
		(resolvedLink ? extractAmazonAsin(resolvedLink) : null) ??
		(/^[A-Z0-9]{10}$/i.test(rawAsin.trim()) ? rawAsin.trim().toUpperCase() : null);

	const brand = plain(el.find('.product-brand-text').first().text());
	const rawTitle =
		plain(el.find('.product-title-text').first().text()) ??
		plain(el.find('a[id^="itemName_"]').first().attr('title')) ??
		plain(el.find('a[id^="itemName_"]').first().text()) ??
		plain(el.find('h2, h3, .g-title').first().text()) ??
		plain(linkEl.attr('title')) ??
		plain(linkEl.text()) ??
		plain(el.find('img').first().attr('alt'));

	if (!rawTitle && !asin && !resolvedLink) return null;

	const host = new URL(baseUrl).hostname;
	const canonicalUrl = asin
		? `https://${host}/dp/${asin}`
		: resolvedLink
			? normaliseProductUrl(resolvedLink) || resolvedLink
			: '';
	if (!canonicalUrl) return null;

	const title =
		rawTitle ||
		(brand && asin ? `${brand} (${asin})` : asin ? `Amazon item ${asin}` : 'Amazon item');

	const imgEl = el.find('img.product-image, .g-itemImage img, img').first();
	const imageUrl = evidenceUrl(
		imgEl.attr('data-old-hires') || imgEl.attr('src') || imgEl.attr('data-a-dynamic-image'),
		baseUrl
	);

	let rawPriceText =
		plain(el.find('.a-price:not(.a-text-price) .a-offscreen').first().text()) ??
		plain(el.find('[id^="itemPrice_"] .a-offscreen').first().text()) ??
		plain(el.find('.a-color-price').first().text());

	if (!rawPriceText) {
		const whole = plain(el.find('.a-price-whole').first().text())?.replace(/\.$/, '');
		const fraction = plain(el.find('.a-price-fraction').first().text());
		const symbol = plain(el.find('.a-price-symbol').first().text()) ?? '$';
		if (whole) rawPriceText = `${symbol}${whole}${fraction ? '.' + fraction : ''}`;
	}

	const dataPrice = el.attr('data-price');
	if (!rawPriceText && dataPrice && /^-?\d+(\.\d+)?$/.test(dataPrice) && Number(dataPrice) > 0) {
		const symbol = fallbackCurrency === 'GBP' ? '£' : fallbackCurrency === 'EUR' ? '€' : '$';
		rawPriceText = `${symbol}${dataPrice}`;
	}

	const { price, priceMinor, currency, priceText } = parsePriceAndCurrency(
		rawPriceText,
		fallbackCurrency
	);

	return {
		asin,
		title,
		brand,
		sourceUrl: canonicalUrl,
		imageUrl,
		price,
		priceMinor,
		currency,
		priceText,
		retailer: 'Amazon'
	};
}

export function extractAmazonWishlistPage(
	html: string,
	pageUrl: string
): {
	listTitle: string | null;
	items: WishlistImportedItem[];
	nextToken: string | null;
	moreUrl: string | null;
	csrfToken: string | null;
	storefrontPagination: {
		vanityHandle: string;
		listId: string;
		linkCode: string;
		tag: string;
		relatedRequestId: string;
		isStorefrontRequest: boolean;
	} | null;
} {
	const $ = load(html);
	const parsedUrl = new URL(pageUrl);
	const fallbackCurrency = defaultCurrencyForHost(parsedUrl.hostname);

	const listTitle =
		plain($('.list-spv-listTitle, #profile-list-name, .g-list-title').first().text()) ??
		plain($('meta[property="og:title"]').attr('content')) ??
		plain($('title').first().text());

	const items: WishlistImportedItem[] = [];
	const itemContainers = $(
		'.single-list-item, .single-media-list-item, li.g-item-sortable, div.g-item-sortable, [data-itemid]'
	);

	if (itemContainers.length > 0) {
		itemContainers.each((_, node) => {
			const parsed = parseItemFromElement($, $(node), pageUrl, fallbackCurrency);
			if (parsed) items.push(parsed);
		});
	} else {
		$('a[href*="/dp/"], a[href*="/gp/product/"]').each((_, node) => {
			const anchor = $(node);
			const container = anchor.closest('li, article, .a-section, div');
			const parsed = parseItemFromElement(
				$,
				container.length ? container : anchor,
				pageUrl,
				fallbackCurrency
			);
			if (parsed) items.push(parsed);
		});
	}

	const nextToken = $('#remaining-list-items-token').attr('data-next-token')?.trim() || null;

	const csrfToken =
		$('meta[name="csrfToken"]').attr('content')?.trim() ||
		$('meta[name="anti-csrftoken-a2z"]').first().attr('content')?.trim() ||
		null;

	let moreUrl: string | null = null;
	const showMoreInput = $(
		'input.showMoreUrl, input[name="showMoreUrl"], [data-awl-ajax-url]'
	).first();
	const rawMore =
		showMoreInput.attr('value') ||
		showMoreInput.attr('data-awl-ajax-url') ||
		$('a[href*="lek="]').first().attr('href') ||
		'';
	if (rawMore) {
		const candidateMore = evidenceUrl(rawMore, pageUrl);
		if (
			candidateMore &&
			isAmazonHost(candidateMore) &&
			new URL(candidateMore).origin === parsedUrl.origin
		) {
			moreUrl = candidateMore;
		}
	}

	let storefrontPagination: {
		vanityHandle: string;
		listId: string;
		linkCode: string;
		tag: string;
		relatedRequestId: string;
		isStorefrontRequest: boolean;
	} | null = null;

	let vanityHandle = '';
	let listId = '';
	let relatedRequestId = '';
	let linkCode = 'ssc';
	let tag = '';
	let isStorefrontRequest = true;

	$('script[type="a-state"]').each((_, script) => {
		const stateAttr = $(script).attr('data-a-state') ?? '';
		if (stateAttr.includes('listScrollState')) {
			try {
				const parsed = JSON.parse($(script).text());
				if (typeof parsed.listId === 'string') listId = parsed.listId;
				if (typeof parsed.vanityHandle === 'string') vanityHandle = parsed.vanityHandle;
			} catch {}
		}
	});

	const pathMatch = parsedUrl.pathname.match(/\/shop\/(?:profile\/)?([^/]+)\/list\/([^/?#]+)/i);
	if (pathMatch) {
		if (!vanityHandle) vanityHandle = pathMatch[1];
		if (!listId) listId = pathMatch[2];
		if (parsedUrl.pathname.toLowerCase().includes('/shop/profile/')) isStorefrontRequest = false;
	}

	const reqIdMatch = html.match(/"relatedRequestId"\s*:\s*"([^"]+)"/);
	if (reqIdMatch) relatedRequestId = reqIdMatch[1];
	const onsiteMatch = html.match(/'onsiteId'\s*:\s*'([^']*)'/);
	const tagMatch = html.match(/'tag'\s*:\s*'([^']*)'/);
	tag = onsiteMatch?.[1] || tagMatch?.[1] || parsedUrl.searchParams.get('tag') || '';
	const delphiMatch = html.match(/'delphiLinkCode'\s*:\s*'([^']+)'/);
	if (delphiMatch?.[1]) linkCode = delphiMatch[1];

	if (vanityHandle && listId) {
		storefrontPagination = {
			vanityHandle,
			listId,
			linkCode,
			tag,
			relatedRequestId,
			isStorefrontRequest
		};
	}

	return {
		listTitle,
		items,
		nextToken,
		moreUrl,
		csrfToken,
		storefrontPagination
	};
}

function extractCookies(headers: Record<string, string | string[] | undefined>): string[] {
	const raw = headers['set-cookie'];
	if (!raw) return [];
	const list = Array.isArray(raw) ? raw : [raw];
	return list.map((cookie) => cookie.split(';')[0].trim()).filter(Boolean);
}

function mergeCookieJar(jar: Map<string, string>, incoming: string[]) {
	for (const pair of incoming) {
		const eq = pair.indexOf('=');
		if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
}

function formatCookieHeader(jar: Map<string, string>): string {
	return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function isAmazonHost(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase().replace(/^www\d*\./, '');
		return (
			host === 'a.co' ||
			host === 'amzn.to' ||
			host === 'amzn.eu' ||
			host === 'amazon.com' ||
			host.startsWith('amazon.')
		);
	} catch {
		return false;
	}
}

export function wishlistPreview(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	fetchPage: typeof publicFetch = publicFetch
) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const actor = requireMember(connection, event.locals.actor);
		if (!canCapture(connection, actor))
			throw new AccessError(403, 'Contributor permission is needed to import an Amazon wishlist.');

		const parsed = z
			.object({
				url: z.url()
			})
			.safeParse(await event.request.json().catch(() => null));
		if (!parsed.success || !isAmazonHost(parsed.data.url))
			throw new AccessError(
				400,
				'Paste a public Amazon wishlist or idea list link (for example from amazon.co.uk, amazon.com or a.co).'
			);

		const existingCatalogue = (
			connection.sqlite.prepare('SELECT id FROM products WHERE deleted_at IS NULL').all() as {
				id: string;
			}[]
		)
			.map((row) => projectProduct(connection, actor, row.id))
			.filter((product): product is NonNullable<typeof product> => !!product);

		const duplicateIndex = new DuplicateIndex(
			existingCatalogue.map((product) => ({
				title: product.title,
				sourceUrl: product.sourceUrl,
				offers: product.offers
			}))
		);

		let firstPage;
		try {
			firstPage = await fetchPage(parsed.data.url, { timeoutMs: 15000 });
		} catch (error) {
			throw new AccessError(
				400,
				error instanceof PublicFetchError
					? error.message
					: 'This Amazon wishlist could not be reached. Check that the link is public and try again.'
			);
		}

		requireMember(connection, event.locals.actor);

		if (
			!isAmazonHost(firstPage.url) ||
			!String(firstPage.headers['content-type'] ?? '')
				.toLowerCase()
				.includes('text/html')
		)
			throw new AccessError(400, 'This link did not return an Amazon wishlist page.');

		const cookieJar = new Map<string, string>();
		mergeCookieJar(cookieJar, extractCookies(firstPage.headers));

		const html = firstPage.body.toString('utf8');
		const firstExtracted = extractAmazonWishlistPage(html, firstPage.url);
		const allExtractedItems: WishlistImportedItem[] = [...firstExtracted.items];

		let nextToken = firstExtracted.nextToken;
		let moreUrl = firstExtracted.moreUrl;
		const csrfToken = firstExtracted.csrfToken;
		const storefront = firstExtracted.storefrontPagination;
		const origin = new URL(firstPage.url).origin;

		for (let pageIndex = 1; pageIndex < MAX_WISHLIST_PAGES; pageIndex++) {
			if (allExtractedItems.length >= MAX_WISHLIST_ITEMS) break;
			if (nextToken && storefront) {
				const basePath = storefront.isStorefrontRequest
					? `${origin}/shop/${encodeURIComponent(storefront.vanityHandle)}/api/listItems`
					: `${origin}/shop/profile/${encodeURIComponent(storefront.vanityHandle)}/api/listItems`;
				const params = new URLSearchParams({
					listId: storefront.listId,
					linkCode: storefront.linkCode
				});
				if (storefront.tag) params.set('tag', storefront.tag);
				if (storefront.relatedRequestId)
					params.set('relatedRequestId', storefront.relatedRequestId);
				const pageApiUrl = `${basePath}?${params.toString()}`;
				const cookieHeader = formatCookieHeader(cookieJar);
				try {
					const nextResponse = await fetchPage(pageApiUrl, {
						method: 'POST',
						timeoutMs: 10000,
						headers: {
							'Content-Type': 'application/json',
							...(csrfToken ? { 'anti-csrftoken-a2z': csrfToken } : {}),
							...(cookieHeader ? { Cookie: cookieHeader } : {}),
							'X-Requested-With': 'XMLHttpRequest'
						},
						body: JSON.stringify({ token: nextToken })
					});
					mergeCookieJar(cookieJar, extractCookies(nextResponse.headers));
					const nextParsed = extractAmazonWishlistPage(
						nextResponse.body.toString('utf8'),
						firstPage.url
					);
					if (!nextParsed.items.length && !nextParsed.nextToken) break;
					allExtractedItems.push(...nextParsed.items);
					nextToken = nextParsed.nextToken;
				} catch {
					break;
				}
			} else if (moreUrl && isAmazonHost(moreUrl) && new URL(moreUrl).origin === origin) {
				const cookieHeader = formatCookieHeader(cookieJar);
				try {
					const nextResponse = await fetchPage(moreUrl, {
						timeoutMs: 10000,
						headers: {
							...(cookieHeader ? { Cookie: cookieHeader } : {}),
							'X-Requested-With': 'XMLHttpRequest'
						}
					});
					if (!isAmazonHost(nextResponse.url) || new URL(nextResponse.url).origin !== origin) break;
					mergeCookieJar(cookieJar, extractCookies(nextResponse.headers));
					const nextParsed = extractAmazonWishlistPage(
						nextResponse.body.toString('utf8'),
						firstPage.url
					);
					if (!nextParsed.items.length) break;
					allExtractedItems.push(...nextParsed.items);
					moreUrl = nextParsed.moreUrl !== moreUrl ? nextParsed.moreUrl : null;
				} catch {
					break;
				}
			} else {
				break;
			}
		}

		if (!allExtractedItems.length) {
			throw new AccessError(
				400,
				'No wishlist items were found on this page. Check that the Amazon list is public and contains items.'
			);
		}

		const keptItems: WishlistImportedItem[] = [];
		let skippedDuplicates = 0;

		for (const item of allExtractedItems) {
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
			keptItems.push(item);
		}

		const response: WishlistImportResponse = {
			listTitle: firstExtracted.listTitle,
			sourceUrl: firstPage.url,
			items: keptItems,
			totalFound: allExtractedItems.length,
			skippedDuplicates
		};
		return response;
	});
}
