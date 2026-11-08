import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { fixture } from './identity-fixture';
import {
	updateIdentificationSettings,
	reserveAllowance,
	allowanceSummary
} from '../../src/lib/server/enrichment/allowance';
import { metadataPreview } from '../../src/lib/server/enrichment/preview';
import {
	captureDetailsGet,
	captureDetailsPost,
	getGeminiStatus,
	reserveGeminiEvaluation,
	finishGeminiEvaluation,
	runGeminiExtraction
} from '../../src/lib/server/enrichment/gemini';
import type { CatalogueEvent } from '../../src/lib/server/catalogue';

let context: ReturnType<typeof fixture>;
const environment = {
	GEMINI_API_KEY: 'provider-test-key',
	GEMINI_MODEL: 'gemini-3.5-flash-lite',
	GEMINI_MONTHLY_BUDGET_USD: '2.00',
	GEMINI_EVAL_BUDGET_USD: '0.25'
};
const observed = {
	title: 'Wooden train',
	description: 'A stacking train.',
	variant: null,
	price: '12.50',
	currency: 'GBP',
	priceKind: 'exact',
	priceEvidence: 'Price £12.50',
	imageIndex: null,
	ambiguous: false,
	suggested: false,
	uncertainty: []
};
function dependencies(result: unknown = observed) {
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		return Response.json(
			String(url).endsWith(':countTokens')
				? { totalTokens: 1000 }
				: {
						status: 'completed',
						steps: [
							{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(result) }] }
						]
					}
		);
	});
	return { environment, transport: transport as typeof fetch, requests };
}
function event(body?: unknown, actor = 'admin'): CatalogueEvent {
	const url = new URL('https://gifts.example/api/capture-details');
	return {
		locals: { actor: context.actor(actor) },
		url,
		request: new Request(
			url,
			body === undefined
				? undefined
				: {
						method: 'POST',
						headers: {
							origin: url.origin,
							...(body instanceof FormData ? {} : { 'content-type': 'application/json' })
						},
						body: body instanceof FormData ? body : JSON.stringify(body)
					}
		)
	};
}
const input = () => ({
	operationId: randomUUID(),
	kind: 'text' as const,
	text: 'Wooden train. Price £12.50',
	sourceUrl: 'https://shop.example/train'
});
beforeEach(() => {
	context = fixture();
	updateIdentificationSettings(context.connection, {
		enabled: true,
		monthlyLimitMicrodollars: 2_000_000,
		unitMicrodollars: 3500,
		pricingRevision: 'test'
	});
});
afterEach(() => context.connection.close());

describe('generic capture extraction', () => {
	it('keeps an AI billing failure distinct from an unreadable product page', async () => {
		const transport = vi.fn(
			async () => new Response(null, { status: 402 })
		) as unknown as typeof fetch;
		const result = await runGeminiExtraction(context.connection, context.admin, input(), {
			environment,
			transport
		});
		expect(result.suggestions).toEqual([]);
		expect(result.message).toContain('billing');
		const response = await metadataPreview(
			context.connection,
			event({ url: 'https://shop.example/train', assist: true, operationId: randomUUID() }),
			async () => ({
				status: 200,
				headers: { 'content-type': 'text/html' },
				body: Buffer.from(
					'<title>Wooden train</title><h1>Wooden train</h1><p>A wooden stacking train. Product price GBP 12.50.</p>'
				),
				url: 'https://shop.example/train'
			}),
			{ environment, transport }
		);
		const body = await response.json();
		expect(body.aiUnavailable).toBe(true);
		expect(body.suggestions[0].title).toBe('Wooden train');
		expect(body.message).toContain('billing');
	});
	it('reserves CLI evaluations centrally without sessions, duplicate spend or replay dispatch', () => {
		const id = randomUUID();
		const digest = 'a'.repeat(64);
		const before = context.connection.sqlite.prepare('SELECT count(*) AS total FROM user').get();
		const ticket = reserveGeminiEvaluation(context.connection, id, digest, environment);
		expect(ticket).toMatchObject({ actorId: 'admin', replay: false, result: null });
		expect(reserveGeminiEvaluation(context.connection, id, digest, environment)).toMatchObject({
			replay: true,
			result: null
		});
		finishGeminiEvaluation(context.connection, ticket, {
			suggestions: [],
			ambiguity: true,
			message: 'Public fixture was ambiguous.'
		});
		expect(reserveGeminiEvaluation(context.connection, id, digest, environment)).toMatchObject({
			replay: true,
			result: { ambiguity: true }
		});
		expect(() =>
			reserveGeminiEvaluation(context.connection, id, 'b'.repeat(64), environment)
		).toThrow('changed');
		expect(getGeminiStatus(context.connection, environment)).toMatchObject({
			reservedMicrodollars: 20000,
			evaluationReservedMicrodollars: 20000
		});
		expect(context.connection.sqlite.prepare('SELECT count(*) AS total FROM user').get()).toEqual(
			before
		);
	});
	it.each(['gemini-first', 'vision-first'])(
		'enforces the shared AI allowance in both directions: %s',
		async (order) => {
			updateIdentificationSettings(context.connection, {
				enabled: true,
				monthlyLimitMicrodollars: 20000,
				unitMicrodollars: 3500,
				pricingRevision: 'shared-test'
			});
			context.connection.sqlite
				.prepare(
					"INSERT INTO lookup_jobs(id,product_id,actor_id,actor_session_id,operation_id,fingerprint,kind) VALUES('vision-job','product','admin','session-admin','vision-op','vision-input','vision')"
				)
				.run();
			const deps = dependencies();
			if (order === 'gemini-first') {
				await runGeminiExtraction(context.connection, context.admin, input(), deps);
				expect(() => reserveAllowance(context.connection, 'vision-job', 'test-project')).toThrow(
					'allowance'
				);
				expect(allowanceSummary(context.connection).remainingMicrodollars).toBe(0);
			} else {
				const reservation = reserveAllowance(context.connection, 'vision-job', 'test-project');
				await expect(
					runGeminiExtraction(context.connection, context.admin, input(), deps)
				).rejects.toThrow('allowance');
				expect(deps.requests).toEqual([]);
				expect(reserveAllowance(context.connection, 'vision-job', 'test-project')).toEqual(
					reservation
				);
				expect(getGeminiStatus(context.connection, environment).remainingMicrodollars).toBe(16500);
			}
		}
	);
	it('keeps complete Amazon metadata as the first pass without calling Gemini', async () => {
		const deps = dependencies();
		const html =
			'<meta name="description" content="A reliable tracker"><span id="productTitle">Tile tracker two pack</span><div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">£38.92</span></span></div><img id="landingImage" src="https://m.media-amazon.com/images/tracker.jpg">';
		const page = vi.fn(async () => ({
			status: 200,
			headers: { 'content-type': 'text/html' },
			body: Buffer.from(html),
			url: 'https://www.amazon.co.uk/dp/B0D63573CF'
		}));
		const response = await metadataPreview(
			context.connection,
			event({
				url: 'https://www.amazon.co.uk/dp/B0D63573CF',
				assist: true,
				operationId: randomUUID()
			}),
			page,
			deps
		);
		expect(await response.json()).toMatchObject({
			suggestions: [
				{ title: 'Tile tracker two pack', source: 'retailer-page', offer: { priceMinor: 3892 } }
			]
		});
		expect(deps.requests).toEqual([]);
	});
	it('uses accessible product text as fallback while removing scripts, forms and account details', async () => {
		const deps = dependencies();
		const html =
			'<title>Wooden train</title><main><h1>Wooden train</h1><p>Price £12.50</p><form><input value="private-password"><p>private-account-note</p></form><script>private-cookie-data</script></main>';
		const page = vi.fn(async () => ({
			status: 200,
			headers: { 'content-type': 'text/html' },
			body: Buffer.from(html),
			url: 'https://shop.example/train'
		}));
		const response = await metadataPreview(
			context.connection,
			event({ url: 'https://shop.example/train', assist: true, operationId: randomUUID() }),
			page,
			deps
		);
		expect(await response.json()).toMatchObject({
			suggestions: [
				{ title: 'Wooden train', description: 'A stacking train.', offer: { priceMinor: 1250 } }
			]
		});
		expect(JSON.stringify(deps.requests)).not.toContain('private-');
		expect(deps.requests.filter((r) => r.url.endsWith('/interactions'))).toHaveLength(1);
	});
	it('does not ask Gemini to interpret an HTTP failure or a successful challenge page', async () => {
		for (const html of [
			'<title>Access denied</title><h1>Access denied</h1>',
			'<title>Just a moment...</title><form id="challenge-form">Verify you are human</form>'
		]) {
			const deps = dependencies();
			const page = vi.fn(async () => ({
				status: 200,
				headers: { 'content-type': 'text/html' },
				body: Buffer.from(html),
				url: 'https://shop.example/train'
			}));
			const response = await metadataPreview(
				context.connection,
				event({ url: 'https://shop.example/train', assist: true, operationId: randomUUID() }),
				page,
				deps
			);
			expect(await response.json()).toMatchObject({ suggestions: [], blocked: true });
			expect(deps.requests).toEqual([]);
		}
		const deps = dependencies();
		const response = await metadataPreview(
			context.connection,
			event({ url: 'https://shop.example/train', assist: true, operationId: randomUUID() }),
			async () => {
				throw new Error('HTTP 403');
			},
			deps
		);
		expect((await response.json()).suggestions).toEqual([]);
		expect(deps.requests).toEqual([]);
	});
	it('returns exact, from and foreign prices honestly and refuses cross-product ambiguity', async () => {
		const exact = await runGeminiExtraction(
			context.connection,
			context.admin,
			input(),
			dependencies()
		);
		expect(exact.suggestions[0]).toMatchObject({
			source: 'gemini',
			offer: { priceMinor: 1250, currency: 'GBP', fromPrice: false }
		});
		const from = await runGeminiExtraction(
			context.connection,
			context.admin,
			{ ...input(), text: 'Wooden train. From £12.50' },
			dependencies({ ...observed, priceKind: 'from', priceEvidence: 'From £12.50' })
		);
		expect(from.suggestions[0].offer).toMatchObject({ priceMinor: null, fromPrice: true });
		const foreign = await runGeminiExtraction(
			context.connection,
			context.admin,
			{ ...input(), text: 'Wooden train. JPY 1500' },
			dependencies({ ...observed, price: '1500', currency: 'JPY', priceEvidence: 'JPY 1500' })
		);
		expect(foreign.suggestions[0].offer).toMatchObject({ priceMinor: 1500, currency: 'JPY' });
		const ambiguous = await runGeminiExtraction(
			context.connection,
			context.admin,
			input(),
			dependencies({ ...observed, ambiguous: true })
		);
		expect(ambiguous).toMatchObject({ suggestions: [], ambiguity: true });
		const invented = await runGeminiExtraction(
			context.connection,
			context.admin,
			{ ...input(), text: 'Wooden train. No price shown.' },
			dependencies()
		);
		expect(invented.suggestions[0].offer?.priceMinor ?? null).toBeNull();
	});
	it('reserves once for a repeated operation, rejects changed input, and keeps evaluation inside the monthly cap', async () => {
		const deps = dependencies();
		const value = input();
		await runGeminiExtraction(context.connection, context.admin, value, deps);
		await runGeminiExtraction(context.connection, context.admin, value, deps);
		expect(deps.requests.filter((r) => r.url.endsWith('/interactions'))).toHaveLength(1);
		await expect(
			runGeminiExtraction(
				context.connection,
				context.admin,
				{ ...value, text: 'Changed item' },
				deps
			)
		).rejects.toThrow('changed');
		expect(getGeminiStatus(context.connection, environment).reservedMicrodollars).toBe(20000);
		const tiny = {
			...environment,
			GEMINI_MONTHLY_BUDGET_USD: '0.02',
			GEMINI_EVAL_BUDGET_USD: '0.02'
		};
		await expect(
			runGeminiExtraction(
				context.connection,
				context.admin,
				{ ...input(), evaluation: true },
				{ ...deps, environment: tiny }
			)
		).rejects.toThrow('allowance');
		expect(deps.requests.filter((r) => r.url.endsWith('/interactions'))).toHaveLength(1);
	});
	it('does not dispatch when disabled, unconfigured, unauthorised or revoked during token preflight', async () => {
		const deps = dependencies();
		await expect(
			runGeminiExtraction(context.connection, context.actor('guest'), input(), deps)
		).rejects.toThrow();
		await expect(
			runGeminiExtraction(context.connection, context.admin, input(), { ...deps, environment: {} })
		).rejects.toThrow('configured');
		updateIdentificationSettings(context.connection, {
			enabled: false,
			monthlyLimitMicrodollars: 2_000_000,
			unitMicrodollars: 3500,
			pricingRevision: 'test'
		});
		await expect(
			runGeminiExtraction(context.connection, context.admin, input(), deps)
		).rejects.toThrow('disabled');
		expect(deps.requests).toEqual([]);
		updateIdentificationSettings(context.connection, {
			enabled: true,
			monthlyLimitMicrodollars: 2_000_000,
			unitMicrodollars: 3500,
			pricingRevision: 'test'
		});
		const transport: typeof fetch = async () => {
			context.connection.sqlite.prepare('DELETE FROM session WHERE id=?').run('session-admin');
			return Response.json({ totalTokens: 1000 });
		};
		await expect(
			runGeminiExtraction(context.connection, context.admin, input(), { environment, transport })
		).rejects.toThrow('session');
	});
	it('admits only one of two concurrent requests for the remaining allowance', async () => {
		const deps = dependencies();
		const tiny = { ...environment, GEMINI_MONTHLY_BUDGET_USD: '0.02' };
		const outcomes = await Promise.allSettled([
			runGeminiExtraction(context.connection, context.admin, input(), {
				...deps,
				environment: tiny
			}),
			runGeminiExtraction(context.connection, context.admin, input(), {
				...deps,
				environment: tiny
			})
		]);
		expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
		expect(outcomes.filter((value) => value.status === 'rejected')).toHaveLength(1);
		expect(deps.requests.filter((value) => value.url.endsWith('/interactions'))).toHaveLength(1);
		expect(getGeminiStatus(context.connection, tiny).remainingMicrodollars).toBe(0);
	});
	it("never shares another author's cached extraction through an operation ID", async () => {
		const deps = dependencies();
		const value = input();
		await runGeminiExtraction(context.connection, context.admin, value, deps);
		await expect(
			runGeminiExtraction(context.connection, context.actor('guest'), value, deps)
		).rejects.toThrow();
		expect(deps.requests.filter((request) => request.url.endsWith('/interactions'))).toHaveLength(
			1
		);
		const evil = event(new FormData());
		evil.request = new Request(evil.url, {
			method: 'POST',
			headers: { origin: 'https://other.example' },
			body: new FormData()
		});
		expect((await captureDetailsPost(context.connection, evil, deps)).status).toBe(403);
	});
	it('uses a bounded, stripped image and never sends images without an explicit POST action', async () => {
		const deps = dependencies();
		const response = await captureDetailsGet(context.connection, event(), deps);
		expect(await response.json()).toMatchObject({ configured: true, enabled: true });
		expect(deps.requests).toEqual([]);
		const image = await sharp({
			create: { width: 1200, height: 800, channels: 3, background: 'blue' }
		})
			.withMetadata({ exif: { IFD0: { Artist: 'private-image-metadata' } } })
			.png()
			.toBuffer();
		const form = new FormData();
		form.set('operationId', randomUUID());
		form.set('kind', 'image');
		form.set('image', new File([image], 'screenshot.png', { type: 'image/png' }));
		const extracted = await captureDetailsPost(context.connection, event(form), deps);
		expect(extracted.status).toBe(200);
		const request = deps.requests.find((r) => r.url.endsWith('/interactions'))!.body;
		expect(request).toMatchObject({ store: false, generation_config: { max_output_tokens: 2048 } });
		const parts = request.input as { type: string; data?: string }[];
		const prepared = Buffer.from(parts.find((p) => p.type === 'image')!.data!, 'base64');
		const metadata = await sharp(prepared).metadata();
		expect(metadata.width).toBeLessThanOrEqual(1024);
		expect(metadata.exif).toBeUndefined();
	});
	it('keeps refused, malformed and incomplete provider responses recoverable without a second charged attempt', async () => {
		const value = input();
		const transport = vi.fn(async (url: string | URL | Request) =>
			Response.json(
				String(url).endsWith(':countTokens')
					? { totalTokens: 1000 }
					: { status: 'incomplete', steps: [] }
			)
		);
		const deps = { environment, transport: transport as typeof fetch };
		const first = await runGeminiExtraction(context.connection, context.admin, value, deps);
		expect(first.suggestions).toEqual([]);
		await runGeminiExtraction(context.connection, context.admin, value, deps);
		expect(
			transport.mock.calls.filter(([url]) => String(url).endsWith('/interactions'))
		).toHaveLength(1);
		expect(getGeminiStatus(context.connection, environment).reservedMicrodollars).toBe(20000);
	});
});
