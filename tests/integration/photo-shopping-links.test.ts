import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './identity-fixture';
import { saveCapture, parseCapture, type CatalogueEvent } from '../../src/lib/server/catalogue';
import { identifyPost } from '../../src/lib/server/enrichment/jobs';
let context: ReturnType<typeof fixture>;
beforeEach(() => {
	context = fixture();
});
afterEach(() => {
	context.connection.close();
	vi.unstubAllEnvs();
});
function event(body: unknown, id = 'admin'): CatalogueEvent {
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
function product() {
	return saveCapture(
		context.connection,
		context.admin,
		parseCapture({
			title: 'Photographed toy',
			variant: 'Blue',
			sourceUrl: 'https://shop.example/toy',
			listIds: ['visible']
		}),
		[]
	);
}
it('rejects a SerpAPI provider override on retailer metadata before creating a job', async () => {
	const item = product();
	const response = await identifyPost(
		context.connection,
		event({ operationId: randomUUID(), kind: 'metadata', provider: 'serpapi' }),
		item.id
	);
	expect(response.status).toBe(400);
	expect(context.connection.sqlite.prepare('SELECT * FROM lookup_jobs').all()).toHaveLength(0);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { prepareMedia } from '../../src/lib/server/media';
import { identifyGet, runNextJob, confirmSuggestion } from '../../src/lib/server/enrichment/jobs';
import { updateIdentificationSettings } from '../../src/lib/server/enrichment/allowance';
import { serpapiStatus } from '../../src/lib/server/enrichment/serpapi-allowance';
import { serpapiCandidates, type SerpApiProvider } from '../../src/lib/server/enrichment/serpapi';
import { checkOffer } from '../../src/lib/server/offer-check';
import { publicOffers } from '../../src/lib/server/offer-review';
import { reviewFingerprint } from '../../src/lib/shared/photo-shopping-links';
import { acceptInvitation, createInvitation, setGrant } from '../../src/lib/server/invitations';
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'gift-photo-search-'));
	vi.stubEnv('SERPAPI_API_KEY', 'fixture-secret-key');
	vi.stubEnv('SERPAPI_MONTHLY_SEARCH_LIMIT', '2');
	updateIdentificationSettings(context.connection, {
		enabled: true,
		monthlyLimitMicrodollars: 0,
		unitMicrodollars: 3500,
		pricingRevision: 'fixture'
	});
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
async function photographedProduct() {
	const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } })
		.png()
		.toBuffer();
	const prepared = await prepareMedia([new File([image], 'photo.png', { type: 'image/png' })], {
		mediaRoot: directory
	});
	return saveCapture(
		context.connection,
		context.admin,
		parseCapture({ title: 'Photographed toy', variant: 'Blue', listIds: ['visible'] }),
		prepared.media
	);
}
function command(item: Awaited<ReturnType<typeof photographedProduct>>) {
	return {
		operationId: randomUUID(),
		kind: 'vision',
		provider: 'serpapi',
		mediaId: item.media[0].id
	};
}
const candidates = () =>
	serpapiCandidates(
		{
			visual_matches: [
				{
					link: 'https://shop.co.uk/toy',
					title: 'Possible toy',
					price: { currency: 'GBP', value: '£10.00', extracted_value: 10 }
				}
			]
		},
		123
	);
function provider(overrides: Partial<SerpApiProvider> = {}) {
	return {
		upload: vi.fn(async () => 'private-image-id'),
		search: vi.fn(async () => candidates()),
		...overrides
	};
}
const blockedPage = vi.fn(async () => {
	throw new Error('blocked retailer');
});
async function queue(
	item: Awaited<ReturnType<typeof photographedProduct>>,
	input = command(item),
	id = 'admin'
) {
	return (await identifyPost(context.connection, event(input, id), item.id)).json();
}
async function status(item: { id: string }) {
	return (await (await identifyGet(context.connection, event({}), item.id)).json()).jobs[0];
}
it('pins SerpAPI, reserves once before upload and replays completed operations after setup is disabled', async () => {
	const item = await photographedProduct();
	const input = command(item);
	const job = await queue(item, input);
	const fake = provider({
		upload: vi.fn(async () => {
			expect(serpapiStatus(context.connection).used).toBe(1);
			return 'private-image-id';
		})
	});
	await runNextJob(context.connection, {
		serpapiProvider: fake,
		mediaRoot: directory,
		fetchPage: blockedPage
	});
	expect(await status(item)).toMatchObject({
		id: job.id,
		provider: 'serpapi',
		mediaId: item.media[0].id,
		state: 'succeeded',
		result: { provider: 'serpapi', suggestions: [{ offer: { url: 'https://shop.co.uk/toy' } }] }
	});
	expect(fake.upload).toHaveBeenCalledTimes(1);
	expect(fake.search).toHaveBeenCalledTimes(1);
	expect(
		context.connection.sqlite.prepare('SELECT * FROM allowance_reservations').all()
	).toHaveLength(0);
	context.connection.sqlite.prepare('UPDATE identification_settings SET enabled=0').run();
	vi.stubEnv('SERPAPI_API_KEY', '');
	expect((await queue(item, input)).id).toBe(job.id);
	expect(await runNextJob(context.connection, { serpapiProvider: fake })).toBe(false);
	expect(JSON.stringify(await status(item))).not.toMatch(/private-image-id|fixture-secret-key/);
});
it('enforces the monthly count when concurrent jobs are admitted and retains uncertain reservations without redispatch', async () => {
	vi.stubEnv('SERPAPI_MONTHLY_SEARCH_LIMIT', '1');
	const item = await photographedProduct();
	const inputs = [command(item), command(item)];
	await Promise.all(inputs.map((input) => queue(item, input)));
	const fake = provider({
		search: vi.fn(async () => {
			throw new Error('secret provider query');
		})
	});
	await Promise.all([
		runNextJob(context.connection, { serpapiProvider: fake, mediaRoot: directory }),
		runNextJob(context.connection, { serpapiProvider: fake, mediaRoot: directory })
	]);
	expect(fake.upload).toHaveBeenCalledTimes(1);
	expect(fake.search).toHaveBeenCalledTimes(1);
	expect(serpapiStatus(context.connection)).toMatchObject({ used: 1, remaining: 0 });
	const jobs = (await (await identifyGet(context.connection, event({}), item.id)).json()).jobs;
	expect(jobs.map((job: { state: string }) => job.state).sort()).toEqual(['failed', 'uncertain']);
	const uncertain = jobs.find((job: { state: string }) => job.state === 'uncertain');
	const input = inputs.find((value) => value.operationId === uncertain.operationId)!;
	expect((await queue(item, input)).id).toBe(uncertain.id);
	expect(await runNextJob(context.connection, { serpapiProvider: fake })).toBe(false);
	expect(JSON.stringify(jobs)).not.toContain('secret provider query');
});
it('replays legacy default-provider operations but rejects reinterpretation as SerpAPI', async () => {
	const item = await photographedProduct();
	const input = { operationId: randomUUID(), kind: 'vision', mediaId: item.media[0].id };
	context.connection.sqlite
		.prepare(
			'INSERT INTO lookup_jobs(id,product_id,actor_id,actor_session_id,operation_id,fingerprint,kind,media_id) VALUES (?,?,?,?,?,?,?,?)'
		)
		.run(
			'legacy',
			item.id,
			'admin',
			'session-admin',
			input.operationId,
			JSON.stringify({ productId: item.id, kind: 'vision', mediaId: input.mediaId }),
			'vision',
			input.mediaId
		);
	expect((await queue(item, input as ReturnType<typeof command>)).id).toBe('legacy');
	expect(
		(await identifyPost(context.connection, event({ ...input, provider: 'serpapi' }), item.id))
			.status
	).toBe(409);
});
it.each(['disabled', 'revoked', 'deleted', 'foreign-photo'])(
	'prevents dispatch for %s queued work',
	async (reason) => {
		const item = await photographedProduct();
		const fake = provider();
		if (reason === 'foreign-photo') {
			const other = await photographedProduct();
			expect(
				(
					await identifyPost(
						context.connection,
						event({ ...command(item), mediaId: other.media[0].id }),
						item.id
					)
				).status
			).toBe(404);
		} else {
			await queue(item);
			if (reason === 'disabled')
				context.connection.sqlite.exec('UPDATE identification_settings SET enabled=0');
			if (reason === 'revoked')
				context.connection.sqlite.exec("DELETE FROM session WHERE id='session-admin'");
			if (reason === 'deleted')
				context.connection.sqlite
					.prepare('UPDATE products SET deleted_at=1 WHERE id=?')
					.run(item.id);
			await runNextJob(context.connection, { serpapiProvider: fake, mediaRoot: directory });
		}
		expect(fake.upload).not.toHaveBeenCalled();
		expect(fake.search).not.toHaveBeenCalled();
		expect(serpapiStatus(context.connection).used).toBe(0);
	}
);
it.each(['disabled', 'revoked', 'deleted', 'photo-removed'])(
	'rechecks %s between upload and query',
	async (reason) => {
		const item = await photographedProduct();
		await queue(item);
		const fake = provider({
			upload: vi.fn(async () => {
				if (reason === 'disabled')
					context.connection.sqlite.exec('UPDATE identification_settings SET enabled=0');
				if (reason === 'revoked')
					context.connection.sqlite.exec("DELETE FROM session WHERE id='session-admin'");
				if (reason === 'deleted')
					context.connection.sqlite
						.prepare('UPDATE products SET deleted_at=1 WHERE id=?')
						.run(item.id);
				if (reason === 'photo-removed')
					context.connection.sqlite.prepare('DELETE FROM media WHERE id=?').run(item.media[0].id);
				return 'private-image-id';
			})
		});
		await runNextJob(context.connection, { serpapiProvider: fake, mediaRoot: directory });
		expect(fake.search).not.toHaveBeenCalled();
		expect(serpapiStatus(context.connection).used).toBe(1);
		expect(context.connection.sqlite.prepare('SELECT state FROM lookup_jobs').get()).toEqual({
			state: 'uncertain'
		});
	}
);
it('checks access again after search before retailer requests and final storage', async () => {
	const item = await photographedProduct();
	await queue(item);
	const fetchPage = vi.fn(blockedPage);
	const fake = provider({
		search: vi.fn(async () => {
			context.connection.sqlite.exec('UPDATE identification_settings SET enabled=0');
			return candidates();
		})
	});
	await runNextJob(context.connection, { serpapiProvider: fake, fetchPage, mediaRoot: directory });
	expect(fetchPage).not.toHaveBeenCalled();
	expect(
		context.connection.sqlite.prepare('SELECT state,result_json FROM lookup_jobs').get()
	).toEqual({ state: 'uncertain', result_json: null });
});
it('keeps the provider destination when retailer metadata advertises an unrelated off-site offer', async () => {
	const item = await photographedProduct();
	await queue(item);
	const fetchPage = vi.fn(async () => ({
		status: 200,
		headers: { 'content-type': 'text/html' },
		url: 'https://shop.co.uk/toy',
		body: Buffer.from(
			'<script type="application/ld+json">{"@type":"Product","name":"Toy","offers":{"url":"https://unrelated.example/elsewhere","price":"1.00","priceCurrency":"GBP"}}</script>'
		)
	}));
	await runNextJob(context.connection, {
		serpapiProvider: provider(),
		fetchPage,
		mediaRoot: directory
	});
	expect((await status(item)).result.suggestions[0].offer).toMatchObject({
		url: 'https://shop.co.uk/toy',
		priceMinor: 1000
	});
});
it('adds one unchecked link idempotently and records only an explicit administrator check of current reviewed details', async () => {
	const item = await photographedProduct();
	const job = await queue(item);
	await runNextJob(context.connection, {
		serpapiProvider: provider(),
		fetchPage: blockedPage,
		mediaRoot: directory
	});
	const add = () =>
		confirmSuggestion(
			context.connection,
			event({ jobId: job.id, index: 0, fields: ['offer'] }),
			item.id
		);
	expect((await add()).status).toBe(200);
	expect((await add()).status).toBe(200);
	let saved = publicOffers(context.connection, item);
	expect(saved).toHaveLength(1);
	expect(saved[0]).toMatchObject({ reverseFound: true, checked: false, checkedAt: null });
	const input = {
		checked: true,
		reviewedURL: saved[0].url,
		reviewFingerprint: saved[0].reviewFingerprint
	};
	expect((await checkOffer(context.connection, event(input), item.id, saved[0].id)).status).toBe(
		200
	);
	saved = publicOffers(context.connection, item);
	expect(saved[0].checked).toBe(true);
	expect(saved[0].checkedAt).toEqual(expect.any(Number));
	expect(context.connection.sqlite.prepare('SELECT checked_by_id FROM offers').get()).toEqual({
		checked_by_id: 'admin'
	});
	expect(
		(
			await checkOffer(
				context.connection,
				event({ ...input, reviewedURL: 'https://shop.co.uk/other' }),
				item.id,
				saved[0].id
			)
		).status
	).toBe(409);
	context.connection.sqlite.prepare("UPDATE products SET variant='Red' WHERE id=?").run(item.id);
	expect((await checkOffer(context.connection, event(input), item.id, saved[0].id)).status).toBe(
		409
	);
	const current = { ...item, variant: 'Red' };
	const fresh = { ...input, reviewFingerprint: reviewFingerprint(current, saved[0].url) };
	expect((await checkOffer(context.connection, event(fresh), item.id, saved[0].id)).status).toBe(
		200
	);
	expect(
		(
			await checkOffer(
				context.connection,
				event({ ...fresh, checked: false }),
				item.id,
				saved[0].id
			)
		).status
	).toBe(200);
	expect(publicOffers(context.connection, current)[0].checked).toBe(false);
});
it.each(['buyer', 'viewer', 'contributor'] as const)(
	'does not let a %s add or check shopping links',
	async (role) => {
		const item = await photographedProduct();
		const job = await queue(item);
		await runNextJob(context.connection, {
			serpapiProvider: provider(),
			fetchPage: blockedPage,
			mediaRoot: directory
		});
		acceptInvitation(
			context.connection,
			context.actor('guest'),
			createInvitation(context.connection, context.admin, {
				email: 'guest@example.test',
				grants: [{ listId: 'visible', role }]
			}).token
		);
		expect(
			(
				await confirmSuggestion(
					context.connection,
					event({ jobId: job.id, index: 0, fields: ['offer'] }, 'guest'),
					item.id
				)
			).status
		).toBe(403);
		expect(
			(
				await checkOffer(
					context.connection,
					event(
						{ checked: true, reviewedURL: 'https://shop.co.uk/toy', reviewFingerprint: 'old' },
						'guest'
					),
					item.id,
					'foreign'
				)
			).status
		).toBe(403);
	}
);
it('stops before storage when access changes during retailer enrichment', async () => {
	const item = await photographedProduct();
	await queue(item);
	const fetchPage = vi.fn(async () => {
		context.connection.sqlite.exec("DELETE FROM session WHERE id='session-admin'");
		throw new Error('blocked');
	});
	await runNextJob(context.connection, {
		serpapiProvider: provider(),
		fetchPage,
		mediaRoot: directory
	});
	expect(fetchPage).toHaveBeenCalledTimes(1);
	expect(
		context.connection.sqlite.prepare('SELECT state,result_json FROM lookup_jobs').get()
	).toEqual({ state: 'uncertain', result_json: null });
});
it('preserves explicit no-match success and does not call any retailer', async () => {
	const item = await photographedProduct();
	await queue(item);
	const fetchPage = vi.fn(blockedPage);
	await runNextJob(context.connection, {
		serpapiProvider: provider({ search: vi.fn(async () => []) }),
		fetchPage,
		mediaRoot: directory
	});
	expect(await status(item)).toMatchObject({
		state: 'succeeded',
		result: {
			suggestions: [],
			matchingPages: [],
			message: expect.stringContaining('No buying pages')
		}
	});
	expect(fetchPage).not.toHaveBeenCalled();
});
it('reports missing setup at admission and dispatch without reserving', async () => {
	const item = await photographedProduct();
	vi.stubEnv('SERPAPI_API_KEY', '');
	expect((await identifyPost(context.connection, event(command(item)), item.id)).status).toBe(409);
	vi.stubEnv('SERPAPI_API_KEY', 'fixture-key');
	await queue(item);
	await runNextJob(context.connection, { serpapiProvider: null, mediaRoot: directory });
	expect(await status(item)).toMatchObject({
		state: 'failed',
		message: expect.stringContaining('not configured')
	});
	expect(serpapiStatus(context.connection).used).toBe(0);
});
it('allows a contributor to request photo search but rechecks a revoked grant before dispatch', async () => {
	const item = await photographedProduct();
	acceptInvitation(
		context.connection,
		context.actor('guest'),
		createInvitation(context.connection, context.admin, {
			email: 'guest@example.test',
			grants: [{ listId: 'visible', role: 'contributor' }]
		}).token
	);
	expect(
		(await identifyPost(context.connection, event(command(item), 'guest'), item.id)).status
	).toBe(200);
	setGrant(context.connection, context.admin, 'guest', { listId: 'visible', role: 'viewer' });
	const fake = provider();
	await runNextJob(context.connection, { serpapiProvider: fake, mediaRoot: directory });
	expect(fake.upload).not.toHaveBeenCalled();
});
it('rejects a foreign offer and stale stored title or destination, without changing the saved photo', async () => {
	const item = await photographedProduct();
	const job = await queue(item);
	await runNextJob(context.connection, {
		serpapiProvider: provider(),
		fetchPage: blockedPage,
		mediaRoot: directory
	});
	await confirmSuggestion(
		context.connection,
		event({ jobId: job.id, index: 0, fields: ['offer'] }),
		item.id
	);
	const offer = publicOffers(context.connection, item)[0];
	const input = {
		checked: true,
		reviewedURL: offer.url,
		reviewFingerprint: offer.reviewFingerprint
	};
	const other = await photographedProduct();
	expect((await checkOffer(context.connection, event(input), other.id, offer.id)).status).toBe(404);
	context.connection.sqlite
		.prepare("UPDATE products SET title='Another toy' WHERE id=?")
		.run(item.id);
	expect((await checkOffer(context.connection, event(input), item.id, offer.id)).status).toBe(409);
	context.connection.sqlite
		.prepare('UPDATE products SET title=? WHERE id=?')
		.run(item.title, item.id);
	context.connection.sqlite
		.prepare("UPDATE offers SET url='https://shop.co.uk/changed' WHERE id=?")
		.run(offer.id);
	expect((await checkOffer(context.connection, event(input), item.id, offer.id)).status).toBe(409);
	expect(
		context.connection.sqlite.prepare('SELECT id FROM media WHERE product_id=?').all(item.id)
	).toEqual([{ id: item.media[0].id }]);
	expect(publicOffers(context.connection, item)[0].checked).toBe(false);
});
