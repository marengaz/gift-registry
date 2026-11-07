import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { makeSignature } from 'better-auth/crypto';
import sharp from 'sharp';
import { fixture } from '../integration/identity-fixture';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';
const origin = 'http://localhost:4193';
const secret = 'test-only-family-secret-8d10a957acf165810';
let directory: string;
let app: ChildProcess;
let worker: ChildProcess;
let output = '';
async function startProcesses() {
	const environment = {
		...process.env,
		HOST: '127.0.0.1',
		PORT: '4193',
		ORIGIN: origin,
		BODY_SIZE_LIMIT: '64M',
		PROTOCOL_HEADER: 'x-forwarded-proto',
		DATABASE_PATH: join(directory, 'gifts.sqlite'),
		MEDIA_PATH: join(directory, 'media'),
		BETTER_AUTH_SECRET: secret,
		GOOGLE_CLIENT_ID: 'test-google-client',
		GOOGLE_CLIENT_SECRET: 'test-provider',
		ADMINISTRATOR_EMAIL: 'admin@example.test',
		VISION_PROJECT_ID: '',
		VISION_CREDENTIALS_FILE: ''
	};
	app = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: environment,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	for (const stream of [app.stdout, app.stderr])
		stream?.on('data', (chunk) => {
			output += chunk;
		});
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(origin + '/health/live')).ok) {
				worker = spawn(process.execPath, ['build-worker/worker.js'], {
					cwd: process.cwd(),
					env: environment,
					stdio: ['ignore', 'pipe', 'pipe']
				});
				for (const stream of [worker.stdout, worker.stderr])
					stream?.on('data', (chunk) => {
						output += chunk;
					});
				return;
			}
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('Family test server did not start: ' + output);
}
async function stopProcesses() {
	for (const process of [worker, app]) {
		if (process && process.exitCode === null) {
			process.kill('SIGTERM');
			await new Promise<void>((resolve) => process.once('exit', () => resolve()));
		}
	}
}
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-family-browser-'));
	const model = fixture();
	const now = Date.now();
	model.connection.sqlite
		.prepare(
			'INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,1,?,?)'
		)
		.run('buyer', 'buyer', 'buyer@example.test', now, now);
	model.connection.sqlite
		.prepare(
			"INSERT INTO account(id,user_id,account_id,provider_id,created_at,updated_at) VALUES('buyer','buyer','google-buyer','google',?,?)"
		)
		.run(now, now);
	model.connection.sqlite
		.prepare(
			"INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) VALUES('session-buyer','buyer','token-buyer',?,?,?)"
		)
		.run(now + 3600000, now, now);
	for (const [id, role] of [
		['guest', 'contributor'],
		['buyer', 'buyer'],
		['other', 'viewer']
	] as const)
		acceptInvitation(
			model.connection,
			model.actor(id),
			createInvitation(model.connection, model.admin, {
				email: id + '@example.test',
				grants: [{ listId: 'visible', role }]
			}).token
		);
	model.connection.sqlite.exec(
		"INSERT INTO products(id,title,contributor_id) VALUES('cards','Box of cards','admin'); INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES('cards-entry','cards','visible',1200); INSERT INTO lookup_jobs(id,product_id,actor_id,actor_session_id,operation_id,fingerprint,kind,state,dispatched_at) VALUES('uncertain','cards','admin','session-admin','uncertain','uncertain','vision','uncertain',1); INSERT INTO allowance_reservations(job_id,month,amount_microdollars,pricing_revision,project_id) VALUES('uncertain','2026-11',3500,'test','personal-test')"
	);
	await model.connection.sqlite.backup(join(directory, 'gifts.sqlite'));
	model.connection.close();
	await startProcesses();
});
test.afterEach(async ({}, info) => {
	if (info.status !== info.expectedStatus) console.error(output);
});
test.afterAll(async () => {
	await stopProcesses();
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
test('retains family sessions, purchases, private photos and uncertain lookup charges across production process restart', async ({
	browser
}) => {
	test.setTimeout(60000);
	const admin = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	const contributor = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
	});
	const buyer = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	const viewer = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	try {
		for (const [context, id] of [
			[admin, 'admin'],
			[contributor, 'guest'],
			[buyer, 'buyer'],
			[viewer, 'other']
		] as const)
			await signIn(context, id);
		const manage = await admin.newPage(),
			capture = await contributor.newPage(),
			buy = await buyer.newPage(),
			view = await viewer.newPage();
		await capture.goto(origin + '/capture?list=visible');
		await capture.getByLabel('Title', { exact: true }).fill('Train to restart');
		await expect(capture.locator('input[type=checkbox][value=visible]')).toBeChecked();
		await capture.getByLabel('Estimated price (£)', { exact: true }).fill('20.00');
		const image = await sharp({
			create: { width: 12, height: 12, channels: 3, background: '#8ab' }
		})
			.png()
			.toBuffer();
		await capture
			.getByLabel('Photos')
			.setInputFiles({ name: 'train.png', mimeType: 'image/png', buffer: image });
		await capture.getByRole('button', { name: 'Save idea', exact: true }).click();
		await expect(capture.getByRole('heading', { name: 'Idea saved', exact: true })).toBeVisible();
		await capture.getByRole('link', { name: 'View idea', exact: true }).click();
		await expect(capture).toHaveURL(/\/products\/[^/]+$/);
		const productUrl = capture.url();
		await expect(capture.getByRole('img', { name: 'Train to restart', exact: true })).toBeVisible();
		await buy.goto(origin + '/lists/visible');
		const train = buy
			.getByRole('article')
			.filter({ has: buy.getByRole('heading', { name: 'Train to restart', exact: true }) });
		await expect(train.getByRole('button', { name: 'Reserve for me', exact: true })).toBeEnabled();
		await train.getByRole('button', { name: 'Reserve for me', exact: true }).click();
		await expect(train.getByText('Reserved', { exact: true })).toBeVisible();
		await manage.goto(origin + '/lists/visible');
		const cards = manage
			.getByRole('article')
			.filter({ has: manage.getByRole('heading', { name: 'Box of cards', exact: true }) });
		await expect(cards.getByLabel('Assign to')).toBeEnabled();
		await cards.getByLabel('Assign to').selectOption('other');
		await cards.getByRole('button', { name: 'Assign gift', exact: true }).click();
		await expect(cards.getByText('Assigned · other', { exact: true })).toBeVisible();
		await view.goto(origin + '/my-gifts');
		await expect(view.getByRole('heading', { name: 'Box of cards', exact: true })).toBeVisible();
		await expect(view.getByRole('heading', { name: 'Train to restart', exact: true })).toHaveCount(
			0
		);
		await expect(view.getByRole('button', { name: 'Mark purchased' })).toHaveCount(0);
		await buy.getByRole('link', { name: 'My gifts', exact: true }).click();
		await expect(buy).toHaveURL(origin + '/my-gifts');
		await buy.getByLabel('Actual GBP spend (optional)').fill('17.50');
		await buy.getByRole('button', { name: 'Mark purchased', exact: true }).click();
		await expect(buy.getByText('£17.50 · actual spend')).toBeVisible();
		await stopProcesses();
		await startProcesses();
		expect((await admin.request.get(origin + '/api/me')).status()).toBe(200);
		await buy.reload();
		await expect(train.getByText('Purchased', { exact: true })).toBeVisible();
		await expect(buy.getByText('£17.50 · actual spend')).toBeVisible();
		await view.reload();
		await expect(view.getByRole('heading', { name: 'Box of cards', exact: true })).toBeVisible();
		await expect(view.getByRole('heading', { name: 'Train to restart', exact: true })).toHaveCount(
			0
		);
		await capture.goto(productUrl);
		await expect(
			capture.getByRole('heading', { name: 'Train to restart', exact: true })
		).toHaveCount(0);
		await manage.goto(productUrl);
		const photo = manage.getByRole('img', { name: 'Train to restart', exact: true });
		await expect(photo).toBeVisible();
		const source = await photo.getAttribute('src');
		expect(source).toBeTruthy();
		const media = await admin.request.get(origin + source);
		expect(media.status()).toBe(200);
		expect(media.headers()['cache-control']).toContain('no-store');
		const db = new Database(join(directory, 'gifts.sqlite'), { readonly: true });
		try {
			expect(
				db.prepare("SELECT state,dispatched_at FROM lookup_jobs WHERE id='uncertain'").get()
			).toEqual({ state: 'uncertain', dispatched_at: 1 });
			expect(
				db.prepare('SELECT sum(amount_microdollars) AS total FROM allowance_reservations').get()
			).toEqual({ total: 3500 });
			expect(
				db.prepare("SELECT count(*) AS n FROM products WHERE title='Train to restart'").get()
			).toEqual({ n: 1 });
		} finally {
			db.close();
		}
		await manage.goto(origin + '/settings/diagnostics');
		await expect(manage.getByRole('heading', { name: 'Server checks', exact: true })).toBeVisible();
		await expect(
			manage.getByText('Incoming address matches the configured sign-in address: Yes')
		).toBeVisible();
		expect((await viewer.request.get(origin + '/api/diagnostics')).status()).toBe(403);
		const forbidden = await admin.request.post(origin + '/api/products', {
			headers: { origin: 'https://elsewhere.example.test' },
			data: { title: 'Forbidden', listIds: [] }
		});
		expect(forbidden.status()).toBe(403);
	} finally {
		await Promise.all([admin.close(), contributor.close(), buyer.close(), viewer.close()]);
	}
});
