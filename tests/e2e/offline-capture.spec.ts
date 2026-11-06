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
const origin = 'http://localhost:4189';
const secret = 'test-only-offline-secret-8d10a957acf165810';
let directory: string;
let server: ChildProcess;
let output = '';
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-offline-browser-'));
	const model = fixture();
	for (const id of ['guest', 'other'])
		acceptInvitation(
			model.connection,
			model.actor(id),
			createInvitation(model.connection, model.admin, {
				email: `${id}@example.test`,
				grants: [{ listId: 'visible', role: id === 'guest' ? 'contributor' : 'viewer' }]
			}).token
		);
	await model.connection.sqlite.backup(join(directory, 'gifts.sqlite'));
	model.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4189',
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
test('keeps offline photos and lists across a closed page and synchronises once on return', async ({
	browser
}) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	await signIn(context, 'guest');
	let page = await context.newPage();
	try {
		await page.addInitScript(() => {
			Object.defineProperty(navigator.storage, 'persist', { value: async () => false });
		});
		await page.goto(origin + '/capture?list=visible');
		await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
		await context.setOffline(true);
		await page.getByLabel('Title', { exact: true }).fill('Offline photo train');
		await page.getByText('More details', { exact: true }).click();
		await page.getByLabel('Original text or notes').fill('Shop window, saved without a connection');
		const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#789' } })
			.png()
			.toBuffer();
		await page
			.getByLabel('Photos')
			.setInputFiles({ name: 'offline-train.png', mimeType: 'image/png', buffer: png });
		await page.getByRole('button', { name: 'Save on this device', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Saved on this device', exact: true })
		).toBeVisible();
		const record = (await localRecords(page)).find(
			(record) => record.draft.title === 'Offline photo train'
		)!;
		expect(record.draft.listIds).toEqual(['visible']);
		await page.close();
		await context.route('**/api/captures', (route) => route.abort());
		await context.setOffline(false);
		page = await context.newPage();
		await page.goto(origin + '/capture?draft=' + record.id);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Offline photo train');
		await expect(page.getByText('offline-train.png', { exact: false })).toBeVisible();
		await expect.poll(async () => (await localRecords(page))[0].status).toBe('needsattention');
		expect((await localRecords(page))[0].operationId).toBe(record.operationId);
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
			.toBe(true);
		await page.getByRole('button', { name: 'Sign out', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Keep your pending ideas safe' })).toBeVisible();
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		expect(await localRecords(page)).toHaveLength(1);
		await context.unroute('**/api/captures');
		await page.getByRole('button', { name: 'Retry this idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		expect(savedCounts('Offline photo train')).toEqual({ products: 1, media: 1, entries: 1 });
	} finally {
		await context.close();
	}
});
test('recovers a lost response after reauthentication without exposing or uploading its author’s draft as another account', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'guest');
	const page = await context.newPage();
	try {
		let uploads = 0;
		await context.route('**/api/captures', async (route) => {
			uploads++;
			await route.fetch();
			await route.abort('failed');
		});
		await page.goto(origin + '/capture?list=visible');
		await expect(
			page.getByRole('checkbox', { name: 'Child · Birthday Birthday', exact: true })
		).toBeChecked();
		await page.getByLabel('Title', { exact: true }).fill('Lost response kite');
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
		const record = (await localRecords(page))[0];
		expect(savedCounts('Lost response kite')).toEqual({ products: 1, media: 0, entries: 1 });
		const beforeSwitch = uploads;
		await context.clearCookies();
		await signIn(context, 'other');
		await page.goto(origin + '/capture?draft=' + record.id);
		await expect(
			page.getByRole('heading', { name: 'Contributor access needed', exact: true })
		).toBeVisible();
		await expect(page.getByText('Lost response kite', { exact: true })).toHaveCount(0);
		expect(uploads).toBe(beforeSwitch);
		expect((await localRecords(page))[0].ownerId).toBe('guest');
		await context.unroute('**/api/captures');
		await context.clearCookies();
		await signIn(context, 'guest');
		await page.goto(origin + '/capture?draft=' + record.id);
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		expect(savedCounts('Lost response kite')).toEqual({ products: 1, media: 0, entries: 1 });
		expect((await localRecords(page))[0].operationId).toBe(record.operationId);
	} finally {
		await context.close();
	}
});

test('retains a new offline draft if sign-out takes longer than its local lease', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'guest');
	const signingOut = await context.newPage();
	const capturing = await context.newPage();
	let release!: () => void;
	try {
		await capturing.clock.install();
		await signingOut.goto(origin + '/capture');
		await capturing.goto(origin + '/capture');
		await expect(capturing.getByLabel('Title', { exact: true })).toBeVisible();
		let started!: () => void;
		const received = new Promise<void>((resolve) => {
			started = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await context.route('**/api/auth/sign-out', async (route) => {
			const response = await route.fetch();
			started();
			await held;
			await route.fulfill({ response });
		});
		await signingOut.getByRole('button', { name: 'Sign out', exact: true }).click();
		await received;
		await context.setOffline(true);
		await capturing.clock.fastForward(61_000);
		await capturing.getByLabel('Title', { exact: true }).fill('Captured during slow sign-out');
		await capturing.getByRole('button', { name: 'Save on this device', exact: true }).click();
		await expect(
			capturing.getByRole('heading', { name: 'Saved on this device', exact: true })
		).toBeVisible();
		const record = (await localRecords(capturing))[0];
		expect(record.ownerId).toBe('guest');
		release();
		await expect
			.poll(() =>
				capturing.evaluate(async () => {
					const db = await new Promise<IDBDatabase>((resolve, reject) => {
						const request = indexedDB.open('family-gift-captures');
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					});
					try {
						return await new Promise<boolean>((resolve, reject) => {
							const request = db.transaction('context').objectStore('context').get('active');
							request.onsuccess = () => resolve(!request.result);
							request.onerror = () => reject(request.error);
						});
					} finally {
						db.close();
					}
				})
			)
			.toBe(true);
		expect(await localRecords(capturing)).toContainEqual(
			expect.objectContaining({
				id: record.id,
				ownerId: 'guest',
				operationId: record.operationId,
				status: 'local'
			})
		);
	} finally {
		release?.();
		await context.close();
	}
});
