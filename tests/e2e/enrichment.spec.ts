import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import sharp from 'sharp';
import { fixture } from '../integration/identity-fixture';
const origin = 'http://localhost:4191';
const secret = 'test-only-enrichment-secret-8d10a957acf16';
let directory: string;
let server: ChildProcess;
let output = '';
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-enrichment-browser-'));
	const model = fixture();
	model.connection.sqlite.exec(
		"INSERT INTO products(id,title,variant,source_url,contributor_id) VALUES('saved','Saved idea','Original size','https://shop.example/source','admin');INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES('saved-entry','saved','visible',2000)"
	);
	const result = {
		suggestions: [
			{
				title: 'Woodland game',
				description: 'A lovely game',
				variant: 'Travel size',
				imageUrl: null,
				sourceUrl: 'https://shop.example/game',
				retrievedAt: 123,
				source: 'json-ld',
				offer: {
					url: 'https://shop.example/buy',
					retailer: 'Toy shop',
					priceMinor: 2450,
					currency: 'GBP',
					priceText: '24.50',
					fromPrice: false
				},
				uncertainty: []
			}
		],
		labels: [],
		matchingPages: [],
		message: 'Review these suggestions.'
	};
	model.connection.sqlite
		.prepare(
			"INSERT INTO lookup_jobs(id,product_id,actor_id,actor_session_id,operation_id,fingerprint,kind,state,result_json) VALUES('evidence','saved','admin','session-admin','browser-operation','browser-fingerprint','metadata','succeeded',?)"
		)
		.run(JSON.stringify(result));
	await model.connection.sqlite.backup(join(directory, 'gifts.sqlite'));
	model.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4191',
			ORIGIN: origin,
			PROTOCOL_HEADER: 'x-forwarded-proto',
			BODY_SIZE_LIMIT: '64M',
			DATABASE_PATH: join(directory, 'gifts.sqlite'),
			MEDIA_PATH: join(directory, 'media'),
			BETTER_AUTH_SECRET: secret,
			GOOGLE_CLIENT_ID: 'test-client',
			GOOGLE_CLIENT_SECRET: 'test-secret',
			ADMINISTRATOR_EMAIL: 'admin@example.test'
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
	throw new Error('Enrichment test server did not start: ' + output);
});
test.afterAll(async () => {
	if (server && server.exitCode === null) {
		server.kill('SIGTERM');
		await new Promise<void>((resolve) => server.once('exit', () => resolve()));
	}
	rmSync(directory, { recursive: true, force: true });
});
async function signIn(context: BrowserContext) {
	const token = 'token-admin';
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
test('keeps an unfinished idea local across reload and only publishes after explicit Save', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context);
	const page = await context.newPage();
	let published = 0;
	await context.route('**/api/captures', (route) => {
		published++;
		return route.continue();
	});
	try {
		await page.goto(origin + '/capture');
		await page.getByLabel('Title', { exact: true }).fill('Keep this console for later');
		await expect(page.getByRole('button', { name: 'Keep for later', exact: true })).toBeVisible({
			timeout: 2000
		});
		await page.getByRole('button', { name: 'Keep for later', exact: true }).click();
		await expect(page.getByText('Kept on this device', { exact: false }).first()).toBeVisible();
		await page.reload();
		await page.getByRole('button', { name: 'Keep this console for later', exact: true }).click();
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
			'Keep this console for later'
		);
		await page.waitForLoadState('networkidle');
		expect(published).toBe(0);
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		expect(published).toBe(1);
	} finally {
		await context.close();
	}
});
test('keeps legacy browser captures recoverable without a bookmarklet setup or automatic publication', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context);
	const page = await context.newPage();
	let published = 0;
	await context.route('**/api/captures', (route) => {
		published++;
		return route.continue();
	});
	try {
		const picture = await sharp({
			create: { width: 3, height: 3, channels: 3, background: '#79a' }
		})
			.webp()
			.toBuffer();
		await context.route('**/api/metadata/image', (route) =>
			route.fulfill({ contentType: 'image/webp', body: picture })
		);
		await page.goto(
			origin +
				'/capture#gift=' +
				encodeURIComponent(
					JSON.stringify({
						version: 1,
						sourceUrl: 'https://www.smythstoys.com/toy/p/266502',
						title: 'Legacy console',
						imageUrl: 'https://images.example/toy.webp',
						priceText: '49.95',
						currency: 'GBP',
						fromPrice: false
					})
				)
		);
		await expect(page).toHaveURL(/\/capture\?draft=/);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Legacy console');
		await expect(page.getByText('browser-image.webp', { exact: false })).toBeVisible();
		await expect(page.getByText('Save from a shop page', { exact: true })).toHaveCount(0);
		await page.reload();
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Legacy console');
		await expect(page.getByText('browser-image.webp', { exact: false })).toBeVisible();
		expect(published).toBe(0);
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		expect(published).toBe(1);
		const href = await page
			.getByRole('link', { name: 'View idea', exact: true })
			.getAttribute('href');
		const saved = await (await context.request.get(origin + '/api' + href)).json();
		expect(saved).toMatchObject({
			title: 'Legacy console',
			sourceUrl: 'https://www.smythstoys.com/toy/p/266502'
		});
		expect(saved.media).toHaveLength(1);
		expect(saved.offers[0]).toMatchObject({ priceMinor: 4995, currency: 'GBP' });
	} finally {
		await context.close();
	}
});
test('crops a screenshot locally, fills on request and preserves deliberate edits through undo and saving', async ({
	browser
}) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	await signIn(context);
	const page = await context.newPage();
	let imageRequests = 0;
	await context.route('**/api/metadata', (route) =>
		route.fulfill({ json: { suggestions: [], blocked: true, message: 'Shop blocked' } })
	);
	await context.route('**/api/capture-details', async (route) => {
		if (route.request().method() === 'GET')
			return route.fulfill({ json: { configured: true, enabled: true } });
		imageRequests++;
		const request = new Request(origin + '/api/capture-details', {
			method: 'POST',
			headers: route.request().headers(),
			body: new Uint8Array(route.request().postDataBuffer()!)
		});
		const form = await request.formData();
		expect(form.get('kind')).toBe('image');
		const image = form.get('image') as File;
		const bytes = Buffer.from(await image.arrayBuffer());
		const metadata = await sharp(bytes).metadata();
		expect(metadata.width).toBe(50);
		expect(metadata.height).toBe(100);
		const pixel = await sharp(bytes)
			.extract({ left: 25, top: 50, width: 1, height: 1 })
			.removeAlpha()
			.raw()
			.toBuffer();
		expect(pixel[0]).toBeLessThan(30);
		expect(pixel[1]).toBeGreaterThan(220);
		expect(pixel[2]).toBeLessThan(30);
		return route.fulfill({
			json: {
				suggestions: [
					{
						title: 'Model console',
						description: 'A description to review',
						variant: 'Blue',
						imageUrl: null,
						sourceUrl: 'https://shop.example/console',
						retrievedAt: Date.now(),
						source: 'gemini',
						offer: {
							url: 'https://shop.example/console',
							retailer: 'Shop',
							priceMinor: 4200,
							currency: 'GBP',
							priceText: '42.00',
							fromPrice: false
						},
						uncertainty: []
					}
				],
				message: 'Review the details'
			}
		});
	});
	try {
		await page.goto(origin + '/capture');
		await expect(page.getByText('Adding as admin', { exact: true })).toBeVisible();
		await page.getByLabel('Product link').fill('https://shop.example/console');
		await expect(
			page.getByText("We couldn't read this shop page.", { exact: false })
		).toBeVisible();
		await page.getByLabel('Title', { exact: true }).fill('Console for Luke');
		await page.getByLabel('Description', { exact: true }).fill('My note');
		await page.getByLabel('Description', { exact: true }).fill('');
		await page.getByRole('checkbox', { name: 'Child · Birthday Birthday' }).check();
		const photo = await sharp(
			Buffer.from(
				'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="100" height="100" fill="red"/><rect x="100" width="100" height="100" fill="#00ff00"/></svg>'
			)
		)
			.png()
			.toBuffer();
		await page
			.getByLabel('Photos', { exact: false })
			.setInputFiles({ name: 'shop-shot.png', mimeType: 'image/png', buffer: photo });
		await page.getByRole('button', { name: 'Crop or rotate', exact: true }).click();
		await page.getByRole('button', { name: 'Rotate right', exact: true }).click();
		await expect(
			page.getByRole('button', { name: 'Use cropped image', exact: true })
		).toBeEnabled();
		await page.getByLabel('Crop left (%)', { exact: true }).fill('50');
		await page.getByLabel('Crop top (%)', { exact: true }).fill('50');
		await page.getByLabel('Crop width (%)', { exact: true }).fill('50');
		await page.getByLabel('Crop height (%)', { exact: true }).fill('50');
		await page.getByRole('button', { name: 'Use cropped image', exact: true }).click();
		await expect(page.getByText('shop-shot-crop.webp', { exact: true })).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
			.toBe(true);
		await page.screenshot({
			path: test.info().outputPath('gift-new-capture-mobile.png'),
			fullPage: true
		});
		expect(imageRequests).toBe(0);
		const fillFromImage = page.getByRole('button', { name: 'Fill from image', exact: true });
		const photosInput = page.getByLabel('Photos', { exact: false });
		const photosBox = await photosInput.boundingBox();
		const fillBox = await fillFromImage.boundingBox();
		expect(photosBox).not.toBeNull();
		expect(fillBox).not.toBeNull();
		expect(fillBox!.y).toBeGreaterThan(photosBox!.y);
		await expect(
			page.getByText('Sends only the selected image to Google.', { exact: false })
		).toBeVisible();
		await fillFromImage.click();
		await expect(page.getByLabel('Estimated price (£)', { exact: true })).toHaveValue('42.00');
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Console for Luke');
		await expect(page.getByLabel('Description', { exact: true })).toHaveValue('');
		await page.getByText('More details', { exact: true }).click();
		await expect(page.getByLabel('Variant or size')).toHaveValue('Blue');
		await page.getByLabel('Estimated price (£)', { exact: true }).fill('35.00');
		const undoAutofill = page.getByRole('button', { name: 'Undo autofill', exact: true });
		const [currentPhotosBox, undoBox] = await Promise.all([
			photosInput.boundingBox(),
			undoAutofill.boundingBox()
		]);
		expect(currentPhotosBox).not.toBeNull();
		expect(undoBox).not.toBeNull();
		expect(undoBox!.y).toBeGreaterThan(currentPhotosBox!.y);
		await undoAutofill.click();
		await expect(page.getByLabel('Variant or size')).toHaveValue('');
		await expect(page.getByLabel('Estimated price (£)', { exact: true })).toHaveValue('35.00');
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Console for Luke');
		await expect(page.getByRole('checkbox', { name: 'Child · Birthday Birthday' })).toBeChecked();
		await page.setViewportSize({ width: 1280, height: 900 });
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
			.toBe(true);
		await page.screenshot({
			path: test.info().outputPath('gift-new-capture-desktop.png'),
			fullPage: true
		});
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		const href = await page
			.getByRole('link', { name: 'View idea', exact: true })
			.getAttribute('href');
		const saved = await (await context.request.get(origin + '/api' + href)).json();
		expect(saved.title).toBe('Console for Luke');
		expect(saved.entries[0].estimatePence).toBe(3500);
		expect(saved.media).toHaveLength(1);
		const attachment = await context.request.get(origin + '/api/media/' + saved.media[0].id);
		const savedImage = await attachment.body();
		const published = await sharp(savedImage).metadata();
		expect(published.width).toBe(50);
		expect(published.height).toBe(100);
		const savedPixel = await sharp(savedImage)
			.extract({ left: 25, top: 50, width: 1, height: 1 })
			.removeAlpha()
			.raw()
			.toBuffer();
		expect(savedPixel[0]).toBeLessThan(30);
		expect(savedPixel[1]).toBeGreaterThan(220);
		expect(savedPixel[2]).toBeLessThan(30);
		expect(imageRequests).toBe(1);
		await page.screenshot({
			path: test.info().outputPath('gift-capture-cropped-mobile.png'),
			fullPage: true
		});
	} finally {
		await context.close();
	}
});
for (const kind of ['text', 'image'] as const) {
	test(`reconciles a lost ${kind} extraction response before a fresh explicit retry after provider failure`, async ({
		browser
	}) => {
		const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
		await signIn(context);
		const page = await context.newPage();
		const operations: string[] = [];
		await context.route('**/api/capture-details', async (route) => {
			if (route.request().method() === 'GET')
				return route.fulfill({ json: { configured: true, enabled: true } });
			const request = new Request(origin + '/api/capture-details', {
				method: 'POST',
				headers: route.request().headers(),
				body: new Uint8Array(route.request().postDataBuffer()!)
			});
			const form = await request.formData();
			expect(form.get('kind')).toBe(kind);
			const id = String(form.get('operationId'));
			operations.push(id);
			if (operations.length === 1) return route.abort('failed');
			if (id === operations[0])
				return route.fulfill({
					json: {
						suggestions: [],
						failure: 'provider',
						message: 'Provider failed. Your idea is kept.'
					}
				});
			return route.fulfill({
				json: {
					suggestions: [
						{
							title: 'Recovered train',
							description: null,
							variant: null,
							imageUrl: null,
							sourceUrl: '',
							retrievedAt: 123,
							source: 'gemini',
							offer: null,
							uncertainty: []
						}
					],
					message: 'Details found.'
				}
			});
		});
		try {
			await page.goto(origin + '/capture');
			if (kind === 'text') {
				const pasteText = page.getByRole('button', { name: 'Paste text', exact: true });
				await expect(pasteText).toHaveAttribute('aria-expanded', 'false');
				await pasteText.click();
				await expect(pasteText).toHaveAttribute('aria-expanded', 'true');
				await expect(
					page.getByText('Using Fill from text sends this text to Google.', { exact: true })
				).toBeVisible();
				await page.getByLabel('Text to read', { exact: true }).fill('A wooden train to remember.');
			} else {
				const buffer = await sharp({
					create: { width: 2, height: 2, channels: 3, background: '#acf' }
				})
					.png()
					.toBuffer();
				await page
					.getByLabel('Photos', { exact: false })
					.setInputFiles({ name: 'train.png', mimeType: 'image/png', buffer });
			}
			const fill = page.getByRole('button', { name: `Fill from ${kind}`, exact: true });
			await fill.click();
			await expect.poll(() => operations.length).toBe(1);
			await expect(fill).toBeEnabled();
			await fill.click();
			await expect(
				page.getByText('Provider failed. Your idea is kept.', { exact: true })
			).toBeVisible();
			expect(operations[1]).toBe(operations[0]);
			await fill.click();
			await expect.poll(() => operations.length).toBe(3);
			expect(operations[2]).not.toBe(operations[0]);
			await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Recovered train');
		} finally {
			await context.close();
		}
	});
}

test('offers the AI opt-out before lookup even while settings are still loading', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context);
	const page = await context.newPage();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const assists: boolean[] = [];
	await context.route('**/api/capture-details', async (route) => {
		await gate;
		await route.fulfill({ json: { configured: true, enabled: true } });
	});
	await context.route('**/api/metadata', async (route) => {
		assists.push(route.request().postDataJSON().assist);
		await route.fulfill({ json: { suggestions: [], message: 'No details found.' } });
	});
	try {
		await page.goto(origin + '/capture', { waitUntil: 'domcontentloaded' });
		const optOut = page.getByRole('checkbox', { name: 'Use AI for missing link details' });
		await expect(optOut).toBeVisible({ timeout: 1500 });
		await expect(
			page.getByText('Sends page content to Google when link details are missing.', { exact: true })
		).toBeVisible();
		const linkBox = await page.getByLabel('Product link', { exact: true }).boundingBox();
		const optOutBox = await optOut.boundingBox();
		const photosBox = await page.getByLabel('Photos', { exact: false }).boundingBox();
		expect(linkBox).not.toBeNull();
		expect(optOutBox).not.toBeNull();
		expect(photosBox).not.toBeNull();
		expect(optOutBox!.y).toBeGreaterThan(linkBox!.y);
		expect(optOutBox!.y).toBeLessThan(photosBox!.y);
		await expect(page.getByRole('button', { name: 'Fill from image', exact: true })).toHaveCount(0);
		await optOut.uncheck();
		await page.getByLabel('Product link', { exact: true }).fill('https://shop.example/opt-out');
		await expect.poll(() => assists).toEqual([false]);
	} finally {
		release();
		await context.close();
	}
});

test('prefills editable source details and privately imports the picture, then confirms selected saved fields only', async ({
	browser
}) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	await signIn(context);
	const page = await context.newPage();
	try {
		const picture = await sharp({
			create: { width: 3, height: 3, channels: 3, background: '#79a' }
		})
			.webp()
			.toBuffer();
		await context.route('**/api/metadata', (route) =>
			route.fulfill({
				json: {
					suggestions: [
						{
							title: 'Imported train',
							description: 'A wooden train',
							variant: 'Blue',
							imageUrl: 'https://shop.example/train.webp',
							sourceUrl: 'https://shop.example/train',
							retrievedAt: 123,
							source: 'json-ld',
							offer: {
								url: 'https://shop.example/buy',
								retailer: 'Toy shop',
								priceMinor: 1950,
								currency: 'GBP',
								priceText: '19.50',
								fromPrice: false
							},
							uncertainty: []
						}
					],
					message: 'Review the details.'
				}
			})
		);
		await context.route('**/api/metadata/image', (route) =>
			route.fulfill({ contentType: 'image/webp', body: picture })
		);
		await page.goto(origin + '/capture?list=visible');
		await expect(
			page.locator('form.editor').getByRole('button', { name: /^Save (idea|on this device)$/ })
		).toHaveCount(1);
		await expect(page.locator('form.editor .panel')).toHaveCount(0);
		await page.getByLabel('Product link', { exact: true }).fill('https://shop.example/train');
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Imported train');
		await expect(page.getByLabel('Estimated price (£)', { exact: true })).toHaveValue('19.50');
		await page.getByText('More details', { exact: true }).click();
		await expect(page.getByLabel('Price', { exact: true })).toHaveValue('19.50');
		await expect(page.getByText('retailer-image.webp', { exact: false })).toBeVisible();
		await page.getByLabel('Variant or size').fill('Blue deluxe');
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		await page.goto(origin + '/products/saved');
		await page.getByText('Source metadata · succeeded', { exact: false }).click();
		await page.getByLabel('Title', { exact: true }).check();
		await page.getByLabel('Add shopping link and exact published price, when known').check();
		await page.getByRole('button', { name: 'Confirm selected details', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Woodland game', exact: true })).toBeVisible();
		await expect(page.getByText('Original size', { exact: true })).toBeVisible();
		await expect(page.getByText('Birthday · £20.00', { exact: false })).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
			.toBe(true);
		await page.screenshot({
			path: test.info().outputPath('gift-identification-mobile.png'),
			fullPage: true
		});
		await page.goto(origin + '/settings/identification');
		await expect(
			page.getByRole('heading', { name: 'Product identification', exact: true })
		).toBeVisible();
		await expect(page.getByLabel('Enable AI help and paid image identification')).not.toBeChecked();
		await page.getByLabel('Monthly allowance (USD)').fill('2.50');
		await page.getByRole('button', { name: 'Save settings', exact: true }).click();
		await expect(page.getByText('Identification settings saved.', { exact: true })).toBeVisible();
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.screenshot({
			path: test.info().outputPath('gift-identification-settings-desktop.png'),
			fullPage: true
		});
	} finally {
		await context.close();
	}
});

test('saves one link-only idea when the retailer cannot fill in its details', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context);
	const page = await context.newPage();
	try {
		await context.route('**/api/metadata', (route) =>
			route.fulfill({
				json: {
					suggestions: [],
					message: 'This shop could not be reached. You can still save the link.'
				}
			})
		);
		await page.goto(origin + '/capture?list=visible');
		await expect(page.getByRole('checkbox', { name: /Birthday/ })).toBeChecked();
		await page.getByLabel('Product link', { exact: true }).fill('https://shop.example/only-link');
		await expect(
			page.getByText("We couldn't read this shop page.", { exact: false })
		).toBeVisible();
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		const href = await page
			.getByRole('link', { name: 'View idea', exact: true })
			.getAttribute('href');
		const saved = await (await context.request.get(origin + '/api' + href)).json();
		expect(saved).toMatchObject({
			title: 'Idea from shop.example',
			sourceUrl: 'https://shop.example/only-link'
		});
		expect(saved.entries).toHaveLength(1);
	} finally {
		await context.close();
	}
});

test('saves a photo-only idea with a placeholder name and keeps its picture', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context);
	const page = await context.newPage();
	try {
		await page.goto(origin + '/capture?list=visible');
		await expect(page.getByRole('checkbox', { name: /Birthday/ })).toBeChecked();
		const picture = await sharp({
			create: { width: 3, height: 3, channels: 3, background: '#79a' }
		})
			.png()
			.toBuffer();
		await page.getByLabel('Photos').setInputFiles({
			name: 'shop-photo.png',
			mimeType: 'image/png',
			buffer: picture
		});
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		await page.getByRole('link', { name: 'View idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Photo idea', exact: true })).toBeVisible();
		const photo = page.getByRole('img', { name: 'Photo idea', exact: true });
		await expect(photo).toBeVisible();
		const source = await photo.getAttribute('src');
		expect(source).toBeTruthy();
		expect((await context.request.get(origin + source)).status()).toBe(200);
	} finally {
		await context.close();
	}
});

test('restores a removed photo when the same file is chosen again', async ({ browser }) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context);
	const page = await context.newPage();
	try {
		const path = test.info().outputPath('same-photo.png');
		writeFileSync(
			path,
			await sharp({
				create: { width: 3, height: 3, channels: 3, background: '#79a' }
			})
				.png()
				.toBuffer()
		);
		await page.goto(origin + '/capture?list=visible');
		const input = page.getByLabel('Photos');
		const preview = page.getByRole('img', { name: 'same-photo.png', exact: true });
		await input.setInputFiles(path);
		await expect(preview).toBeVisible();
		await page.getByRole('button', { name: 'Remove same-photo.png', exact: true }).click();
		await expect(preview).toHaveCount(0);
		await input.setInputFiles(path);
		await expect(preview).toBeVisible();
	} finally {
		await context.close();
	}
});

test('fills only empty idea fields from a link and keeps the user’s title and GBP estimate', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context);
	const page = await context.newPage();
	try {
		await context.route('**/api/metadata', (route) =>
			route.fulfill({
				json: {
					suggestions: [
						{
							title: 'Retailer title',
							description: 'Retailer description',
							variant: null,
							imageUrl: null,
							sourceUrl: 'https://shop.example/details',
							retrievedAt: 123,
							source: 'json-ld',
							offer: {
								url: 'https://shop.example/details',
								retailer: 'Shop',
								priceMinor: 3892,
								currency: 'GBP',
								priceText: '38.92',
								fromPrice: false
							},
							uncertainty: []
						}
					],
					message: 'Review the details.'
				}
			})
		);
		await page.goto(origin + '/capture?list=visible');
		await expect(page.getByRole('checkbox', { name: /Birthday/ })).toBeChecked();
		await page.getByLabel('Title', { exact: true }).fill('My own gift title');
		await page.getByLabel('Estimated price (£)', { exact: true }).fill('25.00');
		await page.getByLabel('Product link', { exact: true }).fill('https://shop.example/details');
		await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
			'Retailer description'
		);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('My own gift title');
		await expect(page.getByLabel('Estimated price (£)', { exact: true })).toHaveValue('25.00');
	} finally {
		await context.close();
	}
});
