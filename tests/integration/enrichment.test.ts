import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { extractMetadata } from '../../src/lib/server/enrichment/metadata';

describe('retailer evidence', () => {
	it('extracts product and exact offer metadata with provenance', () => {
		const results = extractMetadata(
			readFileSync('tests/fixtures/retailers/game.html', 'utf8'),
			'https://shop.example/game',
			123
		);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			title: 'Woodland game',
			description: 'A & B',
			variant: 'Green · Travel',
			imageUrl: 'https://shop.example/game.jpg',
			sourceUrl: 'https://shop.example/game',
			retrievedAt: 123,
			offer: {
				url: 'https://shop.example/buy',
				priceMinor: 2450,
				currency: 'GBP',
				fromPrice: false
			}
		});
	});
	it('keeps missing currency, aggregate prices and variants uncertain', () => {
		const results = extractMetadata(
			'<script type="application/ld+json">[{"@type":"Product","name":"Unpriced currency","offers":{"price":"12.50"}},{"@type":"ProductGroup","name":"Multiple sizes","hasVariant":[{"name":"Small"},{"name":"Large"}],"offers":{"@type":"AggregateOffer","lowPrice":"10","priceCurrency":"GBP"}}]</script>',
			'https://shop.example/items',
			123
		);
		expect(results[0].offer).toMatchObject({
			priceMinor: null,
			currency: null,
			priceText: '12.50'
		});
		expect(results[0].uncertainty.join(' ')).toContain('currency');
		expect(results[1].offer).toMatchObject({ fromPrice: true, priceMinor: 1000 });
		expect(results[1].variant).toBeNull();
		expect(results[1].uncertainty.join(' ')).toContain('variant');
	});
	it('falls back to plain Open Graph text without executing or retaining HTML', () => {
		const results = extractMetadata(
			'<meta property="og:title" content="&lt;b&gt;Toy&lt;/b&gt;"><meta property="og:description" content="A gift"><meta property="og:image" content="javascript:alert(1)"><script>throw Error()</script>',
			'https://shop.example',
			123
		);
		expect(results[0]).toMatchObject({
			title: 'Toy',
			description: 'A gift',
			imageUrl: null,
			offer: null,
			source: 'open-graph'
		});
	});
});

import { beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { fixture } from './identity-fixture';
import { createDatabase } from '../../src/lib/server/db/client';
import { acceptInvitation, createInvitation, setGrant } from '../../src/lib/server/invitations';
import { saveCapture, parseCapture, type CatalogueEvent } from '../../src/lib/server/catalogue';
import { prepareMedia } from '../../src/lib/server/media';
import {
	identifyPost,
	identifyGet,
	runNextJob,
	recoverInterruptedJobs,
	confirmSuggestion
} from '../../src/lib/server/enrichment/jobs';
import { updateIdentificationSettings } from '../../src/lib/server/enrichment/allowance';
let context: ReturnType<typeof fixture>;
let directory: string;
beforeEach(() => {
	context = fixture();
	directory = mkdtempSync(join(tmpdir(), 'gift-enrichment-'));
});
afterEach(() => {
	context.connection.close();
	rmSync(directory, { recursive: true, force: true });
});
function event(id: string, body: unknown): CatalogueEvent {
	const url = new URL('https://gifts.example/api/products/p/identify');
	return {
		locals: { actor: context.actor(id) },
		url,
		request: new Request(url, {
			method: 'POST',
			headers: { origin: url.origin, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	};
}
async function product() {
	const prepared = await prepareMedia(
		[
			new File(
				[
					await sharp({ create: { width: 3, height: 3, channels: 3, background: 'green' } })
						.withMetadata({ exif: { IFD0: { Artist: 'Private family note' } } })
						.png()
						.toBuffer()
				],
				'photo.png',
				{ type: 'image/png' }
			)
		],
		{ mediaRoot: directory }
	);
	return saveCapture(
		context.connection,
		context.admin,
		parseCapture({
			title: 'Original idea',
			variant: 'Original size',
			sourceUrl: 'https://shop.example/source',
			sourceText: 'Private shop note',
			listIds: ['visible'],
			estimatePence: 2000
		}),
		prepared.media
	);
}
const fetchPage = async () => ({
	status: 200,
	headers: { 'content-type': 'text/html' },
	body: Buffer.from(readFileSync('tests/fixtures/retailers/game.html', 'utf8')),
	url: 'https://shop.example/match'
});
it('reuses explicit job operations and reserves before sending only a stripped image to Vision', async () => {
	const item = await product();
	updateIdentificationSettings(context.connection, {
		enabled: true,
		monthlyLimitMicrodollars: 3500,
		unitMicrodollars: 3500,
		pricingRevision: 'test-price'
	});
	const command = { operationId: randomUUID(), kind: 'vision', mediaId: item.media[0].id };
	const first = await (
		await identifyPost(context.connection, event('admin', command), item.id)
	).json();
	const duplicate = await (
		await identifyPost(context.connection, event('admin', command), item.id)
	).json();
	expect(duplicate.id).toBe(first.id);
	let calls = 0;
	const provider = {
		projectId: 'personal-project',
		detect: async (bytes: Buffer) => {
			calls++;
			expect(
				context.connection.sqlite.prepare('SELECT * FROM allowance_reservations').all()
			).toHaveLength(1);
			expect(
				context.connection.sqlite
					.prepare('SELECT dispatched_at FROM lookup_jobs WHERE id=?')
					.get(first.id)
			).not.toMatchObject({ dispatched_at: null });
			expect((await sharp(bytes).metadata()).exif).toBeUndefined();
			expect(bytes.toString()).not.toContain('Private family note');
			return { labels: ['Woodland game'], pages: ['https://shop.example/match'] };
		}
	};
	expect(await runNextJob(context.connection, { provider, fetchPage, mediaRoot: directory })).toBe(
		true
	);
	expect(await runNextJob(context.connection, { provider, fetchPage, mediaRoot: directory })).toBe(
		false
	);
	expect(calls).toBe(1);
	const result = await (await identifyGet(context.connection, event('admin', {}), item.id)).json();
	expect(result.jobs[0]).toMatchObject({
		state: 'succeeded',
		result: { suggestions: [{ title: 'Woodland game' }] }
	});
});
it('retains ambiguous paid failures and expired running jobs without automatic redispatch', async () => {
	const item = await product();
	updateIdentificationSettings(context.connection, {
		enabled: true,
		monthlyLimitMicrodollars: 7000,
		unitMicrodollars: 3500,
		pricingRevision: 'test-price'
	});
	const job = await (
		await identifyPost(
			context.connection,
			event('admin', { operationId: randomUUID(), kind: 'vision', mediaId: item.media[0].id }),
			item.id
		)
	).json();
	let calls = 0;
	const provider = {
		projectId: 'personal-project',
		detect: async () => {
			calls++;
			throw new Error('timeout');
		}
	};
	await runNextJob(context.connection, { provider, mediaRoot: directory });
	await runNextJob(context.connection, { provider, mediaRoot: directory });
	expect(calls).toBe(1);
	expect(
		context.connection.sqlite.prepare('SELECT state FROM lookup_jobs WHERE id=?').get(job.id)
	).toEqual({ state: 'uncertain' });
	expect(
		context.connection.sqlite.prepare('SELECT * FROM allowance_reservations').all()
	).toHaveLength(1);
	context.connection.sqlite
		.prepare("UPDATE lookup_jobs SET state='running',lease_until=1 WHERE id=?")
		.run(job.id);
	recoverInterruptedJobs(context.connection);
	expect(
		context.connection.sqlite.prepare('SELECT state FROM lookup_jobs WHERE id=?').get(job.id)
	).toEqual({ state: 'uncertain' });
	expect(
		(
			await (
				await identifyPost(
					context.connection,
					event('admin', {
						operationId: job.operationId,
						kind: 'vision',
						mediaId: item.media[0].id
					}),
					item.id
				)
			).json()
		).id
	).toBe(job.id);
});
it('keeps blocked social captures and requires explicit administrator field confirmation without changing estimates', async () => {
	const item = await product();
	const job = await (
		await identifyPost(
			context.connection,
			event('admin', { operationId: randomUUID(), kind: 'metadata' }),
			item.id
		)
	).json();
	await runNextJob(context.connection, {
		fetchPage: async () => {
			throw new Error('private social post');
		},
		mediaRoot: directory
	});
	const failed = await (await identifyGet(context.connection, event('admin', {}), item.id)).json();
	expect(failed.jobs[0].state).toBe('failed');
	expect(failed.jobs[0].message).toContain('screenshot');
	const second = await (
		await identifyPost(
			context.connection,
			event('admin', { operationId: randomUUID(), kind: 'metadata' }),
			item.id
		)
	).json();
	await runNextJob(context.connection, { fetchPage, mediaRoot: directory });
	expect(
		(
			await confirmSuggestion(
				context.connection,
				event('admin', { jobId: second.id, index: 0, fields: ['title', 'offer'] }),
				item.id
			)
		).status
	).toBe(200);
	expect(
		context.connection.sqlite
			.prepare(
				'SELECT title,variant,source_url,source_text,contributor_id FROM products WHERE id=?'
			)
			.get(item.id)
	).toEqual({
		title: 'Woodland game',
		variant: 'Original size',
		source_url: 'https://shop.example/source',
		source_text: 'Private shop note',
		contributor_id: 'admin'
	});
	expect(
		context.connection.sqlite
			.prepare('SELECT estimate_pence FROM entries WHERE product_id=?')
			.get(item.id)
	).toEqual({ estimate_pence: 2000 });
	expect(
		context.connection.sqlite
			.prepare('SELECT observed_at,price_minor FROM offers WHERE product_id=?')
			.get(item.id)
	).toMatchObject({ price_minor: 2450 });
	expect(job.id).not.toBe(second.id);
});
it('rechecks grants and allocation privacy before status, dispatch and confirmation', async () => {
	acceptInvitation(
		context.connection,
		context.actor('guest'),
		createInvitation(context.connection, context.admin, {
			email: 'guest@example.test',
			grants: [{ listId: 'visible', role: 'contributor' }]
		}).token
	);
	const item = await product();
	const command = { operationId: randomUUID(), kind: 'metadata' };
	expect((await identifyPost(context.connection, event('guest', command), item.id)).status).toBe(
		200
	);
	context.connection.sqlite.exec(
		"UPDATE entries SET state='allocated',buyer_id='other',allocated_by_id='admin',allocation_source='administrator'"
	);
	expect((await identifyGet(context.connection, event('guest', {}), item.id)).status).toBe(404);
	let fetched = false;
	await runNextJob(context.connection, {
		fetchPage: async () => {
			fetched = true;
			return fetchPage();
		}
	});
	expect(fetched).toBe(false);
	expect(
		(
			await confirmSuggestion(
				context.connection,
				event('guest', { jobId: 'unknown', index: 0, fields: ['title'] }),
				item.id
			)
		).status
	).toBe(403);
	setGrant(context.connection, context.admin, 'guest', { listId: 'visible', role: 'viewer' });
	expect(
		(
			await identifyPost(
				context.connection,
				event('guest', { operationId: randomUUID(), kind: 'metadata' }),
				item.id
			)
		).status
	).toBe(403);
});
it('preserves published Open Graph prices without guessing a missing currency', () => {
	const exact = extractMetadata(
		'<meta property="og:title" content="Toy"><meta property="product:price:amount" content="12.50"><meta property="product:price:currency" content="GBP">',
		'https://shop.example',
		123
	)[0];
	expect(exact.offer).toMatchObject({ priceMinor: 1250, currency: 'GBP', fromPrice: false });
	const missing = extractMetadata(
		'<meta property="og:title" content="Toy"><meta property="og:price:amount" content="12.50">',
		'https://shop.example',
		123
	)[0];
	expect(missing.offer).toMatchObject({ priceMinor: null, currency: null, priceText: '12.50' });
	expect(missing.uncertainty.join(' ')).toContain('currency');
});

import { metadataPreview, metadataImage } from '../../src/lib/server/enrichment/preview';
import { identificationGet, identificationPost } from '../../src/lib/server/enrichment/settings';
import { attachIdentificationPhoto } from '../../src/lib/server/enrichment/jobs';
it('returns editable free metadata and a private stripped image through real handlers', async () => {
	const response = await metadataPreview(
		context.connection,
		event('admin', { url: 'https://shop.example/source' }),
		fetchPage
	);
	expect(response.status).toBe(200);
	expect((await response.json()).suggestions[0].offer).toMatchObject({
		priceMinor: 2450,
		currency: 'GBP'
	});
	const original = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
		.withMetadata({ exif: { IFD0: { Artist: 'Private metadata' } } })
		.png()
		.toBuffer();
	const picture = await metadataImage(
		context.connection,
		event('admin', { url: 'https://shop.example/photo' }),
		async () => ({ status: 200, headers: {}, body: original, url: 'https://shop.example/photo' })
	);
	expect(picture.status).toBe(200);
	expect(picture.headers.get('cache-control')).toContain('no-store');
	expect((await sharp(Buffer.from(await picture.arrayBuffer())).metadata()).exif).toBeUndefined();
	expect(context.connection.sqlite.prepare('SELECT * FROM products').all()).toHaveLength(0);
	const unavailable = await metadataPreview(
		context.connection,
		event('admin', { url: 'https://private.example/post' }),
		async () => {
			throw new Error('blocked');
		}
	);
	expect(await unavailable.json()).toMatchObject({
		suggestions: [],
		message: expect.stringContaining('screenshot')
	});
});
it('allows only the administrator to enable spending or attach an idempotent screenshot', async () => {
	acceptInvitation(
		context.connection,
		context.actor('guest'),
		createInvitation(context.connection, context.admin, {
			email: 'guest@example.test',
			grants: [{ listId: 'visible', role: 'contributor' }]
		}).token
	);
	expect((await identificationGet(context.connection, event('guest', {}))).status).toBe(403);
	expect(
		(
			await identificationPost(
				context.connection,
				event('guest', {
					enabled: true,
					monthlyLimitMicrodollars: 1000000,
					unitMicrodollars: 3500,
					pricingRevision: 'test'
				})
			)
		).status
	).toBe(403);
	const item = await product();
	const operationId = randomUUID();
	const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
		.png()
		.toBuffer();
	const upload = () => {
		const value = event('admin', {});
		const body = new FormData();
		body.set('operationId', operationId);
		body.set('photo', new File([bytes], 'screenshot.png', { type: 'image/png' }));
		value.request = new Request(value.url, {
			method: 'POST',
			headers: { origin: value.url.origin },
			body
		});
		return attachIdentificationPhoto(context.connection, value, item.id, { mediaRoot: directory });
	};
	expect((await upload()).status).toBe(200);
	expect((await upload()).status).toBe(200);
	expect(
		context.connection.sqlite.prepare('SELECT * FROM media WHERE product_id=?').all(item.id)
	).toHaveLength(2);
});
it('rechecks disabled allowance after a queued request and never calls its provider', async () => {
	const item = await product();
	updateIdentificationSettings(context.connection, {
		enabled: true,
		monthlyLimitMicrodollars: 3500,
		unitMicrodollars: 3500,
		pricingRevision: 'test-price'
	});
	await identifyPost(
		context.connection,
		event('admin', { operationId: randomUUID(), kind: 'vision', mediaId: item.media[0].id }),
		item.id
	);
	updateIdentificationSettings(context.connection, {
		enabled: false,
		monthlyLimitMicrodollars: 3500,
		unitMicrodollars: 3500,
		pricingRevision: 'test-price'
	});
	let calls = 0;
	await runNextJob(context.connection, {
		provider: {
			projectId: 'personal-project',
			detect: async () => {
				calls++;
				return { labels: [], pages: [] };
			}
		},
		mediaRoot: directory
	});
	expect(calls).toBe(0);
	expect(
		context.connection.sqlite.prepare('SELECT * FROM allowance_reservations').all()
	).toHaveLength(0);
});

import { createVisionProvider } from '../../src/lib/server/enrichment/vision';
const authDouble = vi.hoisted(() => ({ headers: vi.fn(), construct: vi.fn() }));
vi.mock('google-auth-library', () => ({
	GoogleAuth: class {
		constructor(options: unknown) {
			authDouble.construct(options);
		}
		getRequestHeaders() {
			return authDouble.headers();
		}
	}
}));
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	authDouble.headers.mockReset();
	authDouble.construct.mockReset();
});
function credentials(project = 'personal-project') {
	const filename = join(directory, 'vision-credentials.json');
	writeFileSync(
		filename,
		JSON.stringify({
			type: 'service_account',
			project_id: project,
			client_email: 'vision@personal-project.example.test',
			private_key: 'test-only-signing-material'
		})
	);
	return { VISION_PROJECT_ID: 'personal-project', VISION_CREDENTIALS_FILE: filename };
}
it('sends only image bytes and Web Detection fields to the fixed Google endpoint without automatic retries', async () => {
	authDouble.headers.mockResolvedValue(new Headers({ authorization: 'Bearer test-only-token' }));
	const transport = vi.fn().mockResolvedValue(
		new Response(
			JSON.stringify({
				responses: [
					{
						webDetection: {
							bestGuessLabels: [{ label: 'Toy' }],
							pagesWithMatchingImages: [{ url: 'https://shop.example/game' }]
						}
					}
				]
			}),
			{ headers: { 'content-type': 'application/json' } }
		)
	);
	vi.stubGlobal('fetch', transport);
	const image = Buffer.from('stripped derivative');
	const provider = createVisionProvider(credentials())!;
	expect(await provider.detect(image)).toEqual({
		labels: ['Toy'],
		pages: ['https://shop.example/game']
	});
	expect(transport).toHaveBeenCalledTimes(1);
	const [url, request] = transport.mock.calls[0];
	expect(url).toBe('https://vision.googleapis.com/v1/images:annotate');
	expect(JSON.parse(request.body)).toEqual({
		requests: [
			{
				image: { content: image.toString('base64') },
				features: [{ type: 'WEB_DETECTION', maxResults: 5 }]
			}
		]
	});
	expect(request.headers.get('x-goog-user-project')).toBe('personal-project');
	expect(request.redirect).toBe('error');
	expect(authDouble.construct.mock.calls[0][0]).toMatchObject({
		projectId: 'personal-project',
		credentials: { project_id: 'personal-project' }
	});
	transport.mockRejectedValue(new Error('timeout'));
	await expect(provider.detect(image)).rejects.toThrow();
	expect(transport).toHaveBeenCalledTimes(2);
});
it('rejects a different credential project and never proceeds to Vision after token acquisition times out', async () => {
	const transport = vi.fn();
	vi.stubGlobal('fetch', transport);
	await expect(
		createVisionProvider(credentials('work-project'))!.detect(Buffer.from('image'))
	).rejects.toThrow('personal Vision project');
	expect(authDouble.construct).not.toHaveBeenCalled();
	let resolveHeaders!: (headers: Headers) => void;
	authDouble.headers.mockReturnValue(
		new Promise<Headers>((resolve) => {
			resolveHeaders = resolve;
		})
	);
	const provider = createVisionProvider(credentials())!;
	vi.useFakeTimers();
	const result = provider.detect(Buffer.from('image'));
	// File loading completes before the bounded token acquisition starts.
	await vi.waitFor(() => expect(authDouble.headers).toHaveBeenCalled(), { interval: 1 });
	const rejected = expect(result).rejects.toThrow('timed out');
	await vi.advanceTimersByTimeAsync(10001);
	await rejected;
	resolveHeaders(new Headers({ authorization: 'Bearer late-token' }));
	await Promise.resolve();
	expect(transport).not.toHaveBeenCalled();
});
