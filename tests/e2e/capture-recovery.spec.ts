import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { makeSignature } from 'better-auth/crypto';
import sharp from 'sharp';
import { fixture } from '../integration/identity-fixture';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';
const origin = 'http://localhost:4197';
const secret = 'test-only-offline-secret-8d10a957acf165810';
let directory: string;
let server: ChildProcess;
let output = '';
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-capture-recovery-'));
	const model = fixture();
	for (const id of ['guest', 'other'])
		acceptInvitation(
			model.connection,
			model.actor(id),
			createInvitation(model.connection, model.admin, {
				email: `${id}@example.test`,
				grants: [{ listId: 'visible', role: 'contributor' }]
			}).token
		);
	await model.connection.sqlite.backup(join(directory, 'gifts.sqlite'));
	model.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4197',
			ORIGIN: origin,
			BODY_SIZE_LIMIT: '64M',
			PROTOCOL_HEADER: 'x-forwarded-proto',
			DATABASE_PATH: join(directory, 'gifts.sqlite'),
			MEDIA_PATH: join(directory, 'media'),
			BETTER_AUTH_SECRET: secret,
			GOOGLE_CLIENT_ID: 'test-client',
			GOOGLE_CLIENT_SECRET: 'test-provider',
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
	throw new Error('Offline test server did not start: ' + output);
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
async function readyToCapture(page: Page) {
	await expect(page.getByRole('checkbox', { name: /Child.*Birthday/ })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save idea', exact: true })).toBeEnabled();
}
async function localRecords(page: Page) {
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
					operationId: string;
					status: string;
					draft: { title: string; listIds: string[] };
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
function savedCounts(title: string) {
	const db = new Database(join(directory, 'gifts.sqlite'), { readonly: true });
	try {
		return db
			.prepare(
				'SELECT (SELECT count(*) FROM products WHERE title=?) AS products,(SELECT count(*) FROM media m JOIN products p ON p.id=m.product_id WHERE p.title=?) AS media,(SELECT count(*) FROM entries e JOIN products p ON p.id=e.product_id WHERE p.title=?) AS entries'
			)
			.get(title, title, title);
	} finally {
		db.close();
	}
}
test('keeps an unfinished unlisted title and photo with their original account after a second tab switches account', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'guest');
	const capturing = await context.newPage();
	const switching = await context.newPage();
	try {
		await capturing.goto(origin + '/capture');
		await readyToCapture(capturing);
		await capturing.getByLabel('Title', { exact: true }).fill('Private unfinished dinosaur');
		const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#789' } })
			.png()
			.toBuffer();
		await capturing
			.getByLabel('Photos')
			.setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: png });
		await context.clearCookies();
		await signIn(context, 'other');
		await switching.goto(origin + '/capture');
		await readyToCapture(switching);
		await expect(capturing.getByLabel('Title', { exact: true })).toHaveValue('');
		await expect(capturing.getByText('private.png', { exact: false })).toHaveCount(0);
		const records = await localRecords(capturing);
		expect(records).toContainEqual(
			expect.objectContaining({
				ownerId: 'guest',
				draft: expect.objectContaining({ title: 'Private unfinished dinosaur', listIds: [] })
			})
		);
		expect(records.filter((record) => record.ownerId === 'other')).toHaveLength(0);
		await context.clearCookies();
		await signIn(context, 'guest');
		await context.route('**/api/captures', (route) => route.abort());
		await capturing.goto(origin + '/capture');
		await expect(
			capturing.getByRole('button', { name: 'Private unfinished dinosaur', exact: true })
		).toBeVisible();
		await capturing
			.getByRole('button', { name: 'Private unfinished dinosaur', exact: true })
			.click();
		await expect(capturing.getByText('private.png', { exact: false })).toBeVisible();
	} finally {
		await context.close();
	}
});

test('retains edits and the replacement photo when an open saved offline draft reconnects', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'guest');
	const page = await context.newPage();
	try {
		await page.goto(origin + '/capture');
		await readyToCapture(page);
		await context.setOffline(true);
		await page.getByLabel('Title', { exact: true }).fill('Offline train before editing');
		await page.getByRole('button', { name: 'Save on this device', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Saved on this device', exact: true })
		).toBeVisible();
		await page.getByLabel('Title', { exact: true }).fill('Blue train with latest edits');
		const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#789' } })
			.png()
			.toBuffer();
		await page
			.getByLabel('Photos')
			.setInputFiles({ name: 'latest.png', mimeType: 'image/png', buffer: png });
		let uploads = 0;
		await context.route('**/api/captures', async (route) => {
			uploads++;
			await route.continue();
		});
		await context.setOffline(false);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
			'Blue train with latest edits'
		);
		await page.waitForTimeout(500);
		expect(uploads).toBe(0);
		await expect(page.getByText('latest.png', { exact: false })).toBeVisible();
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		expect(savedCounts('Offline train before editing')).toEqual({
			products: 0,
			media: 0,
			entries: 0
		});
		expect(savedCounts('Blue train with latest edits')).toEqual({
			products: 1,
			media: 1,
			entries: 0
		});
	} finally {
		await context.close();
	}
});

test('opens the device draft while a fresh identity request is stalled', async ({ browser }) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'guest');
	let page = await context.newPage();
	let release!: () => void;
	try {
		await page.goto(origin + '/capture');
		await readyToCapture(page);
		await context.setOffline(true);
		await page.getByLabel('Title', { exact: true }).fill('Local draft despite stalled connection');
		await page.getByRole('button', { name: 'Save on this device', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Saved on this device', exact: true })
		).toBeVisible();
		const record = (await localRecords(page))[0];
		await page.close();
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await context.route('**/api/me', async (route) => {
			await held;
			await route.continue();
		});
		await context.setOffline(false);
		page = await context.newPage();
		await page.goto(origin + '/capture?draft=' + record.id);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
			'Local draft despite stalled connection',
			{ timeout: 2000 }
		);
	} finally {
		release?.();
		await context.close();
	}
});

test('masks an unfinished account-bound photo if quota prevents preservation and restores it only to its author', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'guest');
	const capturing = await context.newPage();
	const switching = await context.newPage();
	try {
		await capturing.goto(origin + '/capture');
		await readyToCapture(capturing);
		await capturing.getByLabel('Title', { exact: true }).fill('Unfinished private quota photo');
		const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#789' } })
			.png()
			.toBuffer();
		await capturing
			.getByLabel('Photos')
			.setInputFiles({ name: 'quota-private.png', mimeType: 'image/png', buffer: png });
		await capturing.evaluate(() => {
			const scope = window as Window & { failCaptureBlobs?: boolean };
			scope.failCaptureBlobs = true;
			const put = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
				if (this.name === 'blobs' && scope.failCaptureBlobs)
					throw new DOMException('Storage full', 'QuotaExceededError');
				return key === undefined ? put.call(this, value) : put.call(this, value, key);
			};
		});
		await context.clearCookies();
		await signIn(context, 'other');
		await switching.goto(origin + '/capture');
		await expect(
			capturing.getByRole('heading', { name: 'Unfinished idea kept for its author' })
		).toBeVisible();
		await expect(capturing.getByLabel('Title', { exact: true })).toHaveCount(0);
		await expect(capturing.getByText('quota-private.png', { exact: false })).toHaveCount(0);
		expect(await localRecords(capturing)).toHaveLength(0);
		let signouts = 0;
		await capturing.route('**/api/auth/sign-out', async (route) => {
			signouts++;
			await route.continue();
		});
		await capturing.getByRole('button', { name: 'Sign out', exact: true }).click();
		await expect(
			capturing.getByText(
				'Finish saving or recover the unfinished idea with its original account before signing out.'
			)
		).toBeVisible();
		expect(signouts).toBe(0);
		await context.clearCookies();
		await signIn(context, 'guest');
		await switching.reload();
		await expect(capturing.getByLabel('Title', { exact: true })).toHaveValue(
			'Unfinished private quota photo'
		);
		await expect(capturing.getByText('quota-private.png', { exact: false })).toBeVisible();
		await capturing.evaluate(() => {
			(window as Window & { failCaptureBlobs?: boolean }).failCaptureBlobs = false;
		});
		await context.route('**/api/captures', (route) => route.abort());
		await capturing.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(
			capturing.getByRole('heading', { name: 'Needs attention', exact: true })
		).toBeVisible();
		expect((await localRecords(capturing))[0].ownerId).toBe('guest');
	} finally {
		await context.close();
	}
});

test('binds typing and a photo to the first verified account while its initial identity response is delayed', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'guest');
	const capturing = await context.newPage();
	const switching = await context.newPage();
	let release!: () => void;
	try {
		let received!: () => void;
		const started = new Promise<void>((resolve) => {
			received = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await capturing.route('**/api/me', async (route) => {
			const response = await route.fetch();
			received();
			await held;
			await route.fulfill({ response });
		});
		await capturing.goto(origin + '/capture?list=visible');
		await started;
		await expect(capturing.getByLabel('Title', { exact: true })).toBeEnabled();
		await capturing
			.getByLabel('Title', { exact: true })
			.fill('Typed before the first verified identity');
		const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#789' } })
			.png()
			.toBuffer();
		await capturing
			.getByLabel('Photos')
			.setInputFiles({ name: 'initial-photo.png', mimeType: 'image/png', buffer: png });
		release();
		await readyToCapture(capturing);
		await capturing.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(capturing.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		expect(savedCounts('Typed before the first verified identity')).toEqual({
			products: 1,
			media: 1,
			entries: 1
		});
		const saved = (await localRecords(capturing)).find(
			(record) => record.draft.title === 'Typed before the first verified identity'
		);
		expect(saved?.ownerId).toBe('guest');
		await capturing.getByRole('button', { name: 'Add another', exact: true }).click();
		await capturing
			.getByLabel('Title', { exact: true })
			.fill('A second unfinished idea still belongs to guest');
		await capturing
			.getByLabel('Photos')
			.setInputFiles({ name: 'still-private.png', mimeType: 'image/png', buffer: png });
		await context.clearCookies();
		await signIn(context, 'other');
		await switching.goto(origin + '/capture');
		await readyToCapture(switching);
		await expect(capturing.getByLabel('Title', { exact: true })).toHaveValue('');
		await expect(capturing.getByText('still-private.png', { exact: false })).toHaveCount(0);
		const unfinished = (await localRecords(capturing)).filter(
			(record) => record.draft.title === 'A second unfinished idea still belongs to guest'
		);
		expect(unfinished).toHaveLength(1);
		expect(unfinished[0].ownerId).toBe('guest');
		expect(savedCounts('A second unfinished idea still belongs to guest')).toEqual({
			products: 0,
			media: 0,
			entries: 0
		});
	} finally {
		release?.();
		await context.close();
	}
});

test('keeps a knowingly signed-out unfinished idea unbound when a later account signs in', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	const capturing = await context.newPage();
	const switching = await context.newPage();
	try {
		await capturing.goto(origin + '/capture');
		await expect(capturing.getByLabel('Title', { exact: true })).toBeEnabled();
		await expect(
			capturing.getByText('You can keep an unbound draft on this device.', { exact: false })
		).toBeVisible();
		await expect(
			capturing.getByRole('button', { name: 'Save on this device', exact: true })
		).toBeEnabled();
		await capturing
			.getByLabel('Title', { exact: true })
			.fill('Knowingly unbound before later sign-in');
		await signIn(context, 'other');
		await switching.goto(origin + '/capture');
		await readyToCapture(switching);
		await capturing.getByRole('button', { name: 'Save on this device', exact: true }).click();
		await expect(
			capturing.getByRole('button', { name: 'Adopt with my signed-in account', exact: true })
		).toBeVisible();
		const saved = (await localRecords(capturing)).find(
			(record) => record.draft.title === 'Knowingly unbound before later sign-in'
		);
		expect(saved?.ownerId).toBeNull();
		expect(savedCounts('Knowingly unbound before later sign-in')).toEqual({
			products: 0,
			media: 0,
			entries: 0
		});
	} finally {
		await context.close();
	}
});

test('preserves an unfinished photo before sign-out, restores the editor on cancel and synchronises exactly once on confirmation', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'guest');
	const page = await context.newPage();
	try {
		await page.goto(origin + '/capture?list=visible');
		await readyToCapture(page);
		await page.getByLabel('Title', { exact: true }).fill('Unfinished photo before sign-out');
		// Keep a typical phone-sized photo throughout preparation and cancellation.
		const png = await sharp({
			create: { width: 700, height: 700, channels: 3, background: '#789' }
		})
			.png({ compressionLevel: 0 })
			.toBuffer();
		expect(png.byteLength).toBeGreaterThan(512 * 1024);
		await page
			.getByLabel('Photos')
			.setInputFiles({ name: 'unfinished.png', mimeType: 'image/png', buffer: png });
		await page.getByRole('button', { name: 'Sign out', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Keep your pending ideas safe' })).toBeVisible();
		await expect(page.getByLabel('Title', { exact: true })).toBeDisabled();
		expect((await localRecords(page))[0]).toEqual(
			expect.objectContaining({
				ownerId: 'guest',
				draft: expect.objectContaining({ title: 'Unfinished photo before sign-out' })
			})
		);
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(page.getByLabel('Title', { exact: true })).toBeEnabled();
		await expect(page.getByText('unfinished.png', { exact: false })).toBeVisible();
		await page.getByLabel('Title', { exact: true }).fill('Final photo before sign-out');
		await page.getByRole('button', { name: 'Sign out', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Keep your pending ideas safe' })).toBeVisible();
		await page.getByRole('button', { name: 'Synchronise, then sign out', exact: true }).click();
		await expect(page).toHaveURL(origin + '/login');
		expect(savedCounts('Unfinished photo before sign-out')).toEqual({
			products: 0,
			media: 0,
			entries: 0
		});
		expect(savedCounts('Final photo before sign-out')).toEqual({
			products: 1,
			media: 1,
			entries: 1
		});
	} finally {
		await context.close();
	}
});
