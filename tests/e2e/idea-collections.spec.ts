import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import { fixture } from '../integration/identity-fixture';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';

const origin = 'http://localhost:4198';
const secret = 'test-only-collection-secret-8d10a957acf165810';
let directory: string;
let server: ChildProcess;
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-collections-'));
	const model = fixture();
	for (const listId of ['visible', 'secret'])
		acceptInvitation(
			model.connection,
			model.actor('guest'),
			createInvitation(model.connection, model.admin, {
				email: 'guest@example.test',
				grants: [{ listId, role: 'buyer' }]
			}).token
		);
	model.connection.sqlite.exec(`
		INSERT INTO products(id,title,contributor_id) VALUES
		('pencils','Pencil set','admin'),('train','Toy train','admin'),
		('puzzle','Wooden puzzle','admin'),('hidden','Secret telescope','admin'),
		('inbox','Shop photo idea','guest'),('rocket','Rocket idea','admin');
		INSERT INTO labels(id,name) VALUES ('art','Art');
		INSERT INTO product_labels(product_id,label_id) VALUES ('pencils','art');
		INSERT INTO entries(id,product_id,list_id,estimate_pence,state,buyer_id,allocation_source,allocated_by_id,allocated_at,purchased_at) VALUES
		('pencils-entry','pencils','visible',800,'available',NULL,NULL,NULL,NULL,NULL),
		('train-entry','train','visible',2000,'allocated','guest','self','guest',1,NULL),
		('train-other','train','secret',2500,'purchased','guest','administrator','admin',1,2),
		('puzzle-entry','puzzle','visible',1500,'purchased','guest','self','guest',1,2),
		('hidden-entry','hidden','visible',5000,'allocated','other','administrator','admin',1,NULL);
	`);
	await model.connection.sqlite.backup(join(directory, 'test.sqlite'));
	model.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4198',
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
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(origin + '/login')).ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(output || 'Collection test server did not start.');
});
test.afterAll(async () => {
	if (server && server.exitCode === null) {
		server.kill('SIGTERM');
		await new Promise<void>((resolve) => server.once('exit', () => resolve()));
	}
	rmSync(directory, { recursive: true, force: true });
});
async function signIn(context: BrowserContext, id: string) {
	const token = 'token-' + id;
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

test('switches every idea collection between cards and compact rows, remembering the preference', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'admin');
	const page = await context.newPage();
	try {
		await page.goto(origin + '/catalogue');
		await expect(page.getByRole('button', { name: 'Cards', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await page.getByRole('button', { name: 'Compact list', exact: true }).click();
		for (const path of ['/catalogue', '/inbox', '/lists/visible', '/my-gifts']) {
			await page.goto(origin + path);
			await expect(page.getByRole('button', { name: 'Compact list', exact: true })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		}
		await page.goto(origin + '/lists/visible');
		await page.setViewportSize({ width: 390, height: 844 });
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
			.toBe(true);
		const row = page
			.getByRole('article')
			.filter({ has: page.getByRole('heading', { name: 'Pencil set', exact: true }) });
		await expect(row).toContainText('£8.00');
		await expect(row).toContainText('Available');
		await expect(row.getByRole('button', { name: 'Assign gift', exact: true })).toBeHidden();
		await row.getByText('Gift actions', { exact: true }).click();
		await expect(row.getByLabel('Assign to')).toBeVisible();
		await page.getByRole('button', { name: 'Cards', exact: true }).click();
		await page.reload();
		await expect(page.getByRole('button', { name: 'Cards', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	} finally {
		await context.close();
	}
});

test('filters my gifts by each list allocation and removes a newly purchased gift from still-to-buy', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'guest');
	const page = await context.newPage();
	try {
		await page.goto(origin + '/my-gifts');
		await page.getByLabel('Buying status', { exact: true }).selectOption('allocated');
		await page.getByRole('button', { name: 'Find ideas', exact: true }).click();
		await expect(page.getByRole('article')).toHaveCount(1);
		await expect(page.getByRole('article')).toContainText('Toy train');
		await expect(page.getByRole('article')).toContainText('£20.00');
		await page.reload();
		await expect(page.getByRole('article')).toHaveCount(1);
		await page.getByRole('button', { name: 'Compact list', exact: true }).click();
		await page.getByText('Gift actions', { exact: true }).click();
		await page.getByRole('button', { name: 'Mark purchased', exact: true }).click();
		await expect(
			page.getByRole('heading', { name: 'No matching ideas', exact: true })
		).toBeVisible();
		await page.getByRole('link', { name: 'Clear filters', exact: true }).click();
		await expect(page.getByRole('article')).toHaveCount(3);
		await expect(page.getByRole('heading', { name: 'Secret telescope', exact: true })).toHaveCount(
			0
		);
		await page.getByText('More filters', { exact: true }).click();
		await page.getByLabel('Gift list', { exact: true }).selectOption('secret');
		await page.getByRole('button', { name: 'Find ideas', exact: true }).click();
		await expect(page.getByRole('article')).toHaveCount(1);
		await expect(page.getByRole('article')).toContainText('£25.00');
	} finally {
		await context.close();
	}
});

test('combines catalogue filters and clears them, and searches the unlisted inbox', async ({
	browser
}) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	await signIn(context, 'admin');
	const page = await context.newPage();
	try {
		await page.goto(origin + '/catalogue');
		await page.getByText('More filters', { exact: true }).click();
		await page.getByLabel('Gift list', { exact: true }).selectOption('visible');
		await page.getByLabel('Label', { exact: true }).selectOption('art');
		await page.getByLabel('Maximum price (£)', { exact: true }).fill('10');
		await page.getByRole('button', { name: 'Find ideas', exact: true }).click();
		await expect(page.getByRole('article')).toHaveCount(1);
		await expect(page.getByRole('heading', { name: 'Pencil set', exact: true })).toBeVisible();
		await page.getByRole('link', { name: 'Clear filters', exact: true }).click();
		await expect(page.getByRole('article')).toHaveCount(6);
		await page.goto(origin + '/inbox');
		await page.getByLabel('Search', { exact: true }).fill('Rocket');
		await page.getByRole('button', { name: 'Find ideas', exact: true }).click();
		await expect(page.getByRole('article')).toHaveCount(1);
		await expect(page.getByRole('heading', { name: 'Rocket idea', exact: true })).toBeVisible();
	} finally {
		await context.close();
	}
});
