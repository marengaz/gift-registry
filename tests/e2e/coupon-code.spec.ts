import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import { fixture } from '../integration/identity-fixture';

const origin = 'http://localhost:4207';
const secret = 'test-only-random-secret-coupon-code-123456';
let server: ChildProcess;
let quidcoServer: Server;
let directory: string;
let serverOutput = '';

test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-coupon-e2e-'));
	quidcoServer = createServer((req, res) => {
		if (req.url === '/merchants.json') {
			res.writeHead(200, { 'content-type': 'application/json', etag: '"e2e-v1"' });
			res.end(
				JSON.stringify({
					excluded_subdomains: ['news.sky.com'],
					merchants: [
						{
							id: '296',
							name: 'Boots',
							domain: 'boots.com',
							reward: 'Up to 3.75% cashback',
							url: 'https://www.quidco.com/boots/'
						},
						{
							id: '100',
							name: 'Currys',
							domain: 'currys.co.uk',
							reward: 'Up to 18.75% / £75 cashback',
							url: 'https://www.quidco.com/currys/'
						}
					]
				})
			);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => quidcoServer.listen(0, '127.0.0.1', resolve));
	const address = quidcoServer.address();
	const quidcoPort = typeof address === 'object' && address ? address.port : 0;

	const context = fixture();
	await context.connection.sqlite.backup(join(directory, 'test.sqlite'));
	context.connection.close();

	server = spawn(process.execPath, ['scripts/start.mjs'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4207',
			PROTOCOL_HEADER: 'x-forwarded-proto',
			ORIGIN: origin,
			DATABASE_PATH: join(directory, 'test.sqlite'),
			MEDIA_PATH: join(directory, 'media'),
			BETTER_AUTH_SECRET: secret,
			GOOGLE_CLIENT_ID: 'test-google-client',
			GOOGLE_CLIENT_SECRET: 'test-provider-secret',
			ADMINISTRATOR_EMAIL: 'admin@example.test',
			QUIDCO_MERCHANTS_URL: `http://127.0.0.1:${quidcoPort}/merchants.json`
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
	await new Promise<void>((resolve) => quidcoServer.close(() => resolve()));
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

test('auto-populates Quidco cashback when a merchant link is entered and allows manual voucher override', async ({
	page,
	context
}) => {
	await context.setExtraHTTPHeaders({ 'x-forwarded-proto': 'http' });
	await signIn(context, 'admin');
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));

	// 1. Auto-populate from Quidco merchant link
	await page.goto(origin + '/capture');
	const linkInput = page.getByLabel('Product link');
	const couponInput = page.getByLabel('Coupon or cashback code');
	const titleInput = page.getByLabel('Title');

	await linkInput.fill('https://www.boots.com/lego-set-123');
	await expect(couponInput).toHaveValue('Quidco: Up to 3.75% cashback', { timeout: 5000 });
	await expect(page.getByText('Auto-filled from Quidco for Boots.')).toBeVisible();

	// Changing to another Quidco merchant updates the auto-populated rate
	await linkInput.fill('https://www.currys.co.uk/headphones');
	await expect(couponInput).toHaveValue('Quidco: Up to 18.75% / £75 cashback', { timeout: 5000 });

	await titleInput.fill('Wireless headphones');
	await page.getByRole('checkbox', { name: /Child · Birthday/ }).check();
	await page.getByRole('button', { name: 'Save idea' }).click();
	await expect(page.getByRole('link', { name: 'View idea' })).toBeVisible({ timeout: 10000 });
	await page.getByRole('link', { name: 'View idea' }).click();

	await expect(page.getByText('Coupon / cashback:')).toBeVisible();
	await expect(page.getByText('Quidco: Up to 18.75% / £75 cashback')).toBeVisible();

	// Check it also appears on the list card
	await page.goto(origin + '/lists/visible');
	await expect(page.getByText('Quidco: Up to 18.75% / £75 cashback')).toBeVisible();

	// 2. Manual voucher override is never clobbered by Quidco lookup
	await page.goto(origin + '/capture');
	await linkInput.fill('https://www.boots.com/gift-set');
	await expect(couponInput).toHaveValue('Quidco: Up to 3.75% cashback', { timeout: 5000 });

	await couponInput.fill('SPRING20');
	await linkInput.fill('https://www.currys.co.uk/camera');
	await page.waitForTimeout(700);
	await expect(couponInput).toHaveValue('SPRING20');
	await expect(page.getByRole('link', { name: 'Check Quidco ↗' })).toHaveAttribute(
		'href',
		'https://www.quidco.com/search/?q=currys'
	);

	await titleInput.fill('Instant camera');
	await page.getByRole('checkbox', { name: /Child · Birthday/ }).check();
	await page.getByRole('button', { name: 'Save idea' }).click();
	await expect(page.getByRole('link', { name: 'View idea' })).toBeVisible({ timeout: 10000 });
	await page.getByRole('link', { name: 'View idea' }).click();
	await expect(page.getByText('SPRING20')).toBeVisible();

	// 3. Editing preserves existing manual voucher code, allows clearing, and does not refill cleared code
	await page.getByRole('button', { name: 'Edit idea' }).click();
	await page.waitForTimeout(700);
	await expect(page.getByLabel('Coupon or cashback code')).toHaveValue('SPRING20');
	await page.getByLabel('Coupon or cashback code').fill('SUMMER25');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByText('SUMMER25')).toBeVisible();

	await page.getByRole('button', { name: 'Edit idea' }).click();
	await page.getByLabel('Coupon or cashback code').fill('');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByText('Coupon / cashback:')).toHaveCount(0);

	// Reopening edit on an idea with a Quidco sourceUrl and empty couponCode must NOT silently refill it
	await page.getByRole('button', { name: 'Edit idea' }).click();
	await page.waitForTimeout(700);
	await expect(page.getByLabel('Coupon or cashback code')).toHaveValue('');

	// 4. Without a link, no Quidco lookup is attempted
	let quidcoRequests = 0;
	page.on('request', (req) => {
		if (req.url().includes('/api/quidco')) quidcoRequests++;
	});
	await page.goto(origin + '/capture');
	await titleInput.fill('Handmade scarf');
	await couponInput.fill('LOCAL10');
	await page.waitForTimeout(600);
	expect(quidcoRequests).toBe(0);

	expect(errors).toEqual([]);
});
