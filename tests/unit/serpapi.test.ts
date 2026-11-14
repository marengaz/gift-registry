import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createSerpApiProvider, serpapiCandidates } from '../../src/lib/server/enrichment/serpapi';

it('posts one real stripped multipart derivative then queries private Lens visual matches with UK parameters', async () => {
	const original = await sharp({
		create: { width: 1600, height: 1200, channels: 3, background: 'green' }
	})
		.withMetadata({ exif: { IFD0: { Artist: 'Private family metadata' } } })
		.png()
		.toBuffer();
	const requests: Array<{ url: string; init: RequestInit }> = [];
	const provider = createSerpApiProvider({
		apiKey: 'private-key',
		fetch: async (url, init) => {
			requests.push({ url: String(url), init: init! });
			if (requests.length === 1) {
				expect(String(url)).toBe('https://serpapi.com/image');
				expect(init!.method).toBe('POST');
				expect(init!.redirect).toBe('error');
				expect(init!.body).toBeInstanceOf(FormData);
				const form = init!.body as FormData;
				expect([...form.keys()].sort()).toEqual(['api_key', 'image']);
				expect(form.get('api_key')).toBe('private-key');
				const image = form.get('image') as File;
				expect(image.type).toBe('image/jpeg');
				expect(image.size).toBeLessThanOrEqual(480000);
				const bytes = Buffer.from(await image.arrayBuffer());
				expect((await sharp(bytes).metadata()).exif).toBeUndefined();
				expect(bytes.includes(Buffer.from('Private family metadata'))).toBe(false);
				return Response.json({ image_id: 'private-image' });
			}
			const query = new URL(url as URL);
			expect(query.origin + query.pathname).toBe('https://serpapi.com/search.json');
			expect(Object.fromEntries(query.searchParams)).toEqual({
				engine: 'google_lens',
				image_id: 'private-image',
				type: 'visual_matches',
				country: 'gb',
				hl: 'en-gb',
				safe: 'active',
				api_key: 'private-key'
			});
			expect(init!.redirect).toBe('error');
			expect(init!.method).toBe('GET');
			return Response.json({
				visual_matches: [
					{
						title: 'Toy',
						link: 'https://shop.co.uk/toy',
						source: 'Shop',
						price: { extracted_value: 12.5, currency: 'GBP', value: '£12.50' }
					}
				]
			});
		}
	})!;
	const imageId = await provider.upload(original);
	const result = await provider.search(imageId);
	expect(requests).toHaveLength(2);
	expect(result[0]).toMatchObject({
		sourceUrl: 'https://shop.co.uk/toy',
		offer: { priceMinor: 1250, currency: 'GBP' }
	});
	expect(JSON.stringify(result)).not.toMatch(/private-key|private-image|search_metadata/);
});
it('retains at most six deduplicated actual destinations, prefers UK pages and never guesses dollar currency', () => {
	const results = serpapiCandidates(
		{
			visual_matches: [
				{
					link: 'https://other.example/toy',
					price: { extracted_value: 19, currency: '$', value: '$19' }
				},
				{ link: 'https://shop.co.uk/toy', title: 'UK toy' },
				{ link: 'https://shop.co.uk/toy' },
				...[
					{ link: 'javascript:alert(1)' },
					{ link: 'https://127.0.0.1/a' },
					{ link: 'https://user:pass@shop.example/a' },
					{ link: 'http://shop.example/a' },
					{ title: 'Missing link', thumbnail: 'https://shop.example/thumb' }
				],
				...Array.from({ length: 8 }, (_, i) => ({ link: `https://shop.example/${i}` }))
			]
		},
		123
	);
	expect(results).toHaveLength(6);
	expect(results[0].sourceUrl).toBe('https://shop.co.uk/toy');
	expect(results.find((item) => item.sourceUrl.includes('other.example'))?.offer).toMatchObject({
		currency: null,
		priceMinor: null,
		priceText: '$19'
	});
	expect(results.every((item) => item.retrievedAt === 123)).toBe(true);
	expect(results.some((item) => /127|thumbnail|javascript|Missing/.test(item.sourceUrl))).toBe(
		false
	);
});
it('reports empty matches explicitly and rejects malformed success without inventing destinations', () => {
	expect(serpapiCandidates({ visual_matches: [] })).toEqual([]);
	expect(serpapiCandidates({ search_metadata: { status: 'Success' } })).toEqual([]);
	for (const input of [null, {}, { visual_matches: {} }, { error: 'provider details' }])
		expect(() => serpapiCandidates(input)).toThrow();
});
it.each(['redirect', 'oversized', 'fetch-error', 'invalid-json'])(
	'bounds and redacts %s responses without retrying',
	async (kind) => {
		const fetcher = vi.fn(async () => {
			if (kind === 'fetch-error')
				throw new Error('https://serpapi.com/search.json?api_key=secret-key&image_id=secret-image');
			if (kind === 'redirect')
				return new Response('', {
					status: 302,
					headers: { location: 'https://elsewhere.example' }
				});
			if (kind === 'oversized') return new Response('x'.repeat(100));
			return new Response('not-json-secret-key');
		});
		const provider = createSerpApiProvider({ apiKey: 'secret-key', fetch: fetcher, maxBytes: 50 })!;
		await expect(provider.search('secret-image')).rejects.toThrow('Image search is unavailable');
		expect(fetcher).toHaveBeenCalledTimes(1);
		try {
			await createSerpApiProvider({ apiKey: 'secret-key', fetch: fetcher, maxBytes: 50 })!.search(
				'secret-image'
			);
		} catch (error) {
			expect(String(error)).not.toMatch(/secret-key|secret-image|https:/);
		}
	}
);
it('aborts a stalled fetch and a stalled body within the same response deadline', async () => {
	for (const stage of ['fetch', 'body']) {
		let signal: AbortSignal | undefined;
		let cancelled = false;
		const provider = createSerpApiProvider({
			apiKey: 'secret-key',
			timeoutMs: 15,
			fetch: async (_url, init) => {
				signal = init?.signal as AbortSignal;
				if (stage === 'fetch') return new Promise<Response>(() => {});
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{'));
						},
						cancel() {
							cancelled = true;
						}
					})
				);
			}
		})!;
		await expect(provider.search('private-image')).rejects.toThrow('Image search is unavailable');
		expect(signal?.aborted).toBe(true);
		if (stage === 'body') expect(cancelled).toBe(true);
	}
});
it('keeps advertised from-prices provisional and excludes provider follow-up endpoints', () => {
	const results = serpapiCandidates({
		visual_matches: [
			{
				link: 'https://shop.co.uk/toy',
				price: { currency: '£', extracted_value: 10, value: 'From £10' }
			},
			{ link: 'https://serpapi.com/search.json?api_key=private' },
			{ link: 'https://lens.google.com/search?image=private' }
		]
	});
	expect(results).toHaveLength(1);
	expect(results[0].offer).toMatchObject({ priceMinor: 1000, currency: 'GBP', fromPrice: true });
});
