import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import sharp from 'sharp';
import { fixture } from '../integration/identity-fixture';

const origin = 'http://localhost:4211';
const secret = 'test-only-random-secret-wishlist-import-123456';
let server: ChildProcess;
let directory: string;
let serverOutput = '';

test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-wishlist-e2e-'));
	const context = fixture();
	context.connection.sqlite.exec(
		"INSERT INTO products(id,title,source_url,contributor_id) VALUES('existing-cat','Already In Catalogue Toy','https://www.amazon.com/dp/B0EXISTING','admin');"
	);
	await context.connection.sqlite.backup(join(directory, 'test.sqlite'));
	context.connection.close();

	server = spawn(process.execPath, ['scripts/start.mjs'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4211',
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

test('imports an Amazon wishlist into local drafts, skips duplicates, prunes unwanted items in compact view, and adds kept ideas to the catalogue', async ({
	page,
	context
}) => {
	await context.setExtraHTTPHeaders({ 'x-forwarded-proto': 'http' });
	await signIn(context, 'admin');
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));

	const thumbWebp = await sharp({
		create: { width: 120, height: 120, channels: 3, background: '#6a8d73' }
	})
		.webp()
		.toBuffer();

	// 1. Pre-create a local draft via /capture ("Keep for later") to verify existing local drafts appear on the pruning page and deduplicate against imports
	await page.goto(origin + '/capture');
	await page.getByLabel('Title', { exact: true }).fill('Existing Local Draft Scooter');
	await page
		.getByLabel('Product link', { exact: true })
		.fill('https://www.amazon.com/dp/B0LOCALDUP');
	await page.getByRole('button', { name: 'Keep for later', exact: true }).click();
	await expect(page.getByText('Kept on this device. Choose the idea below')).toBeVisible();

	// Mock /api/wishlist and /api/metadata/image for deterministic E2E testing of the wishlist flow
	await page.route('**/api/wishlist', async (route) => {
		const body = route.request().postDataJSON();
		expect(body.url).toBe('https://a.co/d/02BqURT1');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				listTitle: '3 & 4 Year Old Gift Guide',
				sourceUrl: 'https://www.amazon.com/shop/bymelissakate/list/2TEA5Q35ZSF47',
				totalFound: 5,
				skippedDuplicates: 1, // 1 already in server catalogue (B0EXISTING)
				items: [
					{
						asin: 'B0LOCALDUP',
						title: 'Duplicate of Existing Local Draft Scooter',
						brand: 'Micro',
						sourceUrl: 'https://www.amazon.com/dp/B0LOCALDUP',
						imageUrl: 'https://m.media-amazon.com/images/I/localdup.jpg',
						price: '49.99',
						priceMinor: 4999,
						currency: 'GBP',
						priceText: '£49.99',
						retailer: 'Amazon'
					},
					{
						asin: 'B0DLY8GFR8',
						title: 'Little Tikes Creative Construction Power Cuts Set',
						brand: 'Little Tikes',
						sourceUrl: 'https://www.amazon.com/dp/B0DLY8GFR8',
						imageUrl: 'https://m.media-amazon.com/images/I/littletikes.jpg',
						price: '24.87',
						priceMinor: 2487,
						currency: 'GBP',
						priceText: '£24.87',
						retailer: 'Amazon'
					},
					{
						asin: 'B07P8WBK9F',
						title: "Learning Resources Rock 'n Gem Surprise",
						brand: 'Learning Resources',
						sourceUrl: 'https://www.amazon.com/dp/B07P8WBK9F',
						imageUrl: 'https://m.media-amazon.com/images/I/rockgem.jpg',
						price: '19.99',
						priceMinor: 1999,
						currency: 'GBP',
						priceText: '£19.99',
						retailer: 'Amazon'
					},
					{
						asin: 'B08HCXS4XJ',
						title: 'Unwanted Inflatable Punching Bag',
						brand: 'JOYIN',
						sourceUrl: 'https://www.amazon.com/dp/B08HCXS4XJ',
						imageUrl: 'https://m.media-amazon.com/images/I/punchbag.jpg',
						price: '15.00',
						priceMinor: 1500,
						currency: 'GBP',
						priceText: '£15.00',
						retailer: 'Amazon'
					}
				]
			})
		});
	});

	await page.route('**/api/metadata/image', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'image/webp',
			body: thumbWebp
		});
	});

	// 2. Visit /catalogue and verify the split "+ Add an idea" button and dropdown
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(origin + '/catalogue');
	const primaryAddLink = page.getByRole('link', { name: '+ Add an idea', exact: true });
	await expect(primaryAddLink).toBeVisible();
	await expect(primaryAddLink).toHaveAttribute('href', '/capture');

	await page.getByLabel('More ways to add ideas').click();
	await expect(page.getByRole('menuitem', { name: 'Add a single idea' })).toBeVisible();
	const importMenuButton = page.getByRole('menuitem', { name: 'Import Amazon wishlist…' });
	await expect(importMenuButton).toBeVisible();
	await page.screenshot({
		path: test.info().outputPath('wishlist-1-catalogue-dropdown.png'),
		fullPage: false
	});
	await importMenuButton.click();

	// 3. Fill in the example Amazon wishlist URL in the dialog and import
	const dialog = page.getByRole('dialog', { name: 'Import Amazon wishlist' });
	await expect(dialog).toBeVisible();
	await dialog.getByLabel('Amazon wishlist or idea list link').fill('https://a.co/d/02BqURT1');
	await page.screenshot({
		path: test.info().outputPath('wishlist-2-import-dialog.png'),
		fullPage: false
	});
	await dialog.getByRole('button', { name: 'Import wishlist' }).click();

	// 4. Verify navigation to /capture/drafts compact list view
	await expect(page).toHaveURL(/\/capture\/drafts\?/);
	await expect(
		page.getByRole('heading', { name: 'Review & prune draft ideas', exact: true })
	).toBeVisible();

	// 3 new items imported (B0DLY8GFR8, B07P8WBK9F, B08HCXS4XJ), 2 duplicates skipped (1 server B0EXISTING + 1 local B0LOCALDUP)
	await expect(page.locator('.import-summary')).toContainText('Imported 3 new draft ideas');
	await expect(page.locator('.import-summary')).toContainText('3 & 4 Year Old Gift Guide');
	await expect(page.locator('.import-summary')).toContainText('Skipped 2 duplicate items');

	// Existing local draft + 3 newly imported drafts = 4 total local drafts shown in compact view
	await expect(page.getByText('Showing 4 of 4 local drafts · Compact list view')).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Existing Local Draft Scooter', exact: true })
	).toBeVisible();
	await expect(
		page.getByRole('heading', {
			name: 'Little Tikes Creative Construction Power Cuts Set',
			exact: true
		})
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: "Learning Resources Rock 'n Gem Surprise", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Unwanted Inflatable Punching Bag', exact: true })
	).toBeVisible();
	await page.screenshot({
		path: test.info().outputPath('wishlist-3-compact-pruning-view.png'),
		fullPage: true
	});

	// 5. Prune unwanted item via per-row "Prune" button
	await page
		.getByRole('button', { name: 'Prune Unwanted Inflatable Punching Bag', exact: true })
		.click();
	await expect(
		page.getByRole('heading', { name: 'Unwanted Inflatable Punching Bag', exact: true })
	).toHaveCount(0);
	await expect(page.getByText('Showing 3 of 3 local drafts · Compact list view')).toBeVisible();

	// 6. Prune another item via checkbox selection + "Prune selected (1)"
	await page
		.getByRole('checkbox', { name: 'Select Existing Local Draft Scooter', exact: true })
		.check();
	await page.getByRole('button', { name: 'Prune selected (1)', exact: true }).click();
	await expect(
		page.getByRole('heading', { name: 'Existing Local Draft Scooter', exact: true })
	).toHaveCount(0);
	await expect(page.getByText('Showing 2 of 2 local drafts · Compact list view')).toBeVisible();
	await page.screenshot({
		path: test.info().outputPath('wishlist-4-after-pruning.png'),
		fullPage: true
	});

	// 7. Commit remaining 2 kept drafts to the catalogue
	await page
		.getByRole('button', { name: 'Add all 2 kept ideas to catalogue', exact: true })
		.click();

	// 8. Verify redirect to /catalogue in Compact list view with the 2 new ideas present
	await expect(page).toHaveURL(origin + '/catalogue');
	await expect(page.getByRole('button', { name: 'Compact list', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(
		page.getByRole('heading', {
			name: 'Little Tikes Creative Construction Power Cuts Set',
			exact: true
		})
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: "Learning Resources Rock 'n Gem Surprise", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Unwanted Inflatable Punching Bag', exact: true })
	).toHaveCount(0);
	await page.screenshot({
		path: test.info().outputPath('wishlist-5-catalogue-compact.png'),
		fullPage: true
	});

	expect(errors).toEqual([]);
});
