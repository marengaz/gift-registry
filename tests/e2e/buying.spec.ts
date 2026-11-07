import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { makeSignature } from 'better-auth/crypto';
import { fixture } from '../integration/identity-fixture';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';
const origin = 'http://localhost:4188';
const secret = 'test-only-random-secret-8d10a957acf165810d9a';
let server: ChildProcess;
let directory: string;
let output = '';
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-buying-browser-'));
	const context = fixture();
	for (const [id, role] of [
		['guest', 'buyer'],
		['other', 'viewer']
	] as const)
		acceptInvitation(
			context.connection,
			context.actor(id),
			createInvitation(context.connection, context.admin, {
				email: `${id}@example.test`,
				grants: [{ listId: 'visible', role }]
			}).token
		);
	context.connection.sqlite.exec(
		"INSERT INTO products(id,title,contributor_id) VALUES('game','Card game','admin'),('puzzle','Wooden puzzle','admin'); INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES('game-entry','game','visible',2000),('puzzle-entry','puzzle','visible',3000)"
	);
	await context.connection.sqlite.backup(join(directory, 'test.sqlite'));
	context.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4188',
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
	server.stdout?.on('data', (chunk) => (output += chunk));
	server.stderr?.on('data', (chunk) => (output += chunk));
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(origin + '/login')).ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('Buying test server did not start: ' + output);
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
test('relatives reserve and purchase their own gifts, while administrator assigns a read-only viewer gift and sees totals', async ({
	browser
}) => {
	const buyer = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	const viewer = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	const admin = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	try {
		await signIn(buyer, 'guest');
		await signIn(viewer, 'other');
		await signIn(admin, 'admin');
		const page = await buyer.newPage();
		const view = await viewer.newPage();
		const manage = await admin.newPage();
		await page.goto(origin + '/lists/visible');
		const game = page
			.getByRole('article')
			.filter({ has: page.getByRole('heading', { name: 'Card game', exact: true }) });
		await expect(game.getByRole('button', { name: 'Reserve for me' })).toBeEnabled();
		await game.getByRole('button', { name: 'Reserve for me' }).click();
		await expect(game.getByText('Reserved', { exact: true })).toBeVisible();
		await view.goto(origin + '/lists/visible');
		await expect(view.getByRole('heading', { name: 'Card game', exact: true })).toHaveCount(0);
		const hidden = await viewer.request.get(origin + '/api/products/game');
		expect(hidden.status()).toBe(404);
		await page.getByRole('link', { name: 'My gifts', exact: true }).click();
		await expect(page).toHaveURL(origin + '/my-gifts');
		await expect(page.getByRole('heading', { name: 'Card game', exact: true })).toBeVisible();
		await page.getByLabel('Actual GBP spend (optional)').fill('17.50');
		await page.getByRole('button', { name: 'Mark purchased', exact: true }).click();
		await expect(game.getByText('Purchased', { exact: true })).toBeVisible();
		await expect(page.getByText('£17.50 · actual spend')).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
			.toBe(true);
		await page.screenshot({ path: '/private/tmp/gift-buying-mobile.png', fullPage: true });
		await manage.goto(origin + '/lists/visible');
		await expect(manage.getByRole('region', { name: 'List totals' })).toContainText('£17.50');
		const puzzle = manage
			.getByRole('article')
			.filter({ has: manage.getByRole('heading', { name: 'Wooden puzzle', exact: true }) });
		await expect(puzzle.getByLabel('Assign to')).toBeEnabled();
		await puzzle.getByLabel('Assign to').selectOption('other');
		await puzzle.getByRole('button', { name: 'Assign gift', exact: true }).click();
		await expect(puzzle.getByText(/Assigned · other/)).toBeVisible();
		await view.goto(origin + '/my-gifts');
		await expect(view.getByRole('heading', { name: 'Wooden puzzle', exact: true })).toBeVisible();
		await expect(view.getByRole('button', { name: 'Mark purchased' })).toHaveCount(0);
		await expect(
			view.getByText('Ask the administrator to record a purchase or change your assignment.')
		).toBeVisible();
		await manage.setViewportSize({ width: 1440, height: 1000 });
		await manage.screenshot({ path: '/private/tmp/gift-buying-desktop.png', fullPage: true });
	} finally {
		await buyer.close();
		await viewer.close();
		await admin.close();
	}
});

test('keeps buying state separate when following another list membership', async ({ browser }) => {
	const db = new Database(join(directory, 'test.sqlite'));
	try {
		db.exec(
			"INSERT INTO lists(id,recipient_id,name,occasion) VALUES('cross-list-first','child','First scope','Cross first'),('cross-list-second','child','Second scope','Cross second'); INSERT INTO products(id,title,contributor_id) VALUES('cross-product','Cross-list game','admin'); INSERT INTO entries(id,product_id,list_id,estimate_pence,actual_pence,state,buyer_id,allocation_source,allocated_by_id,allocated_at,purchased_at,version) VALUES('cross-visible','cross-product','cross-list-first',2000,1750,'purchased','admin','administrator','admin',1,1,1); INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES('cross-secret','cross-product','cross-list-second',2000)"
		);
	} finally {
		db.close();
	}
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	try {
		await signIn(context, 'admin');
		const page = await context.newPage();
		await page.goto(origin + '/lists/cross-list-first');
		const game = page
			.getByRole('article')
			.filter({ has: page.getByRole('heading', { name: 'Cross-list game', exact: true }) });
		await expect(game.getByText(/Purchased/)).toBeVisible();
		await game.getByRole('link', { name: 'Child · Second scope', exact: true }).click();
		await expect(page).toHaveURL(origin + '/lists/cross-list-second');
		await expect(game.getByRole('button', { name: 'Reserve for me', exact: true })).toBeEnabled();
		await expect(game.getByText(/Purchased/)).toHaveCount(0);
		await game.getByRole('button', { name: 'Reserve for me', exact: true }).click();
		await expect(game.getByText(/Reserved/)).toBeVisible();
		const original = await context.request.get(origin + '/api/entries/cross-visible/allocation');
		expect((await original.json()).entry).toMatchObject({
			state: 'purchased',
			actualPence: 1750,
			buyerId: 'admin'
		});
	} finally {
		await context.close();
	}
});
