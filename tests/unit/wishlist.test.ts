import { describe, expect, it } from 'vitest';
import {
	DuplicateIndex,
	extractAmazonAsin,
	normaliseProductTitle,
	normaliseProductUrl
} from '../../src/lib/shared/wishlist';
import { extractAmazonWishlistPage } from '../../src/lib/server/enrichment/wishlist';

describe('Amazon ASIN, URL and duplicate matching', () => {
	it('extracts 10-character ASINs from Amazon product links and creativeASIN query params', () => {
		expect(
			extractAmazonAsin(
				'https://www.amazon.com/dp/B0DLY8GFR8?linkCode=ssc&tag=bymelissak01a-20&creativeASIN=B0DLY8GFR8'
			)
		).toBe('B0DLY8GFR8');
		expect(extractAmazonAsin('https://www.amazon.co.uk/gp/product/b07p8wbk9f/ref=ox_sc_act')).toBe(
			'B07P8WBK9F'
		);
		expect(extractAmazonAsin('amzn1.asin.B0D2JGYX3F:amzn1.deal.18c0d883')).toBe('B0D2JGYX3F');
		expect(extractAmazonAsin('https://shop.example/dp/B0DLY8GFR8')).toBeNull();
	});

	it('normalises Amazon product links to canonical /dp/<ASIN> and strips tracking parameters', () => {
		expect(
			normaliseProductUrl(
				'https://www.amazon.com/Little-Tikes/dp/B0DLY8GFR8?tag=test-20&ref_=abc#details'
			)
		).toBe('https://www.amazon.com/dp/B0DLY8GFR8');
		expect(
			normaliseProductUrl('https://shop.example/toy?utm_source=ig&colour=blue&fbclid=123#top')
		).toBe('https://shop.example/toy?colour=blue');
	});

	it('matches duplicates across ASINs, normalised URLs, and case-insensitive titles', () => {
		const index = new DuplicateIndex([
			{
				title: 'Little Tikes Creative Construction Set',
				sourceUrl: 'https://www.amazon.co.uk/dp/B0DLY8GFR8'
			},
			{
				title: 'Wooden Train Track',
				sourceUrl: 'https://shop.example/wooden-train'
			}
		]);

		// Same ASIN on different Amazon domain (.com vs .co.uk) and different title
		expect(
			index.has({
				title: 'Different Title For Same ASIN',
				sourceUrl: 'https://www.amazon.com/dp/B0DLY8GFR8?tag=bymelissak01a-20'
			})
		).toBe(true);

		// Same normalised URL
		expect(
			index.has({
				title: 'Train Set',
				sourceUrl: 'https://shop.example/wooden-train?utm_campaign=winter'
			})
		).toBe(true);

		// Same title (case and whitespace insensitive)
		expect(
			index.has({
				title: '  wooden   train TRACK ',
				sourceUrl: 'https://other.example/item'
			})
		).toBe(true);

		// Distinct product
		expect(
			index.has({
				title: 'New Balance Kids Trainers',
				sourceUrl: 'https://www.amazon.com/dp/B099P3JT1B'
			})
		).toBe(false);
		expect(normaliseProductTitle('  Hello   World ')).toBe('hello world');
	});
});

describe('extractAmazonWishlistPage', () => {
	it('extracts influencer idea list items, prices, pagination token, and storefront state', () => {
		const html = `
			<!doctype html>
			<html>
			<head>
				<title>by Melissa Kate's Amazon Page</title>
				<meta name="csrfToken" content="csrf-token-123" />
			</head>
			<body>
				<span class="list-spv-listTitle"><bdi>3 &amp; 4 Year Old Gift Guide</bdi></span>
				<div id="list-item-container">
					<div class="single-list-item" data-aci="2TEA5Q35ZSF47" data-asin="amzn1.asin.B0DLY8GFR8">
						<a class="single-product-item-link" href="/dp/B0DLY8GFR8?linkCode=ssc&tag=bymelissak01a-20">
							<div class="single-product-item list-spv" data-asin="B0DLY8GFR8">
								<img src="https://m.media-amazon.com/images/I/41Pm6K1CRGL._AC_.jpg" class="product-image" />
								<span class="product-brand-text"><bdi>Little Tikes</bdi></span>
								<span class="product-title-text"><bdi>Little Tikes Creative Construction Power Cuts Set</bdi></span>
								<div class="product-price-container">
									<span class="a-price"><span class="a-offscreen">$24.87</span></span>
								</div>
							</div>
						</a>
					</div>
					<div class="single-list-item" data-aci="2TEA5Q35ZSF47" data-asin="amzn1.asin.B07P8WBK9F">
						<a class="single-product-item-link" href="/dp/B07P8WBK9F">
							<div class="single-product-item list-spv" data-asin="B07P8WBK9F">
								<img src="https://m.media-amazon.com/images/I/41BMegfOL9L._AC_.jpg" class="product-image" />
								<span class="product-brand-text"><bdi>Learning Resources</bdi></span>
								<span class="product-title-text"><bdi>Learning Resources Rock 'n Gem Surprise</bdi></span>
								<div class="product-price-container">
									<span class="product-price-text see-all-buying-option-text">This item may be unavailable</span>
								</div>
							</div>
						</a>
					</div>
				</div>
				<script type="a-state" data-a-state='{"key":"listScrollState"}'>{"listId":"2TEA5Q35ZSF47","vanityHandle":"bymelissakate","shouldListLoadMoreFlag":true,"pageToken":""}</script>
				<script>
					P.declare('storefront-common', { 'onsiteId': 'onamzbymeli0b-20', 'delphiLinkCode': 'ssc' });
					P.declare('enable-load-more', { "listId": "2TEA5Q35ZSF47", "relatedRequestId": "REQ123" });
				</script>
				<div id="remaining-list-items-token" data-next-token="next-page-token-abc"></div>
			</body>
			</html>
		`;

		const parsed = extractAmazonWishlistPage(
			html,
			'https://www.amazon.com/shop/bymelissakate/list/2TEA5Q35ZSF47'
		);
		expect(parsed.listTitle).toBe('3 & 4 Year Old Gift Guide');
		expect(parsed.csrfToken).toBe('csrf-token-123');
		expect(parsed.nextToken).toBe('next-page-token-abc');
		expect(parsed.storefrontPagination).toEqual({
			vanityHandle: 'bymelissakate',
			listId: '2TEA5Q35ZSF47',
			linkCode: 'ssc',
			tag: 'onamzbymeli0b-20',
			relatedRequestId: 'REQ123',
			isStorefrontRequest: true
		});
		expect(parsed.items).toEqual([
			{
				asin: 'B0DLY8GFR8',
				title: 'Little Tikes Creative Construction Power Cuts Set',
				brand: 'Little Tikes',
				sourceUrl: 'https://www.amazon.com/dp/B0DLY8GFR8',
				imageUrl: 'https://m.media-amazon.com/images/I/41Pm6K1CRGL._AC_.jpg',
				price: '24.87',
				priceMinor: 2487,
				currency: 'USD',
				priceText: '$24.87',
				retailer: 'Amazon'
			},
			{
				asin: 'B07P8WBK9F',
				title: "Learning Resources Rock 'n Gem Surprise",
				brand: 'Learning Resources',
				sourceUrl: 'https://www.amazon.com/dp/B07P8WBK9F',
				imageUrl: 'https://m.media-amazon.com/images/I/41BMegfOL9L._AC_.jpg',
				price: '',
				priceMinor: null,
				currency: 'USD',
				priceText: null,
				retailer: 'Amazon'
			}
		]);
	});

	it('extracts standard Amazon UK wishlist items (li.g-item-sortable) with GBP prices', () => {
		const html = `
			<!doctype html>
			<html>
			<body>
				<span id="profile-list-name">Birthday Wishlist</span>
				<ul id="g-items">
					<li class="g-item-sortable" data-itemid="I123" data-price="19.99">
						<div class="g-itemImage">
							<img src="https://m.media-amazon.com/images/I/51abc._AC_.jpg" alt=" Brio Wooden Railway " />
						</div>
						<a id="itemName_I123" href="/dp/B00000J0S2/?coliid=I123&colid=L1">Brio Wooden Railway Starter Set</a>
						<span id="itemPrice_I123"><span class="a-offscreen">£19.99</span></span>
					</li>
				</ul>
			</body>
			</html>
		`;
		const parsed = extractAmazonWishlistPage(
			html,
			'https://www.amazon.co.uk/hz/wishlist/ls/123456'
		);
		expect(parsed.listTitle).toBe('Birthday Wishlist');
		expect(parsed.items).toEqual([
			{
				asin: 'B00000J0S2',
				title: 'Brio Wooden Railway Starter Set',
				brand: null,
				sourceUrl: 'https://www.amazon.co.uk/dp/B00000J0S2',
				imageUrl: 'https://m.media-amazon.com/images/I/51abc._AC_.jpg',
				price: '19.99',
				priceMinor: 1999,
				currency: 'GBP',
				priceText: '£19.99',
				retailer: 'Amazon'
			}
		]);
	});
});

import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach } from 'vitest';
import { DraftStore } from '../../src/lib/client/drafts';
import { ingestAmazonWishlist } from '../../src/lib/client/wishlist-import';
import { emptyDraft } from '../../src/lib/catalogue-types';

const dbNames: string[] = [];
afterEach(async () => {
	for (const name of dbNames.splice(0)) await Dexie.delete(name);
});

describe('client-side ingestAmazonWishlist', () => {
	it('ingests non-duplicate items into local storage drafts and downloads thumbnails', async () => {
		const name = crypto.randomUUID();
		dbNames.push(name);
		const store = new DraftStore(name);
		await store.remember({
			id: 'admin',
			name: 'Admin',
			email: 'admin@example.test',
			member: true,
			siteRole: 'administrator',
			superAdministrator: true,
			administrator: true,
			collaborator: true,
			buyer: true,
			canCapture: true,
			lists: []
		});

		// Pre-populate a local draft with ASIN B0DLY8GFR8
		await store.save({
			ownerId: 'admin',
			draft: {
				...emptyDraft(),
				title: 'Existing Local Draft Toy',
				sourceUrl: 'https://www.amazon.com/dp/B0DLY8GFR8'
			},
			photos: [],
			submit: false
		});

		const transport: typeof fetch = async (input) => {
			const url = String(input);
			if (url === '/api/wishlist') {
				return Response.json({
					listTitle: '3 & 4 Year Old Gift Guide',
					sourceUrl: 'https://www.amazon.com/shop/bymelissakate/list/2TEA5Q35ZSF47',
					totalFound: 3,
					skippedDuplicates: 1,
					items: [
						{
							asin: 'B0DLY8GFR8',
							title: 'Duplicate of Local Draft',
							brand: 'Little Tikes',
							sourceUrl: 'https://www.amazon.com/dp/B0DLY8GFR8',
							imageUrl: 'https://m.media-amazon.com/images/I/1.jpg',
							price: '20.00',
							priceMinor: 2000,
							currency: 'USD',
							priceText: '$20.00',
							retailer: 'Amazon'
						},
						{
							asin: 'B07P8WBK9F',
							title: "Learning Resources Rock 'n Gem Surprise",
							brand: 'Learning Resources',
							sourceUrl: 'https://www.amazon.com/dp/B07P8WBK9F',
							imageUrl: 'https://m.media-amazon.com/images/I/2.jpg',
							price: '19.99',
							priceMinor: 1999,
							currency: 'GBP',
							priceText: '£19.99',
							retailer: 'Amazon'
						}
					]
				});
			}
			if (url === '/api/metadata/image') {
				return new Response(new Blob(['webp-image-bytes'], { type: 'image/webp' }), {
					status: 200,
					headers: { 'content-type': 'image/webp' }
				});
			}
			throw new Error('Unexpected fetch: ' + url);
		};

		const result = await ingestAmazonWishlist({
			url: 'https://a.co/d/02BqURT1',
			store,
			transport,
			awaitThumbnails: true
		});

		expect(result.listTitle).toBe('3 & 4 Year Old Gift Guide');
		expect(result.importedDrafts).toHaveLength(1);
		expect(result.skippedDuplicates).toBe(2); // 1 server + 1 local

		const allDrafts = await store.list('admin');
		expect(allDrafts).toHaveLength(2);
		const imported = await store.get(result.importedDrafts[0].id, 'admin');
		expect(imported?.readyToSync).toBe(false);
		expect(imported?.draft.title).toBe("Learning Resources Rock 'n Gem Surprise");
		expect(imported?.draft.estimate).toBe('19.99');
		const photo = await store.firstPhoto(result.importedDrafts[0].id, 'admin');
		expect(await photo?.text()).toBe('webp-image-bytes');
		store.close();
	});
});
