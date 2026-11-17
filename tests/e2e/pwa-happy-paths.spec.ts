import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { makeSignature } from 'better-auth/crypto';
import sharp from 'sharp';
import { fixture } from '../integration/identity-fixture';

const origin = 'http://localhost:4206';
const secret = 'test-only-pwa-happy-paths-secret-8d10a957';
let directory: string;
let server: ChildProcess;
let output = '';

test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-pwa-happy-'));
	const model = fixture();
	await model.connection.sqlite.backup(join(directory, 'gifts.sqlite'));
	model.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4206',
			ORIGIN: origin,
			BODY_SIZE_LIMIT: '64M',
			PROTOCOL_HEADER: 'x-forwarded-proto',
			DATABASE_PATH: join(directory, 'gifts.sqlite'),
			MEDIA_PATH: join(directory, 'media'),
			BETTER_AUTH_SECRET: secret,
			GOOGLE_CLIENT_ID: 'test-client',
			GOOGLE_CLIENT_SECRET: 'test-provider',
			ADMINISTRATOR_EMAIL: 'admin@example.test',
			GEMINI_API_KEY: 'test-gemini-key'
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
	throw new Error('PWA happy-path test server did not start: ' + output);
});

test.afterEach(async ({}, info) => {
	if (info.status !== info.expectedStatus) console.error(output);
});

test.afterAll(async () => {
	if (server && server.exitCode === null) {
		server.kill('SIGTERM');
		await new Promise<void>((resolve) => server.once('exit', () => resolve()));
	}
	rmSync(directory, { recursive: true, force: true });
});

async function signIn(context: BrowserContext, id = 'admin') {
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

async function activateInstalledApp(page: Page, path = '/capture') {
	await page.goto(origin + path);
	await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
	await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

async function submitShare(
	page: Page,
	values: Record<string, string>,
	photo?: { name: string; type: string; bytes: number[] }
) {
	await page.evaluate(
		({ values, photo }) => {
			const form = document.createElement('form');
			form.method = 'POST';
			form.action = '/share';
			form.enctype = 'multipart/form-data';
			for (const [name, value] of Object.entries(values)) {
				const input = document.createElement('input');
				input.type = 'hidden';
				input.name = name;
				input.value = value;
				form.append(input);
			}
			if (photo) {
				const input = document.createElement('input');
				input.type = 'file';
				input.name = 'photos';
				const transfer = new DataTransfer();
				transfer.items.add(
					new File([new Uint8Array(photo.bytes)], photo.name, { type: photo.type })
				);
				input.files = transfer.files;
				form.append(input);
			}
			document.body.append(form);
			form.submit();
		},
		{ values, photo }
	);
}

async function idbDrafts(page: Page) {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('family-gift-captures');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise<
				{
					id: string;
					ownerId: string | null;
					status: string;
					readyToSync?: boolean;
					draft: { title: string };
				}[]
			>((resolve, reject) => {
				const request = db.transaction('drafts').objectStore('drafts').getAll();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	});
}

function productCount(title: string) {
	const db = new Database(join(directory, 'gifts.sqlite'), { readonly: true });
	try {
		return (
			db.prepare('SELECT count(*) AS count FROM products WHERE title=?').get(title) as {
				count: number;
			}
		).count;
	} finally {
		db.close();
	}
}

test('completes Fill from image on an incoming image/jpg share while local, draft, and saved items exist and background sync runs', async ({
	browser
}) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	await signIn(context, 'admin');
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));

	try {
		await context.route('**/api/capture-details', async (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({ json: { configured: true, enabled: true } });
			}
			await new Promise((resolve) => setTimeout(resolve, 150));
			return route.fulfill({
				json: {
					suggestions: [
						{
							title: 'AI Wooden Camera',
							description: 'Beech wood toy camera with strap',
							variant: 'Natural wood',
							imageUrl: null,
							sourceUrl: '',
							retrievedAt: Date.now(),
							source: 'gemini',
							offer: {
								url: '',
								retailer: 'Folk Toy Co',
								priceMinor: 2495,
								currency: 'GBP',
								priceText: '£24.95',
								fromPrice: false
							},
							uncertainty: []
						}
					],
					message: 'Details found.'
				}
			});
		});

		// 1. Install SW and add an idea directly to the catalogue
		await activateInstalledApp(page);
		await page.getByLabel('Title', { exact: true }).fill('Catalogue Seed Toy');
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		expect(productCount('Catalogue Seed Toy')).toBe(1);

		// 2. Add a kept draft ("draft") and a queued offline item ("local")
		await page.getByRole('button', { name: 'Add another', exact: true }).click();
		await page.getByLabel('Title', { exact: true }).fill('Kept Draft Puzzle');
		await page.getByRole('button', { name: 'Keep for later', exact: true }).click();
		await expect(page.getByText('Kept on this device', { exact: false }).first()).toBeVisible();

		await context.setOffline(true);
		await page.getByLabel('Title', { exact: true }).fill('Offline Local Train');
		await page.getByRole('button', { name: 'Save on this device', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Waiting to send', exact: true })).toBeVisible();

		// 3. Reconnect with realistic/slow /api/me and /api/captures delays, then share an image/jpg
		await context.setOffline(false);
		let uploadsStarted = 0;
		await context.route('**/api/me', async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 250));
			await route.continue();
		});
		await context.route('**/api/captures', async (route) => {
			uploadsStarted++;
			await new Promise((resolve) => setTimeout(resolve, 450));
			await route.continue();
		});

		const jpg = await sharp({
			create: { width: 120, height: 90, channels: 3, background: '#4a7' }
		})
			.jpeg()
			.toBuffer();

		await submitShare(page, {}, { name: 'camera-share', type: 'image/jpg', bytes: [...jpg] });
		await expect(page).toHaveURL(/\/capture\?draft=/);

		// 4. Immediately click Fill from image while reconnect() and syncDrafts() race
		const fillButton = page.getByRole('button', { name: 'Fill from image', exact: true });
		await expect(fillButton).toBeEnabled();
		await fillButton.click();

		// Should complete cleanly without hanging or stranding "Reading the supplied image…"
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('AI Wooden Camera', {
			timeout: 5000
		});
		await expect(page.getByLabel('Description')).toHaveValue('Beech wood toy camera with strap');
		await expect(page.getByLabel('Estimated price (£)')).toHaveValue('24.95');
		await expect(page.getByText('Reading the supplied image…')).toHaveCount(0);
		await expect(page.getByText('Suggested details added.', { exact: false })).toBeVisible();

		// 5. Save the shared photo idea and verify queued local item synced while kept draft remained local
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		await expect.poll(() => productCount('Offline Local Train')).toBe(1);
		expect(uploadsStarted).toBeGreaterThanOrEqual(2);
		expect(productCount('AI Wooden Camera')).toBe(1);
		expect(productCount('Kept Draft Puzzle')).toBe(0);

		const drafts = await idbDrafts(page);
		const keptDraft = drafts.find((record) => record.draft.title === 'Kept Draft Puzzle');
		expect(keptDraft?.status).toBe('local');
		expect(keptDraft?.readyToSync).toBe(false);

		await page.getByRole('button', { name: 'Add another', exact: true }).click();
		await expect(page).toHaveURL(origin + '/capture');
		expect(errors).toEqual([]);
	} finally {
		await context.close();
	}
});

test('supports crop/rotate, text autofill, retailer lookup, undo autofill, and clears reading state on mid-flight source edits', async ({
	browser
}) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	await signIn(context, 'admin');
	const page = await context.newPage();

	try {
		await context.route('**/api/metadata', async (route) => {
			const payload = route.request().postDataJSON() as { url?: string };
			if (payload.url?.includes('slow-link')) {
				await new Promise((resolve) => setTimeout(resolve, 350));
			}
			return route.fulfill({
				json: {
					suggestions: [
						{
							title: 'Retailer Jigsaw',
							description: '100-piece woodland puzzle',
							variant: 'Boxed',
							imageUrl: null,
							sourceUrl: payload.url ?? 'https://shop.example/jigsaw',
							retrievedAt: Date.now(),
							source: 'metadata',
							offer: {
								url: payload.url ?? 'https://shop.example/jigsaw',
								retailer: 'ToyShop',
								priceMinor: 1499,
								currency: 'GBP',
								priceText: '£14.99',
								fromPrice: false
							},
							uncertainty: []
						}
					],
					message: 'Imported available details.'
				}
			});
		});

		await context.route('**/api/capture-details', async (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({ json: { configured: true, enabled: true } });
			}
			return route.fulfill({
				json: {
					suggestions: [
						{
							title: 'Cropped Plush Fox',
							description: 'Soft stitched fox plush',
							variant: 'Small',
							imageUrl: null,
							sourceUrl: '',
							retrievedAt: Date.now(),
							source: 'gemini',
							offer: null,
							uncertainty: []
						}
					],
					message: 'Details found.'
				}
			});
		});

		await activateInstalledApp(page);

		// URL lookup + Undo autofill
		await page.getByLabel('Product link').fill('https://shop.example/jigsaw');
		await page.getByRole('button', { name: 'Look up retailer details', exact: true }).click();
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Retailer Jigsaw');
		await expect(page.getByRole('button', { name: 'Undo autofill', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Undo autofill', exact: true }).click();
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');

		// Editing link mid-lookup clears "Reading product details…" cleanly
		await page.getByLabel('Product link').fill('https://shop.example/slow-link');
		await page.getByRole('button', { name: 'Look up retailer details', exact: true }).click();
		await expect(page.getByText('Reading product details…')).toBeVisible();
		await page.getByLabel('Product link').fill('https://shop.example/changed');
		await expect(page.getByText('Reading product details…')).toHaveCount(0);

		// Text autofill
		await page.getByRole('button', { name: 'Paste text', exact: true }).click();
		await page.getByLabel('Text to read').fill('Fox plush gift idea');
		await page.getByRole('button', { name: 'Fill from text', exact: true }).click();
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Cropped Plush Fox');
		await page.getByRole('button', { name: 'Undo autofill', exact: true }).click();

		// Crop & rotate photo, then Fill from image and Save idea
		const png = await sharp({
			create: { width: 100, height: 80, channels: 3, background: '#c64' }
		})
			.png()
			.toBuffer();
		await page
			.getByLabel('Photos')
			.setInputFiles({ name: 'fox.png', mimeType: 'image/png', buffer: png });
		await page.getByRole('button', { name: 'Crop or rotate', exact: true }).click();
		await page.getByRole('button', { name: 'Rotate right', exact: true }).click();
		await page.getByLabel('Crop width (%)').fill('60');
		await page.getByRole('button', { name: 'Use cropped image', exact: true }).click();
		await expect(
			page.getByRole('button', { name: 'Restore original image', exact: true })
		).toBeVisible();

		await page.getByRole('button', { name: 'Fill from image', exact: true }).click();
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Cropped Plush Fox');
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		expect(productCount('Cropped Plush Fox')).toBe(1);
	} finally {
		await context.close();
	}
});

test('exercises main installed-PWA happy paths across lists, capture, product edit, catalogue bulk actions, buying, settings, offline fallback, and sign-out safety', async ({
	browser
}) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	await signIn(context, 'admin');
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));

	try {
		// Verify PWA manifest and icons
		const manifestResponse = await context.request.get(origin + '/manifest.webmanifest');
		expect(manifestResponse.status()).toBe(200);
		const manifest = await manifestResponse.json();
		expect(manifest.start_url).toBe('/capture');
		expect(manifest.display).toBe('standalone');
		expect(manifest.share_target?.action).toBe('/share');
		for (const icon of manifest.icons) {
			const iconResponse = await context.request.get(origin + icon.src);
			expect(iconResponse.status()).toBe(200);
		}

		// Launch at PWA start_url (/capture)
		await activateInstalledApp(page);

		// Create recipient and list on /lists
		await page.goto(origin + '/lists');
		await page.getByText('Create a list', { exact: true }).click();
		await page.getByLabel('Or add a recipient').fill('Sam');
		await page.getByLabel('List name').fill('Winter');
		await page.getByLabel('Occasion').fill('Winter 2026');
		await page.getByRole('button', { name: 'Create list', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Sam', exact: true })).toBeVisible();

		// Hide & show list lifecycle
		await page.getByRole('button', { name: 'Hide Winter for Sam', exact: true }).click();
		await expect(
			page.getByRole('status').filter({ hasText: 'Winter for Sam hidden.' })
		).toBeVisible();
		await page.getByLabel('Show hidden lists').check();
		await page.getByRole('button', { name: 'Show Winter for Sam', exact: true }).click();
		await expect(
			page.getByRole('status').filter({ hasText: 'Winter for Sam shown again.' })
		).toBeVisible();

		// Capture unlisted idea -> Inbox -> Product detail -> Edit product
		await page.goto(origin + '/capture');
		await page.getByLabel('Title', { exact: true }).fill('Happy Path Kite');
		await page.getByLabel('Estimated price (£)').fill('18.50');
		const png = await sharp({
			create: { width: 40, height: 40, channels: 3, background: '#37a' }
		})
			.png()
			.toBuffer();
		await page
			.getByLabel('Photos')
			.setInputFiles({ name: 'kite.png', mimeType: 'image/png', buffer: png });
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();

		await page.goto(origin + '/inbox');
		await expect(page.getByRole('link', { name: 'Happy Path Kite', exact: true })).toBeVisible();
		await page.getByRole('link', { name: 'Happy Path Kite', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Happy Path Kite', exact: true })).toBeVisible();

		await page.getByRole('button', { name: 'Edit idea', exact: true }).click();
		await page.getByLabel('Title', { exact: true }).fill('Happy Path Stunt Kite');
		await page.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(page.getByRole('status')).toHaveText('Changes saved.');
		await expect(
			page.getByRole('heading', { name: 'Happy Path Stunt Kite', exact: true })
		).toBeVisible();

		// Catalogue: compact toggle, bulk add to Sam · Winter, then undo and re-add
		await page.goto(origin + '/catalogue');
		await page.getByRole('button', { name: 'Compact list', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Compact list', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await page.getByRole('button', { name: 'Cards', exact: true }).click();

		await page.getByLabel('Select Happy Path Stunt Kite').check();
		await page.getByRole('button', { name: 'Add selected to lists', exact: true }).click();
		const picker = page.getByRole('dialog');
		await expect(picker).toBeVisible();
		await picker.getByText('Sam · Winter').click();
		await picker.getByRole('button', { name: 'Add to 1 list', exact: true }).click();
		await expect(page.getByRole('status').filter({ hasText: 'Added 1 idea' })).toBeVisible();

		await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
		await expect(page.getByRole('status').filter({ hasText: 'Last action undone' })).toBeVisible();

		await page.getByLabel('Select Happy Path Stunt Kite').check();
		await page.getByRole('button', { name: 'Add selected to lists', exact: true }).click();
		await picker.getByText('Sam · Winter').click();
		await picker.getByRole('button', { name: 'Add to 1 list', exact: true }).click();
		await expect(page.getByRole('status').filter({ hasText: 'Added 1 idea' })).toBeVisible();

		// Buying flow: Lists -> Sam · Winter -> Reserve for me -> My gifts -> Mark purchased
		await page.goto(origin + '/lists');
		await page.getByRole('link', { name: /Sam.*Winter/i }).click();
		await expect(page.getByRole('heading', { name: 'Sam', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Reserve for me', exact: true }).click();
		await expect(page.getByText('Reserved · admin', { exact: true })).toBeVisible();

		await page.goto(origin + '/my-gifts');
		await expect(
			page.getByRole('link', { name: 'Happy Path Stunt Kite', exact: true })
		).toBeVisible();
		await page.getByLabel('Actual GBP spend (optional)').fill('16.00');
		await page.getByRole('button', { name: 'Mark purchased', exact: true }).click();
		await expect(page.getByText('Purchased · admin', { exact: true })).toBeVisible();
		await expect(page.getByText('£16.00 · actual spend')).toBeVisible();

		// Settings: people invitation, identification settings, diagnostics
		await page.goto(origin + '/settings/people');
		await page.getByLabel('Google email').fill('relative@example.test');
		await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
		await expect(page.getByLabel('Invitation link')).toHaveValue(/\/invite\//);

		await page.goto(origin + '/settings/identification');
		await page.getByLabel('Enable AI help and paid image identification').check();
		await page.getByRole('button', { name: 'Save settings', exact: true }).click();
		await expect(page.getByText('Identification settings saved.')).toBeVisible();

		await page.goto(origin + '/settings/diagnostics');
		await expect(
			page.getByRole('heading', { name: 'Application readiness', exact: true })
		).toBeVisible();

		// Offline SW navigation redirects /lists -> /capture, and coming back online restores nav links
		await context.setOffline(true);
		await page.goto(origin + '/lists');
		await expect(page).toHaveURL(origin + '/capture');
		await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
		await context.setOffline(false);
		await expect(page.getByRole('link', { name: 'Lists', exact: true })).toBeVisible();

		// Draft keep + Sign out confirmation dialog + mobile layout overflow check
		await page.getByLabel('Title', { exact: true }).fill('Pending Sign Out Draft');
		await page.getByRole('button', { name: 'Keep for later', exact: true }).click();
		await expect(page.getByText('Kept on this device', { exact: false }).first()).toBeVisible();
		await page.getByRole('button', { name: 'Sign out', exact: true }).click();
		const signOutDialog = page.getByRole('dialog', { name: 'Keep your pending ideas safe' });
		await expect(signOutDialog).toBeVisible();
		await signOutDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(signOutDialog).toBeHidden();

		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true
		);
		expect(errors).toEqual([]);
	} finally {
		await context.close();
	}
});
