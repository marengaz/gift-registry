import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import sharp from 'sharp';
import { fixture } from '../integration/identity-fixture';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';

const origin = 'http://localhost:4187';
const secret = 'test-only-random-secret-8d10a957acf165810d9a';
let server: ChildProcess;
let directory: string;
let serverOutput = '';
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-browser-'));
	const context = fixture();
	acceptInvitation(
		context.connection,
		context.actor('guest'),
		createInvitation(context.connection, context.admin, {
			email: 'guest@example.test',
			grants: [{ listId: 'visible', role: 'contributor' }]
		}).token
	);
	await context.connection.sqlite.backup(join(directory, 'test.sqlite'));
	context.connection.close();
	server = spawn(process.execPath, ['scripts/start.mjs'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4187',
			PROTOCOL_HEADER: 'x-forwarded-proto',
			ORIGIN: origin,
			DATABASE_PATH: join(directory, 'test.sqlite'),
			MEDIA_PATH: join(directory, 'media'),
			BETTER_AUTH_SECRET: secret,
			GOOGLE_CLIENT_ID: 'test-google-client',
			GOOGLE_CLIENT_SECRET: 'test-provider-secret',
			ADMINISTRATOR_EMAIL: 'admin@example.test'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.stdout?.on('data', (chunk) => (serverOutput += chunk));
	server.stderr?.on('data', (chunk) => (serverOutput += chunk));
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(origin + '/login')).ok) {
				ready = true;
				break;
			}
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	if (!ready) throw new Error('Test server did not start: ' + serverOutput);
});
test.afterEach(async ({}, info) => {
	if (info.status !== info.expectedStatus) console.error(serverOutput);
});
test.afterAll(async () => {
	if (server && server.exitCode === null) {
		server.kill('SIGTERM');
		await new Promise<void>((resolve) => server.once('exit', () => resolve()));
	}
	rmSync(directory, { recursive: true, force: true });
});
async function signIn(context: BrowserContext, id: string) {
	const token = `token-${id}`;
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

test('administrator organises, captures with photo, edits and searches at desktop and phone widths', async ({
	page,
	context
}) => {
	await context.setExtraHTTPHeaders({ 'x-forwarded-proto': 'http' });
	await signIn(context, 'admin');
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(origin + '/lists');
	await expect(page.getByRole('heading', { name: 'Gift lists', exact: true })).toBeVisible();
	await page.getByText('Create a list', { exact: true }).click();
	await page.getByLabel('Or add a recipient').fill('Test niece');
	await page.getByLabel('List name', { exact: true }).fill('Birthday ideas');
	await page.getByLabel('Occasion').fill('Birthday 2027');
	await page.getByRole('button', { name: 'Create list', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Test niece', exact: true })).toBeVisible();
	await page.getByRole('link', { name: /Birthday 2027 Test niece/ }).click();
	await page.getByRole('link', { name: '+ Add an idea' }).click();
	await expect(
		page.getByRole('checkbox', { name: 'Test niece · Birthday ideas Birthday 2027', exact: true })
	).toBeChecked();
	await expect(page.getByRole('button', { name: 'Save idea', exact: true })).toBeEnabled();
	await page.getByLabel('Title', { exact: true }).fill('Woodland puzzle');
	await page.getByLabel('Estimated price (£)', { exact: true }).fill('18.50');
	await page.getByText('More details', { exact: true }).click();
	await page.getByLabel('Labels').fill('age 5, puzzles');
	await page.getByLabel('Original text or notes').fill('Spotted in a shop window');
	await page.getByRole('button', { name: 'Add shopping link' }).click();
	await page.getByLabel('Retailer', { exact: true }).fill('Test shop');
	await page.getByLabel('Link', { exact: true }).fill('https://example.test/puzzle');
	await page.getByLabel('Currency', { exact: true }).fill('JPY');
	await page.getByLabel('Price', { exact: true }).fill('1500');
	const png = await sharp({
		create: { width: 800, height: 600, channels: 3, background: '#9fb49a' }
	})
		.png({ compressionLevel: 0 })
		.toBuffer();
	expect(png.length).toBeGreaterThan(512 * 1024);
	await page
		.getByLabel('Photos')
		.setInputFiles({ name: 'test-image.png', mimeType: 'image/png', buffer: png });
	await page.getByRole('button', { name: 'Save idea', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
	await page.getByRole('link', { name: 'View idea', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Woodland puzzle', exact: true })).toBeVisible();
	await expect(page.getByText('£18.50')).toBeVisible();
	await expect(page.getByRole('img', { name: 'Woodland puzzle' })).toBeVisible();
	await page.getByRole('button', { name: 'Edit idea', exact: true }).click();
	await page.getByText('More details', { exact: true }).click();
	await expect(page.getByLabel('Currency', { exact: true })).toHaveValue('JPY');
	await page.getByLabel('Variant or size').fill('100 pieces');
	await page.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect(page.getByText('100 pieces', { exact: true })).toBeVisible();
	await page.goto(origin + '/catalogue');
	await page.getByLabel('Search', { exact: true }).fill('puzzles');
	await page.getByRole('button', { name: 'Find ideas' }).click();
	await expect(page.getByRole('heading', { name: 'Woodland puzzle', exact: true })).toBeVisible();
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.screenshot({
		path: test.info().outputPath('gift-catalogue-desktop.png'),
		fullPage: true
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect
		.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
		.toBe(true);
	await page.screenshot({
		path: test.info().outputPath('gift-catalogue-mobile.png'),
		fullPage: true
	});
	await page.getByRole('button', { name: 'Compact list', exact: true }).click();
	const thumbnail = page.getByRole('img', { name: 'Woodland puzzle', exact: true });
	await expect(thumbnail).toBeVisible();
	expect((await thumbnail.boundingBox())!.width).toBeLessThanOrEqual(80);
	await page.screenshot({
		path: test.info().outputPath('gift-compact-mobile.png'),
		fullPage: true
	});
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.screenshot({
		path: test.info().outputPath('gift-compact-desktop.png'),
		fullPage: true
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(origin + '/capture');
	await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
		.toBe(true);
	await page.screenshot({
		path: test.info().outputPath('gift-capture-mobile.png'),
		fullPage: true
	});
	await page.keyboard.press('Tab');
	await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.locator('#main-content')).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(page.getByLabel('Product link', { exact: true })).toBeFocused();
	expect(errors).toEqual([]);
});

test('contributor keeps an invalid-photo draft and sees only permitted lists with a private-free public shell', async ({
	browser
}) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	await signIn(context, 'guest');
	const page = await context.newPage();
	try {
		const shell = await context.request.get(origin + '/capture');
		const html = await shell.text();
		expect(html).not.toContain('guest@example.test');
		expect(html).not.toContain('Test niece');
		expect(html).not.toContain('Woodland puzzle');
		await page.goto(origin + '/capture');
		await expect(page.getByRole('checkbox', { name: /Child · Birthday/ })).toBeVisible();
		await expect(page.getByRole('checkbox', { name: /Christmas/ })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Save idea', exact: true })).toBeEnabled();
		await page.getByLabel('Title', { exact: true }).fill('Keep this draft');
		await page
			.getByLabel('Photos')
			.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('<svg/>') });
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('alert')).toContainText('could not be opened safely');
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep this draft');
		await page.getByRole('button', { name: 'Remove broken.png', exact: true }).click();
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		await page.goto(origin + '/inbox');
		await expect(page.getByRole('heading', { name: 'Keep this draft', exact: true })).toBeVisible();
		const denied = await context.request.get(origin + '/api/products');
		expect(denied.status()).toBe(403);
		await expect(page.getByRole('link', { name: 'Catalogue', exact: true })).toHaveCount(0);
	} finally {
		await context.close();
	}
});
