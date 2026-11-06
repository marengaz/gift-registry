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

const origin = 'http://localhost:4192';
const secret = 'test-only-share-secret-8d10a957acf165810';
let directory: string;
let server: ChildProcess;
let output = '';
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-share-browser-'));
	const model = fixture();
	acceptInvitation(
		model.connection,
		model.actor('guest'),
		createInvitation(model.connection, model.admin, {
			email: 'guest@example.test',
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
			PORT: '4192',
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
	throw new Error('Share test server did not start: ' + output);
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
async function stubMetadata(context: BrowserContext) {
	await context.route('**/api/metadata', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ suggestions: [], message: 'No product metadata found.' })
		})
	);
}
async function initialise(page: Page, path = '/capture') {
	await page.goto(origin + path);
	await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
	await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}
async function records(page: Page) {
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
					draft: { title: string; sourceUrl: string; sourceText: string; listIds: string[] };
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
function counts(title?: string) {
	const db = new Database(join(directory, 'gifts.sqlite'), { readonly: true });
	try {
		if (title)
			return db
				.prepare(
					'SELECT (SELECT count(*) FROM products WHERE title=?) AS products,(SELECT count(*) FROM media m JOIN products p ON p.id=m.product_id WHERE p.title=?) AS media,(SELECT count(*) FROM entries e JOIN products p ON p.id=e.product_id WHERE p.title=?) AS entries'
				)
				.get(title, title, title);
		return db
			.prepare(
				'SELECT (SELECT count(*) FROM products) AS products,(SELECT count(*) FROM entries) AS entries,(SELECT count(*) FROM allocation_history) AS actions'
			)
			.get();
	} finally {
		db.close();
	}
}

test('imports Android URL, text and photo shares locally and requires explicit account adoption', async ({
	browser
}) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	const page = await context.newPage();
	try {
		await stubMetadata(context);
		await initialise(page);
		await submitShare(page, { url: 'https://retailer.example/train' });
		await expect(page).toHaveURL(/\/capture\?draft=/);
		await expect(page.getByLabel('Product link')).toHaveValue('https://retailer.example/train');
		await expect(page.getByLabel('Product link')).toBeEditable();
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
		expect((await records(page))[0].ownerId).toBeNull();
		await submitShare(
			page,
			{ title: 'Shared photo train', text: 'Found here https://retailer.example/photo-train' },
			{
				name: 'shop-train.png',
				type: 'image/png',
				bytes: [
					...(await sharp({ create: { width: 20, height: 20, channels: 3, background: '#aab' } })
						.png()
						.toBuffer())
				]
			}
		);
		await expect(page).toHaveURL(/\/capture\?draft=/);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Shared photo train');
		await expect(page.getByLabel('Product link')).toHaveValue(
			'https://retailer.example/photo-train'
		);
		await expect(page.getByText('shop-train.png', { exact: false })).toBeVisible();
		const imported = (await records(page)).find(
			(record) => record.draft.title === 'Shared photo train'
		)!;
		expect(imported.ownerId).toBeNull();
		const first = (await records(page)).find(
			(record) => record.draft.sourceUrl === 'https://retailer.example/train'
		)!;
		await page.evaluate((id) => {
			const link = document.createElement('a');
			link.href = '/capture?draft=' + id;
			link.textContent = 'Open the first shared draft';
			document.body.append(link);
		}, first.id);
		await page.getByRole('link', { name: 'Open the first shared draft', exact: true }).click();
		await expect(page).toHaveURL(origin + '/capture?draft=' + first.id);
		await expect(page.getByLabel('Product link')).toHaveValue('https://retailer.example/train');
		await page.evaluate((id) => {
			const link = document.createElement('a');
			link.href = '/capture?draft=' + id;
			link.textContent = 'Return to the photo draft';
			document.body.append(link);
		}, imported.id);
		await page.getByRole('link', { name: 'Return to the photo draft', exact: true }).click();
		await expect(page).toHaveURL(origin + '/capture?draft=' + imported.id);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Shared photo train');
		expect(counts('Shared photo train')).toEqual({ products: 0, media: 0, entries: 0 });
		await signIn(context, 'guest');
		await page.reload();
		await expect(
			page.getByRole('button', { name: 'Adopt with my signed-in account' })
		).toBeVisible();
		expect((await records(page)).find((record) => record.id === imported.id)?.ownerId).toBeNull();
		expect(counts('Shared photo train')).toEqual({ products: 0, media: 0, entries: 0 });
		await page.getByRole('button', { name: 'Adopt with my signed-in account' }).click();
		await expect(page.getByRole('checkbox')).toBeVisible();
		await page.getByRole('checkbox').check();
		await page.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		expect(counts('Shared photo train')).toEqual({ products: 1, media: 1, entries: 1 });
		await page.screenshot({ path: '/private/tmp/gift-share-mobile.png', fullPage: true });
	} finally {
		await context.close();
	}
});

test('reopens the public capture screen offline, keeps a photo and list, then synchronises once', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'guest');
	let page = await context.newPage();
	try {
		await stubMetadata(context);
		await initialise(page, '/capture?list=visible');
		await page.goto(origin + '/lists/visible');
		await expect(page.getByRole('heading', { name: 'Child', exact: true })).toBeVisible();
		await page.goto(origin + '/capture?list=visible');
		await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
		await context.setOffline(true);
		await page.reload();
		await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
		await page.getByLabel('Title', { exact: true }).fill('Flight mode photo gift');
		await page.getByLabel('Photos').setInputFiles({
			name: 'offline-gift.png',
			mimeType: 'image/png',
			buffer: await sharp({ create: { width: 12, height: 12, channels: 3, background: '#789' } })
				.png()
				.toBuffer()
		});
		await page.getByRole('button', { name: 'Save on this device', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'Saved on this device', exact: true })
		).toBeVisible();
		const record = (await records(page)).find(
			(record) => record.draft.title === 'Flight mode photo gift'
		)!;
		expect(record.ownerId).toBe('guest');
		expect(record.draft.listIds).toEqual(['visible']);
		const cacheEvidence = await page.evaluate(async () => {
			const urls: string[] = [];
			let shell = '';
			for (const key of await caches.keys()) {
				const cache = await caches.open(key);
				for (const request of await cache.keys()) {
					urls.push(new URL(request.url).pathname);
					if (new URL(request.url).pathname === '/capture')
						shell = await (await cache.match(request))!.text();
				}
			}
			return { urls, shell };
		});
		expect(cacheEvidence.urls).toContain('/capture');
		expect(cacheEvidence.urls.some((path) => /^\/(api|lists|products)(\/|$)/.test(path))).toBe(
			false
		);
		expect(cacheEvidence.shell).not.toContain('admin@example.test');
		expect(cacheEvidence.shell).not.toContain('guest@example.test');
		expect(cacheEvidence.shell).not.toContain('Child');
		const sharedPhoto = await sharp({
			create: { width: 15, height: 15, channels: 3, background: '#9ab' }
		})
			.png()
			.toBuffer();
		await submitShare(
			page,
			{ title: 'Offline shared shop photo', text: 'https://retailer.example/offline-photo' },
			{
				name: 'offline-share.png',
				type: 'image/png',
				bytes: [...sharedPhoto]
			}
		);
		await expect(page).toHaveURL(/\/capture\?draft=/);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
			'Offline shared shop photo'
		);
		await expect(page.getByLabel('Product link')).toHaveValue(
			'https://retailer.example/offline-photo'
		);
		const unbound = (await records(page)).find(
			(value) => value.draft.title === 'Offline shared shop photo'
		)!;
		expect(unbound.ownerId).toBeNull();
		expect(counts('Offline shared shop photo')).toEqual({ products: 0, media: 0, entries: 0 });
		await page.close();
		page = await context.newPage();
		await page.goto(origin + '/capture?draft=' + unbound.id);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
			'Offline shared shop photo'
		);
		await expect(page.getByText('offline-share.png', { exact: false })).toBeVisible();
		const reopened = (await records(page)).find((value) => value.id === unbound.id)!;
		expect(reopened.ownerId).toBeNull();
		expect(reopened.operationId).toBe(unbound.operationId);
		const storedBytes = await page.evaluate(async (draftId) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('family-gift-captures');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const photo = await new Promise<{ blob: Blob }>((resolve, reject) => {
					const request = db
						.transaction('blobs')
						.objectStore('blobs')
						.index('draftId')
						.get(draftId);
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				return Array.from(new Uint8Array(await photo.blob.arrayBuffer()));
			} finally {
				db.close();
			}
		}, unbound.id);
		expect(storedBytes).toEqual([...sharedPhoto]);
		await page.goto(origin + '/capture?draft=' + record.id);
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Flight mode photo gift');
		await expect(page.getByText('offline-gift.png', { exact: false })).toBeVisible();
		expect((await records(page)).find((value) => value.id === record.id)?.operationId).toBe(
			record.operationId
		);
		await context.setOffline(false);
		await expect(page.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		expect(counts('Flight mode photo gift')).toEqual({ products: 1, media: 1, entries: 1 });
		expect(counts('Offline shared shop photo')).toEqual({ products: 0, media: 0, entries: 0 });
		expect((await records(page)).find((value) => value.id === unbound.id)?.ownerId).toBeNull();
	} finally {
		await context.close();
	}
});

test('gives recovery instructions for unsupported shares and for an external POST without a local receiver', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'admin');
	const page = await context.newPage();
	try {
		await stubMetadata(context);
		await initialise(page);
		const before = counts();
		const fallback = await context.request.post(origin + '/share', {
			headers: { origin: 'https://outside.example' },
			multipart: {
				title: 'External share should not create an idea',
				text: 'https://retailer.example/external'
			}
		});
		expect(fallback.status()).toBe(503);
		expect(await fallback.text()).toContain('This share has not been saved');
		expect(counts()).toEqual(before);
		for (const path of ['/api/products', '/api/auth/sign-out']) {
			for (const encoding of ['json', 'form'] as const) {
				const denied = await context.request.post(origin + path, {
					headers: { origin: 'https://outside.example' },
					...(encoding === 'json'
						? { data: { title: 'Cross-origin write' } }
						: { multipart: { title: 'Cross-origin form write' } })
				});
				expect(denied.status()).toBe(403);
				expect(await denied.json()).toEqual({ message: 'This request must come from this site.' });
			}
		}
		const stillSignedIn = await context.request.get(origin + '/api/me');
		expect(stillSignedIn.status()).toBe(200);
		expect((await stillSignedIn.json()).id).toBe('admin');
		await submitShare(
			page,
			{ title: 'Unsupported drawing' },
			{ name: 'drawing.svg', type: 'image/svg+xml', bytes: [...Buffer.from('<svg/>')] }
		);
		await expect(
			page.getByRole('heading', { name: 'This share has not been saved', exact: true })
		).toBeVisible();
		await expect(page.getByText(/supported photo/)).toBeVisible();
		expect(counts()).toEqual(before);
		await page.goto(origin + '/capture');
		await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
		expect(await records(page)).toEqual([]);
	} finally {
		await context.close();
	}
});
