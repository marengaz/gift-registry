import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { prepareMedia } from '../../src/lib/server/media';
import { fixture } from '../integration/identity-fixture';

const origin = 'http://localhost:4201';
const secret = 'test-only-catalogue-actions-729126fda292';
let directory: string;
let server: ChildProcess;
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-catalogue-actions-'));
	const model = fixture();
	const db = model.connection.sqlite;
	db.exec(`INSERT INTO products(id,title,contributor_id) VALUES ('train','Toy train','admin'),('puzzle','Wooden puzzle','admin'),('cards','Card game','admin');
 INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES ('train-entry','train','visible',2000);`);
	for (let index = 0; index < 50; index++) {
		db.prepare('INSERT INTO recipients(id,name) VALUES (?,?)').run(
			`child-${index}`,
			`Recipient ${index}`
		);
		db.prepare('INSERT INTO lists(id,recipient_id,name,occasion) VALUES (?,?,?,?)').run(
			`list-${index}`,
			`child-${index}`,
			`Wish list ${index}`,
			`Birthday ${index}`
		);
	}
	const picture = await sharp({
		create: { width: 60, height: 60, channels: 3, background: '#789' }
	})
		.png()
		.toBuffer();
	const prepared = await prepareMedia(
		[new File([new Uint8Array(picture)], 'train.png', { type: 'image/png' })],
		{ mediaRoot: join(directory, 'media') }
	);
	const photo = prepared.media[0];
	db.prepare(
		'INSERT INTO media(id,product_id,storage_path,mime_type,byte_size,original_name) VALUES(?,?,?,?,?,?)'
	).run(photo.id, 'train', photo.storagePath, photo.mimeType, photo.byteSize, photo.originalName);
	await model.connection.sqlite.backup(join(directory, 'test.sqlite'));
	model.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4201',
			ORIGIN: origin,
			PROTOCOL_HEADER: 'x-forwarded-proto',
			DATABASE_PATH: join(directory, 'test.sqlite'),
			MEDIA_PATH: join(directory, 'media'),
			BETTER_AUTH_SECRET: secret,
			GOOGLE_CLIENT_ID: 'test-client',
			GOOGLE_CLIENT_SECRET: 'test-secret',
			ADMINISTRATOR_EMAIL: 'admin@example.test'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	server.stdout?.on('data', (chunk) => (output += chunk));
	server.stderr?.on('data', (chunk) => (output += chunk));
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(origin + '/login')).ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(output || 'Catalogue action test server did not start.');
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
	await context.setExtraHTTPHeaders({ 'x-forwarded-proto': 'http' });
	await context.addCookies([
		{
			name: 'better-auth.session_token',
			value: encodeURIComponent(token + '.' + (await makeSignature(token, secret))),
			url: origin,
			httpOnly: true,
			sameSite: 'Lax'
		}
	]);
}

test('selects catalogue ideas and finds destination lists across searches', async ({
	page,
	context
}) => {
	await signIn(context);
	await page.goto(origin + '/catalogue');
	await expect(page.getByRole('checkbox', { name: 'Select Toy train', exact: true })).toBeVisible();
	await page.getByRole('checkbox', { name: 'Select Toy train', exact: true }).check();
	await page.getByRole('checkbox', { name: 'Select Wooden puzzle', exact: true }).check();
	await page.getByRole('button', { name: 'Add selected to lists', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Add to lists', exact: true });
	await expect(
		dialog.getByRole('checkbox', { name: /Child · Birthday/ }).locator('..')
	).toContainText('1 of 2 already listed');
	await page.screenshot({ path: '/private/tmp/gift-catalogue-picker-desktop.png', fullPage: true });
	await expect(dialog.getByLabel('Search lists', { exact: true })).toBeFocused();
	await dialog.getByLabel('Search lists', { exact: true }).fill('Recipient 41');
	await dialog.getByRole('checkbox', { name: /Recipient 41/ }).check();
	await dialog.getByLabel('Search lists', { exact: true }).fill('Birthday 7');
	await dialog.getByRole('checkbox', { name: /Recipient 7/ }).check();
	await expect(dialog.getByText('2 lists selected', { exact: true })).toBeVisible();
	await dialog.getByRole('button', { name: 'Add to 2 lists', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('button', { name: 'Undo last action', exact: true })).toBeEnabled();
	const products = await (await context.request.get(origin + '/api/products')).json();
	for (const id of ['train', 'puzzle'])
		expect(
			products.products
				.find((product: { id: string }) => product.id === id)
				.entries.map((entry: { listId: string }) => entry.listId)
		).toEqual(expect.arrayContaining(['list-41', 'list-7']));
});

test('keeps selection when switching views, clears it on filters, and cancels a keyboard dialog without writes', async ({
	page,
	context
}) => {
	await signIn(context);
	await page.goto(origin + '/catalogue');
	await page.getByRole('checkbox', { name: 'Select Toy train', exact: true }).check();
	await page.getByRole('button', { name: 'Compact list', exact: true }).click();
	await expect(page.getByRole('checkbox', { name: 'Select Toy train', exact: true })).toBeChecked();
	const add = page
		.getByRole('article')
		.filter({ has: page.getByRole('heading', { name: 'Toy train', exact: true }) })
		.getByRole('button', { name: 'Add to lists', exact: true });
	await add.click();
	const dialog = page.getByRole('dialog', { name: 'Add to lists', exact: true });
	await expect(dialog.getByRole('checkbox', { name: /Child · Birthday/ })).toBeDisabled();
	await expect(dialog.getByLabel('Search lists', { exact: true })).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(dialog.getByLabel('Search lists', { exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(add).toBeFocused();
	await page.getByLabel('Search', { exact: true }).fill('Toy train');
	await page.getByRole('button', { name: 'Find ideas', exact: true }).click();
	await expect(
		page.getByRole('checkbox', { name: 'Select Toy train', exact: true })
	).not.toBeChecked();
	await page.getByRole('checkbox', { name: 'Select all matching ideas', exact: true }).check();
	await expect(page.getByText('1 idea selected', { exact: true })).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: '/private/tmp/gift-catalogue-selection-mobile.png',
		fullPage: true
	});
	await page.getByRole('button', { name: 'Add selected to lists', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
		.toBe(true);
	await page.screenshot({ path: '/private/tmp/gift-catalogue-picker-mobile.png', fullPage: true });
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	for (const path of ['/lists/visible', '/inbox', '/my-gifts']) {
		await page.goto(origin + path);
		await expect(
			page.getByRole('checkbox', { name: /Select all matching ideas|Select Toy train/ })
		).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Undo last action', exact: true })).toHaveCount(
			0
		);
	}
});

test('deletes one idea, restores it after reload and keeps its memberships', async ({
	page,
	context
}) => {
	await signIn(context);
	await page.goto(origin + '/catalogue');
	const row = page
		.getByRole('article')
		.filter({ has: page.getByRole('heading', { name: 'Toy train', exact: true }) });
	const before = await (await context.request.get(origin + '/api/products/train')).json();
	await row.getByLabel('More actions for Toy train', { exact: true }).click();
	await row.getByRole('button', { name: 'Delete idea', exact: true }).click();
	await expect(row).toHaveCount(0);
	await expect(page.locator('.catalogue-status')).toBeFocused();
	expect((await context.request.get(origin + '/api/products/train')).status()).toBe(404);
	await page.reload();
	await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
	await expect(row).toBeVisible();
	await expect(page.getByRole('button', { name: 'Undo last action', exact: true })).toBeDisabled();
	await expect
		.poll(() =>
			row
				.getByRole('img', { name: 'Toy train', exact: true })
				.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 60)
		)
		.toBe(true);
	const after = await (await context.request.get(origin + '/api/products/train')).json();
	expect(after.entries).toEqual(before.entries);
});

test('retains a lost acknowledgement across reload and retries the identical request once', async ({
	page,
	context
}) => {
	await signIn(context);
	await page.goto(origin + '/catalogue');
	const requests: string[] = [];
	let lose = true;
	await page.route('**/api/catalogue-actions', async (route) => {
		if (route.request().method() !== 'POST') {
			await route.continue();
			return;
		}
		requests.push(route.request().postData()!);
		if (lose) {
			lose = false;
			await route.fetch();
			await route.abort('failed');
		} else await route.continue();
	});
	const row = page
		.getByRole('article')
		.filter({ has: page.getByRole('heading', { name: 'Card game', exact: true }) });
	await row.getByRole('button', { name: 'Add to lists', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Add to lists', exact: true });
	await dialog.getByLabel('Search lists', { exact: true }).fill('Recipient 22');
	await dialog.getByRole('checkbox', { name: /Recipient 22/ }).check();
	await dialog.getByRole('button', { name: 'Add to 1 list', exact: true }).click();
	await expect(
		dialog.getByRole('button', { name: 'Retry last request', exact: true })
	).toBeEnabled();
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
	await page.reload();
	await expect(page.getByRole('button', { name: 'Undo last action', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: 'Retry last request', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Retry last request', exact: true })).toHaveCount(
		0
	);
	expect(requests).toHaveLength(2);
	expect(requests[1]).toBe(requests[0]);
	const result = await (await context.request.get(origin + '/api/products/cards')).json();
	expect(
		result.entries.filter((entry: { listId: string }) => entry.listId === 'list-22')
	).toHaveLength(1);
});

test('a stale tab refreshes its Undo target without undoing another action', async ({
	page,
	context
}) => {
	await signIn(context);
	const post = (data: unknown) =>
		context.request.post(origin + '/api/catalogue-actions', { headers: { origin }, data });
	expect(
		(
			await post({
				operationId: crypto.randomUUID(),
				kind: 'add',
				productIds: ['cards'],
				listIds: ['list-31']
			})
		).ok()
	).toBe(true);
	await page.goto(origin + '/catalogue');
	const newer = await (
		await post({
			operationId: crypto.randomUUID(),
			kind: 'add',
			productIds: ['cards'],
			listIds: ['list-32']
		})
	).json();
	await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
	await expect(page.getByRole('status')).toContainText(/last action|latest action|changed/i);
	const status = await (await context.request.get(origin + '/api/catalogue-actions')).json();
	expect(status.undo.actionId).toBe(newer.undo.actionId);
	const result = await (await context.request.get(origin + '/api/products/cards')).json();
	expect(result.entries.map((entry: { listId: string }) => entry.listId)).toEqual(
		expect.arrayContaining(['list-31', 'list-32'])
	);
});

test('requires renewed deletion confirmation when buying commitments change', async ({
	page,
	context
}) => {
	await signIn(context);
	const database = new Database(join(directory, 'test.sqlite'));
	database.exec(`INSERT INTO products(id,title,contributor_id) VALUES ('committed','Committed gift','admin');
 INSERT INTO entries(id,product_id,list_id,state,buyer_id,allocation_source,allocated_by_id) VALUES ('committed-visible','committed','visible','allocated','admin','self','admin');
 INSERT INTO entries(id,product_id,list_id) VALUES ('committed-secret','committed','secret');`);
	database.close();
	await page.goto(origin + '/catalogue');
	const row = page
		.getByRole('article')
		.filter({ has: page.getByRole('heading', { name: 'Committed gift', exact: true }) });
	await row.getByLabel('More actions for Committed gift', { exact: true }).click();
	await row.getByRole('button', { name: 'Delete idea', exact: true }).click();
	const dialog = page.getByRole('dialog', {
		name: 'Delete ideas with buying commitments?',
		exact: true
	});
	await expect(dialog).toContainText('1 reserved or assigned gift');
	expect(
		(
			await context.request.post(origin + '/api/entries/committed-secret/allocation', {
				headers: { origin },
				data: {
					actionId: crypto.randomUUID(),
					action: 'assign',
					expectedVersion: 0,
					buyerId: 'admin'
				}
			})
		).ok()
	).toBe(true);
	await dialog.getByRole('button', { name: 'Delete these ideas', exact: true }).click();
	await expect(dialog).toContainText('2 reserved or assigned gifts');
	expect((await context.request.get(origin + '/api/products/committed')).ok()).toBe(true);
	await dialog.getByRole('button', { name: 'Delete these ideas', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(row).toHaveCount(0);
	await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
	await expect(row).toBeVisible();
});

test('recovers a lost delete response after reload before confirming its retained targets', async ({
	page,
	context
}) => {
	await signIn(context);
	const database = new Database(join(directory, 'test.sqlite'));
	database.exec(
		`INSERT INTO products(id,title,contributor_id) VALUES ('lost-delete','Retained gift','admin'); INSERT INTO entries(id,product_id,list_id,state,buyer_id,allocation_source,allocated_by_id) VALUES ('lost-delete-entry','lost-delete','visible','allocated','admin','self','admin');`
	);
	database.close();
	await page.goto(origin + '/catalogue');
	const row = page
		.getByRole('article')
		.filter({ has: page.getByRole('heading', { name: 'Retained gift', exact: true }) });
	let lose = true;
	const requests: string[] = [];
	await page.route('**/api/catalogue-actions', async (route) => {
		if (route.request().method() !== 'POST') {
			await route.continue();
			return;
		}
		requests.push(route.request().postData()!);
		if (lose) {
			lose = false;
			await route.fetch();
			await route.abort('failed');
		} else await route.continue();
	});
	await row.getByLabel('More actions for Retained gift', { exact: true }).click();
	await row.getByRole('button', { name: 'Delete idea', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Retry last request', exact: true })).toBeEnabled();
	await page.reload();
	await page.getByRole('button', { name: 'Retry last request', exact: true }).click();
	const dialog = page.getByRole('dialog', {
		name: 'Delete ideas with buying commitments?',
		exact: true
	});
	await expect(dialog).toBeVisible();
	expect(requests[1]).toBe(requests[0]);
	await dialog.getByRole('button', { name: 'Delete these ideas', exact: true }).click();
	await expect(row).toHaveCount(0);
	expect(JSON.parse(requests[2]).productIds).toEqual(['lost-delete']);
	await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
	await expect(row).toBeVisible();
});
