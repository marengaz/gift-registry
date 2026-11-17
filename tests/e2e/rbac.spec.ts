import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { makeSignature } from 'better-auth/crypto';
import { fixture } from '../integration/identity-fixture';

const origin = 'http://localhost:4205';
const secret = 'test-only-random-secret-rbac-e2e-9401f2b3c4';
const screenshotDir = process.env.RBAC_SCREENSHOT_DIR;
let server: ChildProcess;
let directory: string;
let output = '';

test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-rbac-browser-'));
	const context = fixture();
	context.connection.sqlite.exec(
		"INSERT INTO products(id,title,contributor_id) VALUES('train','Wooden train','admin'),('book','Story book','admin'); INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES('train-visible','train','visible',2500),('book-secret','book','secret',1400)"
	);
	await context.connection.sqlite.backup(join(directory, 'test.sqlite'));
	context.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4205',
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
	throw new Error('RBAC test server did not start: ' + output);
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

async function saveScreenshot(page: import('@playwright/test').Page, name: string) {
	if (!screenshotDir) return;
	mkdirSync(screenshotDir, { recursive: true });
	await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
}

test('administers site-wide and per-list RBAC roles and enforces collaborator, gift buyer, list collaborator, and guest boundaries', async ({
	browser
}) => {
	test.setTimeout(60000);
	const admin = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	const collaborator = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	const buyer = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	try {
		await Promise.all([
			signIn(admin, 'admin'),
			signIn(collaborator, 'other'),
			signIn(buyer, 'guest')
		]);
		const adminPage = await admin.newPage();
		const collabPage = await collaborator.newPage();
		const buyerPage = await buyer.newPage();

		// 1. Signed-in guest with no grants sees guest landing page and cannot view lists or admin routes
		await buyerPage.goto(origin + '/');
		await expect(buyerPage).toHaveURL(origin + '/login');
		await expect(buyerPage.getByText('You are signed in as a guest.')).toBeVisible();
		await expect(buyerPage.getByRole('button', { name: 'Sign out' })).toBeVisible();
		await expect(buyerPage.getByRole('link', { name: 'Lists', exact: true })).toHaveCount(0);

		// 2. Super admin promotes `other` -> collaborator and `guest` -> site-wide buyer + list collaborator on Birthday
		await adminPage.goto(origin + '/settings/people');
		await expect(adminPage.getByRole('heading', { name: 'Super administrator' })).toBeVisible();
		await expect(adminPage.getByText('admin@example.test')).toBeVisible();

		const otherSection = adminPage
			.locator('section')
			.filter({ has: adminPage.getByRole('heading', { name: 'other', exact: true }) });
		await otherSection.getByLabel('Site-wide permission').selectOption('collaborator');
		await expect(otherSection.getByText('other@example.test · Collaborator')).toBeVisible();
		await expect(otherSection.getByLabel('Child · Birthday')).toHaveCount(0);

		const guestSection = adminPage
			.locator('section')
			.filter({ has: adminPage.getByRole('heading', { name: 'guest', exact: true }) });
		await guestSection.getByLabel('Site-wide permission').selectOption('buyer');
		await expect(guestSection.getByText('guest@example.test · Gift buyer')).toBeVisible();
		await guestSection.getByLabel('Child · Birthday').selectOption('contributor');
		await expect(guestSection.getByLabel('Child · Birthday')).toHaveValue('contributor');
		await saveScreenshot(adminPage, 'rbac-people-settings.png');

		// 3. Collaborator sees Lists, My gifts, Catalogue, Inbox, Add idea (and no admin settings), can edit any idea
		await collabPage.goto(origin + '/lists');
		for (const label of ['Lists', 'My gifts', 'Catalogue', 'Inbox', 'Add idea'])
			await expect(collabPage.getByRole('link', { name: label, exact: true })).toBeVisible();
		for (const label of ['People', 'Identification', 'Server checks'])
			await expect(collabPage.getByRole('link', { name: label, exact: true })).toHaveCount(0);

		await collabPage.getByRole('link', { name: 'Catalogue', exact: true }).click();
		await expect(collabPage).toHaveURL(origin + '/catalogue');
		await expect(
			collabPage.getByRole('heading', { name: 'Wooden train', exact: true })
		).toBeVisible();
		await expect(
			collabPage.getByRole('heading', { name: 'Story book', exact: true })
		).toBeVisible();
		await expect(collabPage.getByLabel('Select Wooden train')).toBeVisible();
		await saveScreenshot(collabPage, 'rbac-collaborator-catalogue.png');

		await collabPage.getByRole('link', { name: 'Wooden train', exact: true }).click();
		await expect(collabPage.getByRole('button', { name: 'Edit idea', exact: true })).toBeVisible();
		await collabPage.getByRole('button', { name: 'Edit idea', exact: true }).click();
		await collabPage.getByLabel('Description', { exact: true }).fill('Beechwood starter set');
		await collabPage.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(collabPage.getByText('Changes saved.')).toBeVisible();
		await expect(collabPage.getByText('Beechwood starter set')).toBeVisible();
		expect((await collaborator.request.get(origin + '/api/people')).status()).toBe(403);

		// 4. Site-wide buyer + list collaborator on Birthday:
		await buyerPage.goto(origin + '/');
		await expect(buyerPage).toHaveURL(origin + '/lists');
		await expect(buyerPage.getByRole('link', { name: 'Catalogue', exact: true })).toHaveCount(0);
		for (const label of ['Lists', 'My gifts', 'Inbox', 'Add idea'])
			await expect(buyerPage.getByRole('link', { name: label, exact: true })).toBeVisible();

		// On Christmas (`secret`), buyer can buy and add ideas, cannot remove admin's Story book
		await buyerPage.goto(origin + '/lists/secret');
		const storyCard = buyerPage
			.getByRole('article')
			.filter({ has: buyerPage.getByRole('heading', { name: 'Story book', exact: true }) });
		await expect(storyCard.getByRole('button', { name: 'Remove from list' })).toHaveCount(0);
		await expect(
			storyCard.getByRole('button', { name: 'Reserve for me', exact: true })
		).toBeEnabled();
		await storyCard.getByRole('button', { name: 'Reserve for me', exact: true }).click();
		await expect(storyCard.getByText('Reserved', { exact: true })).toBeVisible();
		await storyCard.getByRole('button', { name: 'Mark purchased', exact: true }).click();
		await expect(storyCard.getByText('Purchased', { exact: true })).toBeVisible();

		// Buyer adds own idea to Birthday and Christmas and can edit it (while Christmas membership stays locked)
		await buyerPage.goto(origin + '/capture?list=secret');
		await buyerPage.getByLabel('Title', { exact: true }).fill('Buyer craft kit');
		await buyerPage.locator('input[type=checkbox][value=visible]').check();
		await buyerPage.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(buyerPage.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		await buyerPage.getByRole('link', { name: 'View idea', exact: true }).click();
		await expect(buyerPage.getByRole('button', { name: 'Edit idea', exact: true })).toBeVisible();
		await buyerPage.getByRole('button', { name: 'Edit idea', exact: true }).click();
		await expect(buyerPage.locator('input[type=checkbox][value=secret]')).toBeDisabled();
		await expect(buyerPage.locator('input[type=checkbox][value=visible]')).toBeEnabled();
		await buyerPage.getByLabel('Title', { exact: true }).fill('Buyer craft kit updated');
		await buyerPage.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(buyerPage.getByText('Buyer craft kit updated')).toBeVisible();

		// Buyer cannot edit admin's Wooden train, yet with Birthday list collaborator can remove it from Birthday without deleting from catalogue
		await buyerPage.goto(origin + '/lists/visible');
		const trainCard = buyerPage
			.getByRole('article')
			.filter({ has: buyerPage.getByRole('heading', { name: 'Wooden train', exact: true }) });
		await expect(
			trainCard.getByRole('button', { name: 'Remove from list', exact: true })
		).toBeEnabled();
		await saveScreenshot(buyerPage, 'rbac-buyer-list-collaborator.png');

		await buyerPage.goto(origin + '/products/train');
		await expect(buyerPage.getByRole('button', { name: 'Edit idea', exact: true })).toHaveCount(0);

		await buyerPage.goto(origin + '/lists/visible');
		await trainCard.getByRole('button', { name: 'Remove from list', exact: true }).click();
		await expect(buyerPage.getByRole('heading', { name: 'Wooden train', exact: true })).toHaveCount(
			0
		);

		// Wooden train stays in catalogue (unlisted) and appears in admin's catalogue
		await adminPage.goto(origin + '/catalogue?unlisted=1');
		await expect(
			adminPage.getByRole('heading', { name: 'Wooden train', exact: true })
		).toBeVisible();
		const db = new Database(join(directory, 'test.sqlite'), { readonly: true });
		try {
			expect(db.prepare("SELECT deleted_at FROM products WHERE id='train'").get()).toEqual({
				deleted_at: null
			});
		} finally {
			db.close();
		}

		// 5. Promote `other` to site-wide Administrator and verify self-demotion guard & full access; demote `guest` to no-access guest
		await adminPage.goto(origin + '/settings/people');
		await otherSection.getByLabel('Site-wide permission').selectOption('administrator');
		await expect(otherSection.getByText('other@example.test · Administrator')).toBeVisible();

		await collabPage.goto(origin + '/settings/people');
		await expect(collabPage.getByRole('heading', { name: 'People and invitations' })).toBeVisible();
		const selfSection = collabPage
			.locator('section')
			.filter({ has: collabPage.getByRole('heading', { name: 'other', exact: true }) });
		await expect(selfSection.getByLabel('Site-wide permission')).toBeDisabled();

		await adminPage.goto(origin + '/settings/people');
		await guestSection.getByLabel('Site-wide permission').selectOption('guest');
		await guestSection.getByLabel('Child · Birthday').selectOption('');
		await buyerPage.goto(origin + '/capture');
		await expect(
			buyerPage.getByRole('heading', { name: 'Contributor access needed', exact: true })
		).toBeVisible();
	} finally {
		await Promise.all([admin.close(), collaborator.close(), buyer.close()]);
	}
});
