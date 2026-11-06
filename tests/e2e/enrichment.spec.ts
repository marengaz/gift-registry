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
		await page.screenshot({ path: '/private/tmp/gift-identification-mobile.png', fullPage: true });
		await page.goto(origin + '/settings/identification');
		await expect(
			page.getByRole('heading', { name: 'Product identification', exact: true })
		).toBeVisible();
		await expect(page.getByLabel('Enable paid image identification')).not.toBeChecked();
		await page.getByLabel('Monthly allowance (USD)').fill('2.50');
		await page.getByRole('button', { name: 'Save settings', exact: true }).click();
		await expect(page.getByText('Identification settings saved.', { exact: true })).toBeVisible();
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.screenshot({
			path: '/private/tmp/gift-identification-settings-desktop.png',
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
		await expect(page.getByText('This shop could not be reached.', { exact: false })).toBeVisible();
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
		await expect(page.getByRole('heading', { name: 'Untitled idea', exact: true })).toBeVisible();
		const photo = page.getByRole('img', { name: 'Untitled idea', exact: true });
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
