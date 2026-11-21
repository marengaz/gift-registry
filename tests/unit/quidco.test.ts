import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	formatCashbackCode,
	lookupQuidcoCashback,
	matchQuidcoMerchant,
	parseQuidcoCatalog,
	quidcoSearchUrl,
	registrableDomain,
	resetQuidcoCache
} from '../../src/lib/server/enrichment/quidco';

const CURRYS_WATCH_URL =
	'https://www.currys.co.uk/products/samsung-galaxy-watch8-bt-with-bixby-graphite-40-mm-10286746.html';

const sampleCatalogPayload = {
	merchants: [
		{
			id: '296',
			name: 'Boots',
			domain: 'boots.com',
			reward: 'Up to 3.75% cashback',
			reward_p2: 'Up to 5% cashback',
			url: 'https://www.quidco.com/boots/'
		},
		{
			id: '101',
			name: 'Currys Business',
			domain: 'business.currys.co.uk',
			reward: 'Up to 4% cashback',
			url: 'https://www.quidco.com/currys-business/'
		},
		{
			id: '100',
			name: 'Currys',
			domain: 'currys.co.uk',
			reward: 'Up to 18.75% / £75 cashback',
			url: 'https://www.quidco.com/currys/'
		},
		{
			id: '300',
			name: 'Pizza Hut Delivery',
			domain: 'pizzahut.co.uk/delivery',
			reward: '5% cashback',
			url: 'javascript:alert(1)'
		},
		{
			id: '400',
			name: 'Coming Soon Shop',
			domain: 'comingsoon.example.co.uk',
			reward: 'Coming Soon! cashback',
			url: 'https://www.quidco.com/coming-soon/'
		}
	]
};

describe('quidco top-level domain matching and formatting', () => {
	beforeEach(() => {
		resetQuidcoCache();
	});

	it('extracts only the top-level registrable domain from URLs and hostnames', () => {
		expect(registrableDomain(CURRYS_WATCH_URL)).toBe('currys.co.uk');
		expect(registrableDomain('https://shop.currys.co.uk/tv')).toBe('currys.co.uk');
		expect(registrableDomain('https://www2.boots.com/product/123/')).toBe('boots.com');
		expect(registrableDomain('currys.co.uk')).toBe('currys.co.uk');
		expect(registrableDomain('')).toBeNull();
		expect(registrableDomain('not-a-url')).toBeNull();
		expect(registrableDomain('ftp://boots.com/item')).toBeNull();
		expect(registrableDomain('http://localhost:3000/item')).toBeNull();
		expect(registrableDomain('https://127.0.0.1/item')).toBeNull();
		expect(registrableDomain('https://user:pass@boots.com/item')).toBeNull();
	});

	it('builds a clean Quidco search URL from a merchant link or domain', () => {
		expect(quidcoSearchUrl(CURRYS_WATCH_URL)).toBe('https://www.quidco.com/search/?q=currys');
		expect(quidcoSearchUrl('https://www.johnlewis.com/item/1')).toBe(
			'https://www.quidco.com/search/?q=johnlewis'
		);
		expect(quidcoSearchUrl('not a link')).toBeNull();
	});

	it('formats numeric reward strings and ignores non-numeric placeholders', () => {
		expect(formatCashbackCode('Up to 3.75% cashback')).toBe('Quidco: Up to 3.75% cashback');
		expect(formatCashbackCode('  5%   cashback ')).toBe('Quidco: 5% cashback');
		expect(formatCashbackCode('Coming Soon! cashback')).toBeNull();
		expect(formatCashbackCode('')).toBeNull();
		const veryLong = 'Up to 10% ' + 'x'.repeat(300);
		expect(formatCashbackCode(veryLong)?.length).toBe(255);
	});

	it('matches strictly by top-level registrable domain and prefers exact root merchant entries', () => {
		const catalog = parseQuidcoCatalog(sampleCatalogPayload);
		expect(matchQuidcoMerchant(CURRYS_WATCH_URL, catalog)?.name).toBe('Currys');
		expect(matchQuidcoMerchant('https://business.currys.co.uk/laptop', catalog)?.name).toBe(
			'Currys'
		);
		expect(matchQuidcoMerchant('https://www.boots.com/toy', catalog)?.name).toBe('Boots');
		expect(matchQuidcoMerchant('https://notboots.com/toy', catalog)).toBeNull();
		// Rejects unsafe non-Quidco URLs from catalog entries
		expect(matchQuidcoMerchant('https://www.pizzahut.co.uk/anything', catalog)?.url).toBeNull();
	});

	it('caches catalog with ETag / 304 support and resolves the Currys watch URL', async () => {
		let clock = 1_000_000;
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(sampleCatalogPayload), {
					status: 200,
					headers: { etag: '"v1"', 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(new Response(null, { status: 304 }));

		const first = await lookupQuidcoCashback(CURRYS_WATCH_URL, {
			catalogUrl: 'https://example.test/merchants.json',
			fetchImpl: fetchMock,
			now: () => clock
		});
		expect(first).toEqual({
			domain: 'currys.co.uk',
			cashback: 'Quidco: Up to 18.75% / £75 cashback',
			merchantName: 'Currys',
			quidcoUrl: 'https://www.quidco.com/currys/',
			searchUrl: 'https://www.quidco.com/search/?q=currys',
			available: true
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Within TTL -> served from cache without refetching
		const second = await lookupQuidcoCashback('https://www.comingsoon.example.co.uk/item', {
			catalogUrl: 'https://example.test/merchants.json',
			fetchImpl: fetchMock,
			now: () => clock + 60_000
		});
		expect(second.cashback).toBeNull();
		expect(second.available).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// After TTL -> sends If-None-Match and honours 304
		clock += 7 * 60 * 60 * 1000;
		const third = await lookupQuidcoCashback('boots.com', {
			catalogUrl: 'https://example.test/merchants.json',
			fetchImpl: fetchMock,
			now: () => clock
		});
		expect(third.cashback).toBe('Quidco: Up to 3.75% cashback');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ 'If-None-Match': '"v1"' });
	});

	it('backs off gracefully on Cloudflare 403 and still returns a Quidco search URL', async () => {
		const clock = 5_000_000;
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('Attention Required! | Cloudflare', { status: 403 }));

		const first = await lookupQuidcoCashback(CURRYS_WATCH_URL, {
			catalogUrl: 'https://example.test/blocked.json',
			fetchImpl: fetchMock,
			now: () => clock
		});
		expect(first).toEqual({
			domain: 'currys.co.uk',
			cashback: null,
			merchantName: null,
			quidcoUrl: null,
			searchUrl: 'https://www.quidco.com/search/?q=currys',
			available: false
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Subsequent lookup within backoff window does not hammer the endpoint
		const second = await lookupQuidcoCashback('https://www.boots.com/item', {
			catalogUrl: 'https://example.test/blocked.json',
			fetchImpl: fetchMock,
			now: () => clock + 60_000
		});
		expect(second.available).toBe(false);
		expect(second.searchUrl).toBe('https://www.quidco.com/search/?q=boots');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not fetch when URL is missing or feed is disabled', async () => {
		const fetchMock = vi.fn<typeof fetch>();
		const empty = await lookupQuidcoCashback('', { fetchImpl: fetchMock });
		expect(empty).toEqual({
			domain: null,
			cashback: null,
			merchantName: null,
			quidcoUrl: null,
			searchUrl: null,
			available: true
		});
		const disabled = await lookupQuidcoCashback('https://www.boots.com/item', {
			catalogUrl: 'disabled',
			fetchImpl: fetchMock
		});
		expect(disabled.available).toBe(false);
		expect(disabled.searchUrl).toBe('https://www.quidco.com/search/?q=boots');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('falls back to default Quidco URL when catalogUrl is blank', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify(sampleCatalogPayload), { status: 200 }));
		const result = await lookupQuidcoCashback('https://www.boots.com/item', {
			catalogUrl: '   ',
			fetchImpl: fetchMock
		});
		expect(result.cashback).toBe('Quidco: Up to 3.75% cashback');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'https://tbd.cashbacksrv.com/quidco_com/p/merchants.json'
		);
	});

	it('aborts streaming catalog responses that exceed the 20 MB cap', async () => {
		let cancelled = false;
		const oversizedStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(5 * 1024 * 1024));
			},
			cancel() {
				cancelled = true;
			}
		});
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(oversizedStream, { status: 200 }));
		const result = await lookupQuidcoCashback('https://www.boots.com/item', {
			catalogUrl: 'https://example.test/huge.json',
			fetchImpl: fetchMock
		});
		expect(result.available).toBe(false);
		expect(result.cashback).toBeNull();
		expect(cancelled).toBe(true);
	});
});
