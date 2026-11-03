import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../integration/identity-fixture';

const origin = 'http://localhost:4196';
let directory: string;
let app: ChildProcess;
let proxy: Server;
let output = '';
const failures = new Map<string, number | 'stall' | 'body-stall'>();
const stalled = new Set<ServerResponse>();

test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-capture-fallback-'));
	const model = fixture();
	await model.connection.sqlite.backup(join(directory, 'gifts.sqlite'));
	model.connection.close();
	const socketPath = join(directory, 'app.sock');
	app = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			SOCKET_PATH: socketPath,
			ORIGIN: origin,
			BODY_SIZE_LIMIT: '64M',
			PROTOCOL_HEADER: 'x-forwarded-proto',
			DATABASE_PATH: join(directory, 'gifts.sqlite'),
			MEDIA_PATH: join(directory, 'media'),
			BETTER_AUTH_SECRET: 'test-only-fallback-secret-8d10a957acf165810',
			GOOGLE_CLIENT_ID: 'test-client',
			GOOGLE_CLIENT_SECRET: 'test-provider',
			ADMINISTRATOR_EMAIL: 'admin@example.test'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	app.stdout?.on('data', (chunk) => (output += chunk));
	app.stderr?.on('data', (chunk) => (output += chunk));
	for (let attempt = 0; !existsSync(socketPath); attempt++) {
		if (attempt >= 100) throw new Error('Fallback app did not start: ' + output);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	proxy = createServer((incoming, outgoing) => {
		const failure = failures.get(new URL(incoming.url!, origin).pathname);
		if (failure === 'stall' || failure === 'body-stall') {
			if (failure === 'body-stall') {
				outgoing.writeHead(200, { 'content-type': 'text/html' });
				outgoing.write('<!doctype html><html><body>');
			}
			stalled.add(outgoing);
			outgoing.on('close', () => stalled.delete(outgoing));
			return;
		}
		if (failure) {
			outgoing.writeHead(failure, { 'content-type': 'text/html' });
			outgoing.end(`<h1>Upstream ${failure}</h1>`);
			return;
		}
		const upstream = request(
			{ socketPath, path: incoming.url, method: incoming.method, headers: incoming.headers },
			(response) => {
				outgoing.writeHead(response.statusCode!, response.headers);
				response.pipe(outgoing);
			}
		);
		upstream.on('error', () => {
			outgoing.writeHead(502);
			outgoing.end();
		});
		incoming.pipe(upstream);
	});
	await new Promise<void>((resolve) => proxy.listen(4196, '127.0.0.1', resolve));
});
test.afterEach(() => {
	failures.clear();
	for (const response of stalled) response.destroy();
});
test.afterAll(async () => {
	if (proxy) {
		proxy.closeAllConnections();
		await new Promise<void>((resolve) => proxy.close(() => resolve()));
	}
	if (app && app.exitCode === null) {
		app.kill('SIGTERM');
		await new Promise<void>((resolve) => app.once('exit', () => resolve()));
	}
	rmSync(directory, { recursive: true, force: true });
});

for (const failure of [503, 'stall', 'body-stall'] as const) {
	test(`opens a saved local draft through the service worker during ${failure}`, async ({
		browser
	}) => {
		const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
		const page = await context.newPage();
		try {
			await page.goto(origin + '/capture');
			await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
			await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
			await page.waitForFunction(() => !!navigator.serviceWorker.controller);
			await context.setOffline(true);
			await page.getByLabel('Title', { exact: true }).fill('Kept during the server restart');
			await page.getByRole('button', { name: 'Save on this device', exact: true }).click();
			await expect(
				page.getByRole('heading', { name: 'Saved on this device', exact: true })
			).toBeVisible();
			const id = await page.evaluate(async () => {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const open = indexedDB.open('family-gift-captures');
					open.onsuccess = () => resolve(open.result);
					open.onerror = () => reject(open.error);
				});
				try {
					return await new Promise<string>((resolve, reject) => {
						const records = db.transaction('drafts').objectStore('drafts').getAll();
						records.onsuccess = () => resolve(records.result[0].id);
						records.onerror = () => reject(records.error);
					});
				} finally {
					db.close();
				}
			});
			await context.setOffline(false);
			failures.set('/capture', failure);
			const response = await page.goto(origin + '/capture?draft=' + id, { timeout: 8_000 });
			expect(response?.fromServiceWorker()).toBe(true);
			expect(response?.status()).toBe(200);
			await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
				'Kept during the server restart'
			);
		} finally {
			await context.close();
		}
	});
}

test('preserves access errors and protected-route server errors', async ({ browser }) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });
	const page = await context.newPage();
	try {
		await page.goto(origin + '/capture');
		await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
		await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
		await page.waitForFunction(() => !!navigator.serviceWorker.controller);
		for (const status of [403, 404]) {
			failures.set('/capture', status);
			const response = await page.goto(origin + '/capture');
			expect(response?.fromServiceWorker()).toBe(true);
			expect(response?.status()).toBe(status);
			await expect(page.getByRole('heading', { name: `Upstream ${status}` })).toBeVisible();
		}
		failures.set('/lists/visible', 503);
		const response = await page.goto(origin + '/lists/visible');
		expect(response?.fromServiceWorker()).toBe(true);
		expect(response?.status()).toBe(503);
		await expect(page.getByRole('heading', { name: 'Upstream 503' })).toBeVisible();
	} finally {
		await context.close();
	}
});
