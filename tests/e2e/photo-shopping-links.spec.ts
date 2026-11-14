import { test, expect, type BrowserContext, type Browser } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import sharp from 'sharp';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';
import { fixture } from '../integration/identity-fixture';
import { createDatabase } from '../../src/lib/server/db/client';
import { updateIdentificationSettings } from '../../src/lib/server/enrichment/allowance';

const origin = 'http://localhost:4197';
const secret = 'test-only-photo-shopping-links-secret-8d10a957acf16';
let directory: string;
let server: ChildProcess;
let output = '';
const candidate = {
	title: 'Possible wooden train',
	description: null,
	variant: null,
	imageUrl: null,
	sourceUrl: 'https://shop.example/wooden-train',
	retrievedAt: 1730000000000,
	source: 'serpapi',
	offer: {
		url: 'https://shop.example/wooden-train',
		retailer: 'Toy shop',
		priceMinor: 2450,
		currency: 'GBP',
		priceText: '24.50',
		fromPrice: false
	},
	uncertainty: ['The colour or size may differ from the photographed item.']
};
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-photo-shopping-browser-'));
	const model = fixture();
	model.connection.sqlite.exec(
		"INSERT INTO products(id,title,variant,contributor_id) VALUES('reverse','Photographed train','Blue','admin'); INSERT INTO entries(id,product_id,list_id) VALUES('reverse-entry','reverse','visible'); INSERT INTO offers(id,product_id,url,retailer,reverse_provider) VALUES('reverse-offer','reverse','https://shop.example/existing','Toy shop','serpapi')"
	);
	for (const [id, role] of [
		['guest', 'viewer'],
		['other', 'contributor']
	] as const)
		acceptInvitation(
			model.connection,
			model.actor(id),
			createInvitation(model.connection, model.admin, {
				email: id + '@example.test',
				grants: [{ listId: 'visible', role }]
			}).token
		);
	updateIdentificationSettings(model.connection, {
		enabled: true,
		monthlyLimitMicrodollars: 3500,
		unitMicrodollars: 3500,
		pricingRevision: 'browser-fixture'
	});
	await model.connection.sqlite.backup(join(directory, 'gifts.sqlite'));
	model.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4197',
			ORIGIN: origin,
			PROTOCOL_HEADER: 'x-forwarded-proto',
			BODY_SIZE_LIMIT: '64M',
			DATABASE_PATH: join(directory, 'gifts.sqlite'),
			MEDIA_PATH: join(directory, 'media'),
			BETTER_AUTH_SECRET: secret,
			GOOGLE_CLIENT_ID: 'test-client',
			GOOGLE_CLIENT_SECRET: 'test-secret',
			ADMINISTRATOR_EMAIL: 'admin@example.test',
			SERPAPI_API_KEY: 'browser-fixture-never-dispatched',
			SERPAPI_MONTHLY_SEARCH_LIMIT: '200'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.stdout?.on('data', (chunk) => (output += chunk));
	server.stderr?.on('data', (chunk) => (output += chunk));
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(origin + '/login')).ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('Photo shopping browser fixture did not start: ' + output);
});
test.afterAll(async () => {
	if (server && server.exitCode === null) {
		server.kill('SIGTERM');
		await new Promise<void>((resolve) => server.once('exit', () => resolve()));
	}
	rmSync(directory, { recursive: true, force: true });
});
async function signIn(context: BrowserContext, user = 'admin') {
	const token = 'token-' + user;
	await context.addCookies([
		{
			name: 'better-auth.session_token',
			value: encodeURIComponent(`${token}.${await makeSignature(token, secret)}`),
			url: origin,
			httpOnly: true,
			sameSite: 'Lax'
		}
	]);
}
async function contextFor(browser: Browser, user = 'admin') {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, user);
	return context;
}

test('keeps reverse-found links unchecked in the saved idea and editor until a separate human check', async ({
	browser
}) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	try {
		await page.goto(origin + '/products/reverse');
		await expect(
			page.getByText('This link may be incorrect. Check the product and variant before buying.', {
				exact: true
			})
		).toBeVisible();
		await page.getByRole('button', { name: 'Edit idea', exact: true }).click();
		await page.getByText('More details', { exact: true }).click();
		await expect(
			page.getByText('This link may be incorrect. Check the product and variant before buying.', {
				exact: true
			})
		).toBeVisible();
		await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
		await page.getByLabel('I have opened this link and checked the product and variant').check();
		await page.getByRole('button', { name: 'Mark checked', exact: true }).click();
		await expect(page.getByText('Checked by a person on', { exact: false })).toBeVisible();
		await page.reload();
		await expect(page.getByText('Checked by a person on', { exact: false })).toBeVisible();
		await page.getByRole('button', { name: 'Edit idea', exact: true }).click();
		await page.getByText('More details', { exact: true }).click();
		await page.getByLabel('Price', { exact: true }).fill('21.00');
		await page.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(page.getByText('Checked by a person on', { exact: false })).toBeVisible();
		await page.getByRole('button', { name: 'Edit idea', exact: true }).click();
		await page.getByText('More details', { exact: true }).click();
		await page.getByLabel('Variant or size').fill('Red');
		await page.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(
			page.getByText('This link may be incorrect. Check the product and variant before buying.', {
				exact: true
			})
		).toBeVisible();
		await page.getByLabel('I have opened this link and checked the product and variant').check();
		await page.getByRole('button', { name: 'Mark checked', exact: true }).click();
		await expect(page.getByText('Checked by a person on', { exact: false })).toBeVisible();
		await page.getByRole('button', { name: 'Edit idea', exact: true }).click();
		await page.getByText('More details', { exact: true }).click();
		await page.getByLabel('Link', { exact: true }).fill('https://shop.example/changed');
		await page.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(
			page.getByText('This link may be incorrect. Check the product and variant before buying.', {
				exact: true
			})
		).toBeVisible();
		await page.getByLabel('I have opened this link and checked the product and variant').check();
		await page.getByRole('button', { name: 'Mark checked', exact: true }).click();
		await page.getByRole('button', { name: 'Mark unchecked again', exact: true }).click();
		await expect(
			page.getByText('This link may be incorrect. Check the product and variant before buying.', {
				exact: true
			})
		).toBeVisible();
	} finally {
		await context.close();
	}
});

test('saves a photo, finds possible buying pages and adds only an unchecked link', async ({
	browser
}) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	try {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(origin + '/capture?list=visible');
		await page.getByLabel('Title', { exact: true }).fill('My photographed train');
		await page.getByLabel('Photos').setInputFiles({
			name: 'shop-photo.png',
			mimeType: 'image/png',
			buffer: await sharp({ create: { width: 3, height: 3, channels: 3, background: 'green' } })
				.png()
				.toBuffer()
		});
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		await page.getByRole('link', { name: 'Find where to buy', exact: true }).click();
		await expect(
			page.getByText(
				'A compressed copy of the selected photo goes to SerpAPI and Google. The original stays private in this app.',
				{ exact: true }
			)
		).toBeVisible();
		const request = page.waitForRequest(
			(request) => request.url().endsWith('/identify') && request.method() === 'POST'
		);
		await page.getByRole('button', { name: 'Find where to buy', exact: true }).click();
		const command = (await request).postDataJSON();
		expect(command).toMatchObject({
			kind: 'vision',
			provider: 'serpapi',
			mediaId: expect.any(String),
			operationId: expect.any(String)
		});
		const db = createDatabase({ filename: join(directory, 'gifts.sqlite') });
		try {
			await expect
				.poll(() =>
					db.sqlite
						.prepare('SELECT count(*) AS count FROM lookup_jobs WHERE operation_id=?')
						.get(command.operationId)
				)
				.toEqual({ count: 1 });
			// A completed provider fixture feeds the real result, confirmation and review routes.
			db.sqlite
				.prepare(
					"UPDATE lookup_jobs SET state='succeeded',result_json=?,finished_at=? WHERE operation_id=?"
				)
				.run(
					JSON.stringify({
						provider: 'serpapi',
						suggestions: [candidate],
						labels: [],
						matchingPages: [],
						message: 'Possible matches need checking.'
					}),
					Date.now(),
					command.operationId
				);
		} finally {
			db.close();
		}
		await page.getByRole('button', { name: 'Refresh photo search status', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Possible wooden train', exact: true })
		).toBeVisible();
		const inspect = page.getByRole('link', { name: 'Inspect possible match', exact: true });
		await expect(inspect).toHaveAttribute('href', candidate.sourceUrl);
		await context.route('https://shop.example/**', (route) =>
			route.fulfill({
				contentType: 'text/html',
				body: '<title>Fixture buying page</title><h1>Check this train and variant</h1>'
			})
		);
		const opened = page.waitForEvent('popup');
		await inspect.click();
		const inspected = await opened;
		await expect(inspected).toHaveURL(candidate.sourceUrl);
		await inspected.close();
		await expect(page.getByText('shop.example', { exact: false }).last()).toBeVisible();
		await expect(page.getByText('The colour or size may differ', { exact: false })).toBeVisible();
		await page.getByRole('button', { name: 'Add link', exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect(
			page
				.getByRole('region', { name: 'Shopping links', exact: true })
				.getByText('This link may be incorrect. Check the product and variant before buying.', {
					exact: true
				})
		).toBeVisible();
		const product = await (
			await context.request.get(origin + '/api' + new URL(page.url()).pathname)
		).json();
		expect(product).toMatchObject({ title: 'My photographed train', sourceUrl: null });
		expect(product.offers).toHaveLength(1);
		expect(product.offers[0]).toMatchObject({
			reverseFound: true,
			checked: false,
			url: candidate.sourceUrl
		});
		expect(product.media).toHaveLength(1);
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
			.toBe(true);
	} finally {
		await context.close();
	}
});

test('viewers read reverse-link warnings without search, add or check controls', async ({
	browser
}) => {
	const context = await contextFor(browser, 'guest');
	const page = await context.newPage();
	try {
		await page.goto(origin + '/products/reverse');
		await expect(
			page.getByText('This link may be incorrect. Check the product and variant before buying.', {
				exact: true
			})
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Mark checked', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Find where to buy', exact: true })).toHaveCount(
			0
		);
		await expect(page.getByRole('button', { name: 'Edit idea', exact: true })).toHaveCount(0);
	} finally {
		await context.close();
	}
});

async function savedPhoto(context: BrowserContext, title: string) {
	const response = await context.request.post(origin + '/api/products', {
		headers: { origin },
		multipart: {
			draft: JSON.stringify({ title, listIds: ['visible'] }),
			photos: {
				name: 'fixture-photo.png',
				mimeType: 'image/png',
				buffer: await sharp({ create: { width: 3, height: 3, channels: 3, background: 'blue' } })
					.png()
					.toBuffer()
			}
		}
	});
	expect(response.ok()).toBe(true);
	return (await response.json()) as { id: string; media: { id: string }[] };
}

test('recovers an admitted operation after reload without dispatching again', async ({
	browser
}) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	try {
		const product = await savedPhoto(context, 'Recover this photo request');
		await page.goto(origin + '/products/' + product.id);
		let posts = 0;
		let release: () => void = () => {};
		const delayed = new Promise<void>((resolve) => (release = resolve));
		let admitted: () => void = () => {};
		const admission = new Promise<void>((resolve) => (admitted = resolve));
		await page.route('**/identify', async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			posts++;
			const response = await route.fetch();
			admitted();
			await delayed;
			await route.fulfill({ response }).catch(() => {});
		});
		await page.getByRole('button', { name: 'Find where to buy', exact: true }).click();
		await admission;
		await page.reload();
		release();
		await expect(
			page.getByRole('heading', { name: 'Photo search · queued', exact: true })
		).toBeVisible();
		await page.getByRole('button', { name: 'Refresh photo search status', exact: true }).click();
		expect(posts).toBe(1);
		const jobs = await (
			await context.request.get(origin + `/api/products/${product.id}/identify`)
		).json();
		expect(
			jobs.jobs.filter((job: { provider: string }) => job.provider === 'serpapi')
		).toHaveLength(1);
	} finally {
		await context.close();
	}
});

test('discards a delayed response after navigating to another photographed idea', async ({
	browser
}) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	try {
		const first = await savedPhoto(context, 'First private photo');
		const second = await savedPhoto(context, 'Second private photo');
		await page.goto(origin + '/products/' + first.id);
		let release: () => void = () => {};
		const delayed = new Promise<void>((resolve) => (release = resolve));
		let admitted: () => void = () => {};
		const admission = new Promise<void>((resolve) => (admitted = resolve));
		await page.route(`**/api/products/${first.id}/identify`, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			const response = await route.fetch();
			admitted();
			await delayed;
			await route.fulfill({ response }).catch(() => {});
		});
		await page.getByRole('button', { name: 'Find where to buy', exact: true }).click();
		await admission;
		await page.goto(origin + '/products/' + second.id);
		release();
		await expect(
			page.getByRole('heading', { name: 'Second private photo', exact: true })
		).toBeVisible();
		await expect(page.getByRole('heading', { name: /Photo search ·/ })).toHaveCount(0);
		await expect(
			page.getByRole('button', { name: 'Find where to buy', exact: true })
		).toBeEnabled();
		const jobs = await (
			await context.request.get(origin + `/api/products/${second.id}/identify`)
		).json();
		expect(jobs.jobs).toHaveLength(0);
	} finally {
		await context.close();
	}
});

test('discards an admitted response when the signed-in actor changes', async ({ browser }) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	try {
		const product = await savedPhoto(context, 'Account-bound photo');
		await page.goto(origin + '/products/' + product.id);
		let release: () => void = () => {};
		const delayed = new Promise<void>((resolve) => (release = resolve));
		let admitted: () => void = () => {};
		const admission = new Promise<void>((resolve) => (admitted = resolve));
		await page.route('**/identify', async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			const response = await route.fetch();
			admitted();
			await delayed;
			await route.fulfill({ response }).catch(() => {});
		});
		await page.getByRole('button', { name: 'Find where to buy', exact: true }).click();
		await admission;
		await signIn(context, 'other');
		release();
		await expect(
			page.getByText(
				'The signed-in account changed. Reload this idea before searching or changing links.',
				{ exact: true }
			)
		).toBeVisible();
		await expect(page.getByRole('heading', { name: /Photo search ·/ })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Add link', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Mark checked', exact: true })).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test('contributors can request matches but cannot add or check links', async ({ browser }) => {
	const admin = await contextFor(browser);
	const product = await savedPhoto(admin, 'Contributor photo');
	await admin.close();
	const context = await contextFor(browser, 'other');
	const page = await context.newPage();
	try {
		await page.goto(origin + '/products/' + product.id);
		await expect(
			page.getByRole('button', { name: 'Find where to buy', exact: true })
		).toBeEnabled();
		await page.getByRole('button', { name: 'Find where to buy', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Photo search · queued', exact: true })
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Add link', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Mark checked', exact: true })).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test('no-match and uncertain results retain manual editing and never re-dispatch on refresh', async ({
	browser
}) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	try {
		const product = await savedPhoto(context, 'Uncertain photo');
		await page.goto(origin + '/products/' + product.id);
		await page.getByRole('button', { name: 'Find where to buy', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Photo search · queued', exact: true })
		).toBeVisible();
		const db = createDatabase({ filename: join(directory, 'gifts.sqlite') });
		try {
			db.sqlite
				.prepare("UPDATE lookup_jobs SET state='succeeded',result_json=? WHERE product_id=?")
				.run(
					JSON.stringify({
						suggestions: [],
						labels: [],
						matchingPages: [],
						message: 'No possible matches.'
					}),
					product.id
				);
			await page.getByRole('button', { name: 'Refresh photo search status', exact: true }).click();
			await expect(
				page.getByText(
					'No possible buying pages were found. Keep this idea and add a link or details manually.',
					{ exact: true }
				)
			).toBeVisible();
			db.sqlite
				.prepare("UPDATE lookup_jobs SET state='uncertain',result_json=NULL WHERE product_id=?")
				.run(product.id);
			let posts = 0;
			await page.route('**/identify', (route) => {
				if (route.request().method() === 'POST') posts++;
				return route.continue();
			});
			await page.getByRole('button', { name: 'Refresh photo search status', exact: true }).click();
			await expect(
				page.getByText('The provider outcome is uncertain.', { exact: false })
			).toBeVisible();
			await page.getByRole('button', { name: 'Refresh photo search status', exact: true }).click();
			expect(posts).toBe(0);
		} finally {
			db.close();
		}
		await page.getByRole('button', { name: 'Edit idea', exact: true }).click();
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Uncertain photo');
	} finally {
		await context.close();
	}
});

test('changing the selected photo discards its delayed response and recovers only its own job', async ({
	browser
}) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	try {
		const product = await savedPhoto(context, 'Two different photos');
		const uploaded = await context.request.post(
			origin + `/api/products/${product.id}/identify/photo`,
			{
				headers: { origin },
				multipart: {
					operationId: crypto.randomUUID(),
					photo: {
						name: 'second-photo.png',
						mimeType: 'image/png',
						buffer: await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
							.png()
							.toBuffer()
					}
				}
			}
		);
		expect(uploaded.ok()).toBe(true);
		const current = await (
			await context.request.get(origin + `/api/products/${product.id}`)
		).json();
		await page.goto(origin + '/products/' + product.id);
		await page
			.getByRole('combobox', { name: 'Photo to search', exact: true })
			.selectOption(product.media[0].id);
		let release: () => void = () => {};
		const delayed = new Promise<void>((resolve) => (release = resolve));
		let admitted: () => void = () => {};
		const admission = new Promise<void>((resolve) => (admitted = resolve));
		await page.route('**/identify', async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			const response = await route.fetch();
			admitted();
			await delayed;
			await route.fulfill({ response }).catch(() => {});
		});
		await page.getByRole('button', { name: 'Find where to buy', exact: true }).click();
		await admission;
		const second = current.media.find(
			(image: { id: string }) => image.id !== product.media[0].id
		).id;
		await page.getByRole('combobox', { name: 'Photo to search', exact: true }).selectOption(second);
		release();
		await expect(page.getByRole('heading', { name: /Photo search ·/ })).toHaveCount(0);
		await expect(
			page.getByRole('button', { name: 'Find where to buy', exact: true })
		).toBeEnabled();
		await page
			.getByRole('combobox', { name: 'Photo to search', exact: true })
			.selectOption(product.media[0].id);
		await expect(
			page.getByRole('heading', { name: 'Photo search · queued', exact: true })
		).toBeVisible();
	} finally {
		await context.close();
	}
});

test('disabled searches and exhausted monthly slots keep saved ideas editable', async ({
	browser
}) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	const db = createDatabase({ filename: join(directory, 'gifts.sqlite') });
	const reservationIds: string[] = [];
	try {
		const product = await savedPhoto(context, 'Keep editing without search');
		db.sqlite.exec('UPDATE identification_settings SET enabled=0');
		await page.goto(origin + '/products/' + product.id);
		await expect(
			page.getByText(
				'Photo search is disabled by the administrator. You can still edit this idea manually.',
				{ exact: true }
			)
		).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Find where to buy', exact: true })
		).toBeDisabled();
		db.sqlite.exec('UPDATE identification_settings SET enabled=1');
		for (let index = 0; index < 200; index++) {
			const id = 'quota-fixture-' + index;
			reservationIds.push(id);
			db.sqlite
				.prepare(
					"INSERT INTO lookup_jobs(id,product_id,actor_id,actor_session_id,operation_id,fingerprint,provider,kind,state) VALUES(?,?,'admin','session-admin',?,?,'serpapi','vision','uncertain')"
				)
				.run(id, product.id, id, id);
			db.sqlite
				.prepare('INSERT INTO serpapi_search_reservations(job_id,month) VALUES(?,?)')
				.run(id, new Date().toISOString().slice(0, 7));
		}
		await page.getByRole('button', { name: 'Refresh photo search status', exact: true }).click();
		await expect(
			page.getByText(
				'The monthly photo search allowance is used up. Add a link manually or try in a later month.',
				{ exact: true }
			)
		).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Find where to buy', exact: true })
		).toBeDisabled();
		await page.getByRole('button', { name: 'Edit idea', exact: true }).click();
		await page.getByLabel('Title', { exact: true }).fill('Still editable');
		await page.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Still editable', exact: true })).toBeVisible();
	} finally {
		db.sqlite.exec('UPDATE identification_settings SET enabled=1');
		for (const id of reservationIds) {
			db.sqlite.prepare('DELETE FROM serpapi_search_reservations WHERE job_id=?').run(id);
			db.sqlite.prepare('DELETE FROM lookup_jobs WHERE id=?').run(id);
		}
		db.close();
		await context.close();
	}
});

test('requires a fresh human attestation when applying a suggestion changes the product identity', async ({
	browser
}) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	const db = createDatabase({ filename: join(directory, 'gifts.sqlite') });
	try {
		const result = {
			suggestions: [
				{
					...candidate,
					title: 'A different train identity',
					source: 'json-ld',
					offer: null,
					uncertainty: []
				}
			],
			labels: [],
			matchingPages: [],
			message: 'Review the suggested title.'
		};
		db.sqlite
			.prepare(
				"INSERT INTO lookup_jobs(id,product_id,actor_id,actor_session_id,operation_id,fingerprint,provider,kind,state,result_json) VALUES('attestation-title','reverse','admin','session-admin','attestation-title-operation','attestation-title-fingerprint','vision','metadata','succeeded',?)"
			)
			.run(JSON.stringify(result));
		await page.goto(origin + '/products/reverse');
		const attestation = page.getByLabel(
			'I have opened this link and checked the product and variant'
		);
		await attestation.check();
		await expect(page.getByRole('button', { name: 'Mark checked', exact: true })).toBeEnabled();
		await page.getByText('Source metadata · succeeded', { exact: false }).click();
		await page.getByLabel('Title', { exact: true }).check();
		await page.getByRole('button', { name: 'Confirm selected details', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'A different train identity', exact: true, level: 1 })
		).toBeVisible();
		await expect(attestation).not.toBeChecked();
		await expect(page.getByRole('button', { name: 'Mark checked', exact: true })).toBeDisabled();
		await attestation.check();
		await expect(page.getByRole('button', { name: 'Mark checked', exact: true })).toBeEnabled();
		const product = await (await context.request.get(origin + '/api/products/reverse')).json();
		expect(product.offers[0].checked).toBe(false);
	} finally {
		db.close();
		await context.close();
	}
});

test('keeps the admitted job when an older status response arrives last', async ({ browser }) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	let release: () => void = () => {};
	try {
		const product = await savedPhoto(context, 'Ordered photo status');
		await page.goto(origin + '/products/' + product.id);
		await expect(
			page.getByRole('button', { name: 'Find where to buy', exact: true })
		).toBeEnabled();
		let posts = 0;
		let captured: () => void = () => {};
		const oldSnapshot = new Promise<void>((resolve) => (captured = resolve));
		const delayed = new Promise<void>((resolve) => (release = resolve));
		let holdNextStatus = true;
		await page.route(`**/api/products/${product.id}/identify`, async (route) => {
			if (route.request().method() === 'POST') {
				posts++;
				return route.continue();
			}
			if (!holdNextStatus) return route.continue();
			holdNextStatus = false;
			const response = await route.fetch();
			expect((await response.json()).jobs).toHaveLength(0);
			captured();
			await delayed;
			await route.fulfill({ response }).catch(() => {});
		});
		await page.getByRole('button', { name: 'Refresh photo search status', exact: true }).click();
		await oldSnapshot;
		await page.getByRole('button', { name: 'Find where to buy', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Photo search · queued', exact: true })
		).toBeVisible();
		await expect(
			page.getByText('The result of the saved request is not yet known.', { exact: false })
		).toHaveCount(0);
		const returned = page.waitForResponse(
			(response) =>
				response.url().endsWith(`/api/products/${product.id}/identify`) &&
				response.request().method() === 'GET'
		);
		release();
		await returned;
		// Let the released fetch and Svelte's next paint finish before checking retained state.
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				)
		);
		expect(
			await page.getByRole('heading', { name: 'Photo search · queued', exact: true }).count()
		).toBe(1);
		expect(await page.getByRole('button', { name: 'Searching…', exact: true }).count()).toBe(1);
		await expect(page.getByRole('button', { name: 'Searching…', exact: true })).toBeDisabled();
		expect(posts).toBe(1);
		const status = await (
			await context.request.get(origin + `/api/products/${product.id}/identify`)
		).json();
		expect(status.jobs).toHaveLength(1);
	} finally {
		release();
		await context.close();
	}
});

for (const mutation of ['add', 'check', 'uncheck'] as const) {
	test(`refreshes saved link state after a photo switch during ${mutation}`, async ({
		browser
	}) => {
		const context = await contextFor(browser);
		const page = await context.newPage();
		let release: () => void = () => {};
		try {
			const product = await savedPhoto(context, `Photo switch during ${mutation}`);
			const uploaded = await context.request.post(
				origin + `/api/products/${product.id}/identify/photo`,
				{
					headers: { origin },
					multipart: {
						operationId: crypto.randomUUID(),
						photo: {
							name: 'another-photo.png',
							mimeType: 'image/png',
							buffer: await sharp({
								create: { width: 4, height: 4, channels: 3, background: 'red' }
							})
								.png()
								.toBuffer()
						}
					}
				}
			);
			expect(uploaded.ok()).toBe(true);
			const db = createDatabase({ filename: join(directory, 'gifts.sqlite') });
			const jobId = crypto.randomUUID();
			try {
				db.sqlite
					.prepare(
						"INSERT INTO lookup_jobs(id,product_id,media_id,actor_id,actor_session_id,operation_id,fingerprint,provider,kind,state,result_json) VALUES(?,?,?,'admin','session-admin',?,?,'serpapi','vision','succeeded',?)"
					)
					.run(
						jobId,
						product.id,
						product.media[0].id,
						crypto.randomUUID(),
						crypto.randomUUID(),
						JSON.stringify({
							provider: 'serpapi',
							suggestions: [candidate],
							labels: [],
							matchingPages: [],
							message: 'Possible matches need checking.'
						})
					);
			} finally {
				db.close();
			}
			if (mutation !== 'add') {
				const added = await context.request.post(
					origin + `/api/products/${product.id}/identify/confirm`,
					{ headers: { origin }, data: { jobId, index: 0, fields: ['offer'] } }
				);
				expect(added.ok()).toBe(true);
			}
			if (mutation === 'uncheck') {
				const saved = await (
					await context.request.get(origin + `/api/products/${product.id}`)
				).json();
				const offer = saved.offers[0];
				const checked = await context.request.post(
					origin + `/api/products/${product.id}/offers/${offer.id}/check`,
					{
						headers: { origin },
						data: {
							checked: true,
							reviewedURL: offer.url,
							reviewFingerprint: offer.reviewFingerprint
						}
					}
				);
				expect(checked.ok()).toBe(true);
			}
			await page.goto(origin + '/products/' + product.id);
			const photo = page.getByRole('combobox', { name: 'Photo to search', exact: true });
			await photo.selectOption(product.media[0].id);
			await expect(
				page.getByRole('heading', { name: 'Possible wooden train', exact: true })
			).toBeVisible();
			let committed: () => void = () => {};
			const saved = new Promise<void>((resolve) => (committed = resolve));
			const delayed = new Promise<void>((resolve) => (release = resolve));
			await page.route(
				`**/api/products/${product.id}/${mutation === 'add' ? 'identify/confirm' : 'offers/*/check'}`,
				async (route) => {
					const response = await route.fetch();
					expect(response.ok()).toBe(true);
					committed();
					await delayed;
					await route.fulfill({ response }).catch(() => {});
				}
			);
			if (mutation === 'check')
				await page
					.getByLabel('I have opened this link and checked the product and variant')
					.check();
			await page
				.getByRole('button', {
					name:
						mutation === 'add'
							? 'Add link'
							: mutation === 'check'
								? 'Mark checked'
								: 'Mark unchecked again',
					exact: true
				})
				.click();
			await saved;
			await photo.selectOption({ label: 'another-photo.png' });
			await expect(
				page.getByRole('button', { name: 'Find where to buy', exact: true })
			).toBeEnabled();
			release();
			const links = page.getByRole('region', { name: 'Shopping links', exact: true });
			if (mutation === 'check')
				await expect(links.getByText('Checked by a person on', { exact: false })).toBeVisible();
			else
				await expect(
					links.getByText(
						'This link may be incorrect. Check the product and variant before buying.',
						{ exact: true }
					)
				).toBeVisible();
			const updated = await (
				await context.request.get(origin + `/api/products/${product.id}`)
			).json();
			expect(updated.offers).toHaveLength(1);
			expect(updated.offers[0].checked).toBe(mutation === 'check');
		} finally {
			release();
			await context.close();
		}
	});
}

test('automatically recovers a queued search after one transient status failure', async ({
	browser
}) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	try {
		const product = await savedPhoto(context, 'Recover automatic photo polling');
		await page.goto(origin + '/products/' + product.id);
		let posts = 0;
		await page.route(`**/api/products/${product.id}/identify`, (route) => {
			if (route.request().method() === 'POST') posts++;
			return route.continue();
		});
		await page.getByRole('button', { name: 'Find where to buy', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Photo search · queued', exact: true })
		).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Refresh photo search status', exact: true })
		).toBeEnabled();
		let failed: () => void = () => {};
		const failure = new Promise<void>((resolve) => (failed = resolve));
		let failNextStatus = true;
		await page.route(`**/api/products/${product.id}/identify`, async (route) => {
			if (route.request().method() !== 'GET' || !failNextStatus) return route.fallback();
			failNextStatus = false;
			await route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Temporary status connection failure.' })
			});
			failed();
		});
		await failure;
		await expect(
			page.getByText('Temporary status connection failure.', { exact: true })
		).toBeVisible();
		const db = createDatabase({ filename: join(directory, 'gifts.sqlite') });
		try {
			db.sqlite
				.prepare(
					"UPDATE lookup_jobs SET state='succeeded',result_json=?,finished_at=? WHERE product_id=?"
				)
				.run(
					JSON.stringify({
						provider: 'serpapi',
						suggestions: [candidate],
						labels: [],
						matchingPages: [],
						message: 'Automatically recovered possible matches.'
					}),
					Date.now(),
					product.id
				);
		} finally {
			db.close();
		}
		await expect(
			page.getByRole('heading', { name: 'Possible wooden train', exact: true })
		).toBeVisible({ timeout: 8000 });
		expect(posts).toBe(1);
		const status = await (
			await context.request.get(origin + `/api/products/${product.id}/identify`)
		).json();
		expect(status.jobs).toHaveLength(1);
		expect(status.jobs[0].state).toBe('succeeded');
	} finally {
		await context.close();
	}
});

test('stops status polling and hides prior search authority after definite access loss', async ({
	browser
}) => {
	const context = await contextFor(browser);
	const page = await context.newPage();
	try {
		await page.clock.install();
		const product = await savedPhoto(context, 'Revoked photo access');
		await page.goto(origin + '/products/' + product.id);
		await page.getByRole('button', { name: 'Find where to buy', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Photo search · queued', exact: true })
		).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Refresh photo search status', exact: true })
		).toBeEnabled();
		let statusGets = 0;
		await page.route(`**/api/products/${product.id}/identify`, async (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			statusGets++;
			await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Access denied' });
		});
		await page.clock.runFor(2100);
		await expect(
			page.getByText('This action could not be completed. Your saved idea is unchanged.', {
				exact: true
			})
		).toBeVisible();
		await expect(page.getByRole('heading', { name: /Photo search ·/ })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Find where to buy', exact: true })).toHaveCount(
			0
		);
		await expect(
			page.getByRole('button', { name: 'Make a separate search request', exact: true })
		).toHaveCount(0);
		await page.clock.runFor(6000);
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await page.clock.runFor(2100);
		expect(statusGets).toBe(1);
	} finally {
		await context.close();
	}
});
