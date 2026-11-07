import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../integration/identity-fixture';

const origin = 'http://localhost:4195';
let directory: string;
let server: ChildProcess;
let output = '';
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-photo-race-'));
	const model = fixture();
	await model.connection.sqlite.backup(join(directory, 'gifts.sqlite'));
	model.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4195',
			ORIGIN: origin,
			PROTOCOL_HEADER: 'x-forwarded-proto',
			BODY_SIZE_LIMIT: '64M',
			DATABASE_PATH: join(directory, 'gifts.sqlite'),
			MEDIA_PATH: join(directory, 'media'),
			BETTER_AUTH_SECRET: 'test-only-photo-race-secret-8d10a957acf16',
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
	throw new Error('Photo race server did not start: ' + output);
});
test.afterAll(async () => {
	if (server && server.exitCode === null) {
		server.kill('SIGTERM');
		await new Promise<void>((resolve) => server.once('exit', () => resolve()));
	}
	rmSync(directory, { recursive: true, force: true });
});

async function delayImageBody(page: Page, browserCapture = false) {
	await page.addInitScript(() => {
		const original = window.fetch.bind(window);
		const state = window as Window & {
			imageBodyReading?: boolean;
			releaseImageBody?: () => void;
		};
		window.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input), location.href);
			if (url.pathname !== '/api/metadata/image') return original(input, init);
			const response = new Response(
				new ReadableStream({
					start(controller) {
						state.releaseImageBody = () => {
							controller.enqueue(new Uint8Array([1, 2, 3]));
							controller.close();
						};
					}
				}),
				{ headers: { 'content-type': 'image/webp' } }
			);
			const readBody = response.blob.bind(response);
			response.blob = () => {
				state.imageBodyReading = true;
				return readBody();
			};
			return response;
		};
	});
	await page.route('**/api/metadata', (route) =>
		route.fulfill({
			json: {
				suggestions: [
					{
						title: 'Retailer train',
						description: '',
						variant: '',
						imageUrl: 'https://shop.example/train.webp',
						sourceUrl: 'https://shop.example/train',
						retrievedAt: 123,
						offer: null,
						uncertainty: []
					}
				],
				message: 'Check the details.'
			}
		})
	);
	if (browserCapture) {
		const capture = {
			version: 1,
			sourceUrl: 'https://www.smythstoys.com/uk/en-gb/toy/p/266502',
			title: 'Browser train',
			imageUrl: 'https://shop.example/train.webp',
			currency: 'GBP',
			priceText: '20.00',
			fromPrice: false
		};
		await page.goto(origin + '/capture#gift=' + encodeURIComponent(JSON.stringify(capture)));
	} else {
		await page.goto(origin + '/capture');
		await page.getByLabel('Product link', { exact: true }).fill('https://shop.example/train');
	}
	await expect
		.poll(() =>
			page.evaluate(() => (window as Window & { imageBodyReading?: boolean }).imageBodyReading)
		)
		.toBe(true);
}
async function finishImageBody(page: Page) {
	await page.evaluate(() =>
		(window as Window & { releaseImageBody?: () => void }).releaseImageBody?.()
	);
	await expect(
		page.getByRole('button', { name: 'Look up retailer details', exact: true })
	).toBeEnabled();
}

test('keeps a manually selected photo while the imported image body is delayed', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	const page = await context.newPage();
	try {
		await delayImageBody(page);
		await page.getByLabel('Photos').setInputFiles({
			name: 'chosen-in-store.png',
			mimeType: 'image/png',
			buffer: Buffer.from([4, 5, 6])
		});
		await expect(page.getByText('chosen-in-store.png', { exact: false })).toBeVisible();
		await finishImageBody(page);
		await expect(page.getByText('chosen-in-store.png', { exact: false })).toBeVisible();
		await expect(page.getByText('retailer-image.webp', { exact: false })).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test('does not attach an earlier lookup image to a replacement draft with the same URL', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	const page = await context.newPage();
	try {
		await delayImageBody(page);
		await page.getByRole('button', { name: 'Save on this device', exact: true }).click();
		await page.getByRole('button', { name: 'Add another idea', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Saved on this device', exact: true })
		).toHaveCount(0);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
		await page.getByLabel('Title', { exact: true }).fill('Another idea');
		await page.getByLabel('Product link', { exact: true }).fill('https://shop.example/train');
		await finishImageBody(page);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Another idea');
		await expect(page.getByText('retailer-image.webp', { exact: false })).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test('keeps a manual photo when a captured browser image body arrives later', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	const page = await context.newPage();
	try {
		await delayImageBody(page, true);
		await page.getByLabel('Photos').setInputFiles({
			name: 'chosen-browser-photo.png',
			mimeType: 'image/png',
			buffer: Buffer.from([4, 5, 6])
		});
		await finishImageBody(page);
		await expect(page.getByText('Copying shop photo…', { exact: true })).toHaveCount(0);
		await expect(page.getByText('chosen-browser-photo.png', { exact: false })).toBeVisible();
		await expect(page.getByText('browser-image.webp', { exact: false })).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test('does not attach a browser photo to a replacement draft with the same source link', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	const page = await context.newPage();
	try {
		await delayImageBody(page, true);
		await page.getByRole('button', { name: 'Save on this device', exact: true }).click();
		await page.getByRole('button', { name: 'Add another idea', exact: true }).click();
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
		await page.getByLabel('Title', { exact: true }).fill('Replacement browser idea');
		await page
			.getByLabel('Product link', { exact: true })
			.fill('https://www.smythstoys.com/uk/en-gb/toy/p/266502');
		await finishImageBody(page);
		await expect(page.getByText('Copying shop photo…', { exact: true })).toHaveCount(0);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Replacement browser idea');
		await expect(page.getByText('browser-image.webp', { exact: false })).toHaveCount(0);
	} finally {
		await context.close();
	}
});
