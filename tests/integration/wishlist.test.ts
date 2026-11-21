import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './identity-fixture';
import { wishlistPreview } from '../../src/lib/server/enrichment/wishlist';
import type { FetchLimits, FetchResponse } from '../../src/lib/server/enrichment/fetch';

const models: ReturnType<typeof fixture>[] = [];
afterEach(() => {
	for (const model of models.splice(0)) model.connection.close();
});

describe('Amazon wishlist preview & pagination integration', () => {
	it('follows shortlinks, paginates storefront idea lists, and filters duplicates against existing catalogue items', async () => {
		const model = fixture();
		models.push(model);
		const db = model.connection.sqlite;
		db.exec(
			"INSERT INTO products(id,title,source_url,contributor_id) VALUES('existing-1','Already Saved Toy','https://www.amazon.co.uk/dp/B0DLY8GFR8','admin');"
		);

		const page1Html = `
			<!doctype html>
			<html>
			<head>
				<meta name="csrfToken" content="csrf-abc" />
			</head>
			<body>
				<span class="list-spv-listTitle"><bdi>3 &amp; 4 Year Old Gift Guide</bdi></span>
				<div id="list-item-container">
					<div class="single-list-item" data-asin="amzn1.asin.B0DLY8GFR8">
						<a class="single-product-item-link" href="/dp/B0DLY8GFR8">
							<span class="product-title-text"><bdi>Little Tikes Construction Set (Duplicate by ASIN)</bdi></span>
						</a>
					</div>
					<div class="single-list-item" data-asin="amzn1.asin.B07P8WBK9F">
						<a class="single-product-item-link" href="/dp/B07P8WBK9F">
							<img class="product-image" src="https://m.media-amazon.com/images/I/41BMegfOL9L._AC_.jpg" />
							<span class="product-brand-text"><bdi>Learning Resources</bdi></span>
							<span class="product-title-text"><bdi>Learning Resources Rock 'n Gem Surprise</bdi></span>
							<div class="product-price-container"><span class="a-price"><span class="a-offscreen">$19.99</span></span></div>
						</a>
					</div>
				</div>
				<script type="a-state" data-a-state='{"key":"listScrollState"}'>{"listId":"2TEA5Q35ZSF47","vanityHandle":"bymelissakate","shouldListLoadMoreFlag":true}</script>
				<script>
					P.declare('storefront-common', { 'onsiteId': 'onamzbymeli0b-20', 'delphiLinkCode': 'ssc' });
					P.declare('enable-load-more', { "listId": "2TEA5Q35ZSF47", "relatedRequestId": "REQ1" });
				</script>
				<div id="remaining-list-items-token" data-next-token="tok-page-2"></div>
			</body>
			</html>
		`;

		const page2Html = `
			<div id="list-item-container">
				<div class="single-list-item" data-asin="amzn1.asin.B07P8WBK9F">
					<a class="single-product-item-link" href="/dp/B07P8WBK9F">
						<span class="product-title-text"><bdi>Duplicate Within List</bdi></span>
					</a>
				</div>
				<div class="single-list-item" data-asin="amzn1.asin.B08HCXS4XJ">
					<a class="single-product-item-link" href="/dp/B08HCXS4XJ">
						<img class="product-image" src="https://m.media-amazon.com/images/I/51qlKRbaLNL._AC_.jpg" />
						<span class="product-brand-text"><bdi>JOYIN</bdi></span>
						<span class="product-title-text"><bdi>JOYIN Punching Bag for Kids</bdi></span>
						<div class="product-price-container"><span class="a-price"><span class="a-offscreen">$24.50</span></span></div>
					</a>
				</div>
			</div>
			<div id="remaining-list-items-token" data-next-token=""></div>
		`;

		const calls: Array<{ url: string; limits: Partial<FetchLimits> }> = [];
		const mockFetch = async (
			url: string,
			limits: Partial<FetchLimits> = {}
		): Promise<FetchResponse & { url: string }> => {
			calls.push({ url, limits });
			if (url === 'https://a.co/d/02BqURT1') {
				return {
					status: 200,
					url: 'https://www.amazon.com/shop/bymelissakate/list/2TEA5Q35ZSF47',
					headers: {
						'content-type': 'text/html; charset=utf-8',
						'set-cookie': ['session-id=123-456; Path=/; HttpOnly']
					},
					body: Buffer.from(page1Html)
				};
			}
			return {
				status: 200,
				url,
				headers: { 'content-type': 'text/html; charset=utf-8' },
				body: Buffer.from(page2Html)
			};
		};

		const endpointUrl = new URL('https://gifts.example/api/wishlist');
		const response = await wishlistPreview(
			model.connection,
			{
				url: endpointUrl,
				request: new Request(endpointUrl, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						origin: 'https://gifts.example'
					},
					body: JSON.stringify({ url: 'https://a.co/d/02BqURT1' })
				}),
				locals: { actor: model.admin }
			},
			mockFetch
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.listTitle).toBe('3 & 4 Year Old Gift Guide');
		expect(body.totalFound).toBe(4);
		expect(body.skippedDuplicates).toBe(2);
		expect(body.items).toHaveLength(2);
		expect(body.items.map((item: { asin: string }) => item.asin)).toEqual([
			'B07P8WBK9F',
			'B08HCXS4XJ'
		]);
		expect(calls).toHaveLength(2);
		expect(calls[1].limits.method).toBe('POST');
		expect(calls[1].limits.headers?.['anti-csrftoken-a2z']).toBe('csrf-abc');
		expect(calls[1].limits.headers?.Cookie).toContain('session-id=123-456');
	});

	it('rejects non-Amazon URLs, shortlinks redirecting to non-Amazon hosts, and non-contributors', async () => {
		const model = fixture();
		models.push(model);
		const endpointUrl = new URL('https://gifts.example/api/wishlist');

		const nonAmazon = await wishlistPreview(model.connection, {
			url: endpointUrl,
			request: new Request(endpointUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: 'https://gifts.example' },
				body: JSON.stringify({ url: 'https://shop.example/list' })
			}),
			locals: { actor: model.admin }
		});
		expect(nonAmazon.status).toBe(400);

		const maliciousShortlink = await wishlistPreview(
			model.connection,
			{
				url: endpointUrl,
				request: new Request(endpointUrl, {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: 'https://gifts.example' },
					body: JSON.stringify({ url: 'https://a.co/d/malicious' })
				}),
				locals: { actor: model.admin }
			},
			async () => ({
				status: 200,
				url: 'https://evil.example/fake-wishlist',
				headers: { 'content-type': 'text/html' },
				body: Buffer.from('<a href="/dp/B0DLY8GFR8">Item</a>')
			})
		);
		expect(maliciousShortlink.status).toBe(400);

		const uninvited = await wishlistPreview(model.connection, {
			url: endpointUrl,
			request: new Request(endpointUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: 'https://gifts.example' },
				body: JSON.stringify({ url: 'https://a.co/d/02BqURT1' })
			}),
			locals: { actor: model.actor('guest') }
		});
		expect(uninvited.status).toBe(403);
	});
});
