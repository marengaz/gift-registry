import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { makeSignature } from 'better-auth/crypto';
import Database from 'better-sqlite3';
import { fixture } from '../integration/identity-fixture';

const origin = 'http://localhost:4203';
const secret = 'test-only-list-lifecycle-58d1a4a9b937';
let directory: string;
let server: ChildProcess;
let proxy: Server;
let stallNextBody = false;
const proxySockets = new Set<Socket>();

function trackSocket(socket: Socket) {
	if (proxySockets.has(socket)) return;
	proxySockets.add(socket);
	socket.once('close', () => proxySockets.delete(socket));
}

test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'gift-list-lifecycle-'));
	const model = fixture();
	model.connection.sqlite
		.exec(`INSERT INTO household_members(user_id,google_subject,accepted_at) VALUES ('guest','google-guest',1),('other','google-other',1);
		INSERT INTO grants(user_id,list_id,role) VALUES ('guest','visible','buyer');
		INSERT INTO products(id,title,contributor_id) VALUES ('birthday-gift','Birthday gift','admin');
		INSERT INTO entries(id,product_id,list_id,state,buyer_id,allocation_source,allocated_by_id) VALUES ('birthday-entry','birthday-gift','visible','allocated','guest','self','guest');`);
	await model.connection.sqlite.backup(join(directory, 'test.sqlite'));
	model.connection.close();
	server = spawn(process.execPath, ['build/index.js'], {
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: '4204',
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
	proxy = createServer((incoming, outgoing) => {
		let upstreamFinished = false;
		const upstream = request(
			{
				hostname: '127.0.0.1',
				port: 4204,
				method: incoming.method,
				path: incoming.url,
				headers: incoming.headers
			},
			(response) => {
				response.on('end', () => (upstreamFinished = true));
				response.on('error', () => outgoing.destroy());
				if (
					stallNextBody &&
					incoming.method === 'DELETE' &&
					incoming.url === '/api/lists/body' &&
					response.statusCode === 200
				) {
					stallNextBody = false;
					const headers = { ...response.headers };
					delete headers['content-length'];
					delete headers['transfer-encoding'];
					delete headers['content-encoding'];
					outgoing.writeHead(200, headers);
					outgoing.flushHeaders();
					outgoing.write('{"administratorId":');
					// Drain the real committed reply, but leave its browser-facing body unfinished.
					response.resume();
				} else {
					outgoing.writeHead(response.statusCode ?? 502, response.headers);
					response.pipe(outgoing);
				}
			}
		);
		upstream.on('socket', trackSocket);
		upstream.on('error', () => {
			if (outgoing.headersSent) outgoing.destroy();
			else outgoing.writeHead(502).end('The fixture app is unavailable.');
		});
		incoming.on('aborted', () => upstream.destroy());
		incoming.on('error', () => upstream.destroy());
		outgoing.on('close', () => {
			if (!upstreamFinished) upstream.destroy();
		});
		incoming.pipe(upstream);
	});
	proxy.on('connection', trackSocket);
	await new Promise<void>((resolve, reject) => {
		proxy.once('error', reject);
		proxy.listen(4203, '127.0.0.1', () => {
			proxy.off('error', reject);
			resolve();
		});
	});
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(origin + '/login')).ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(output || 'List lifecycle test server did not start.');
});
test.afterAll(async () => {
	if (proxy?.listening) {
		const closed = new Promise<void>((resolve) => proxy.close(() => resolve()));
		for (const socket of proxySockets) socket.destroy();
		await closed;
	}
	if (server && server.exitCode === null) {
		server.kill('SIGTERM');
		await new Promise<void>((resolve) => server.once('exit', () => resolve()));
	}
	rmSync(directory, { recursive: true, force: true });
});
async function signIn(context: BrowserContext, actor = 'admin') {
	const token = `token-${actor}`;
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

function database<T>(work: (db: Database.Database) => T): T {
	const db = new Database(join(directory, 'test.sqlite'));
	try {
		return work(db);
	} finally {
		db.close();
	}
}
function seed(id: string, mixed = false) {
	database((db) => {
		db.prepare('INSERT INTO recipients(id,name) VALUES (?,?)').run(id, `Recipient ${id}`);
		db.prepare('INSERT INTO lists(id,recipient_id,name,occasion) VALUES (?,?,?,?)').run(
			id,
			id,
			`Ideas ${id}`,
			'Birthday'
		);
		db.prepare('INSERT INTO products(id,title,contributor_id) VALUES (?,?,?)').run(
			`${id}-unique`,
			`Unique ${id}`,
			'guest'
		);
		db.prepare('INSERT INTO entries(id,product_id,list_id) VALUES (?,?,?)').run(
			`${id}-entry`,
			`${id}-unique`,
			id
		);
		if (mixed) {
			for (const suffix of ['shared', 'hidden']) {
				db.prepare(
					'INSERT INTO lists(id,recipient_id,name,occasion,archived_at) VALUES (?,?,?,?,?)'
				).run(`${id}-${suffix}`, id, suffix, suffix, suffix === 'hidden' ? 1 : null);
				db.prepare('INSERT INTO products(id,title,contributor_id) VALUES (?,?,?)').run(
					`${id}-${suffix}`,
					`${suffix} ${id}`,
					'admin'
				);
				for (const listId of [id, `${id}-${suffix}`])
					db.prepare('INSERT INTO entries(id,product_id,list_id) VALUES (?,?,?)').run(
						`${listId}-${suffix}-entry`,
						`${id}-${suffix}`,
						listId
					);
			}
			db.prepare('INSERT INTO products(id,title,contributor_id) VALUES (?,?,?)').run(
				`${id}-unlisted`,
				`Unlisted ${id}`,
				'admin'
			);
		}
	});
}
async function openDelete(page: Page, id: string) {
	await page
		.getByRole('button', { name: `Delete Ideas ${id} for Recipient ${id}`, exact: true })
		.click();
	const dialog = page.getByRole('dialog', {
		name: `Delete Ideas ${id} for Recipient ${id}?`,
		exact: true
	});
	await expect(dialog.getByRole('button', { name: 'Delete list', exact: true })).toBeEnabled();
	return dialog;
}

test('administrator can hide a list directly from its card and show all-hidden lists again', async ({
	page,
	context,
	browser
}) => {
	await signIn(context);
	await page.goto(origin + '/lists');
	await expect(
		page.getByRole('button', { name: 'Hide Birthday for Child', exact: true })
	).toBeVisible();
	const relative = await browser.newContext();
	await signIn(relative, 'guest');
	expect((await relative.request.get(origin + '/api/lists/visible')).ok()).toBe(true);
	await page.getByRole('button', { name: 'Hide Birthday for Child', exact: true }).click();
	await expect(page.getByRole('link', { name: /Birthday.*Child|Child.*Birthday/ })).toHaveCount(0);
	expect((await relative.request.get(origin + '/api/lists/visible')).status()).toBe(404);
	await page.getByRole('button', { name: 'Hide Christmas for Child', exact: true }).click();
	await expect(
		page.getByRole('heading', { name: 'All your lists are hidden', exact: true })
	).toBeVisible();
	await page.getByRole('checkbox', { name: 'Show hidden lists', exact: true }).check();
	await page.getByRole('button', { name: 'Show Birthday for Child', exact: true }).click();
	await expect(
		page.getByRole('button', { name: 'Hide Birthday for Child', exact: true })
	).toBeEnabled();
	expect((await relative.request.get(origin + '/api/lists/visible')).ok()).toBe(true);
	expect(
		database((db) =>
			db.prepare('SELECT state,buyer_id FROM entries WHERE id=?').get('birthday-entry')
		)
	).toEqual({ state: 'allocated', buyer_id: 'guest' });
	await relative.close();
});

test('keeps ideas by default, cleans up only newly unlisted ideas and preserves catalogue Undo', async ({
	page,
	context,
	browser
}) => {
	seed('keep', true);
	seed('cleanup', true);
	await signIn(context);
	expect(
		(
			await context.request.patch(origin + '/api/lists/cleanup', {
				headers: { origin },
				data: { archived: true }
			})
		).ok()
	).toBe(true);
	const added = await context.request.post(origin + '/api/catalogue-actions', {
		headers: { origin },
		data: {
			operationId: crypto.randomUUID(),
			kind: 'add',
			productIds: ['keep-unlisted'],
			listIds: ['visible']
		}
	});
	expect(added.ok()).toBe(true);
	const undoBefore = (await added.json()).undo;
	await page.goto(origin + '/lists');
	let dialog = await openDelete(page, 'keep');
	await expect(dialog).toContainText('3 ideas');
	await expect(dialog).toContainText('Keep ideas');
	await expect(
		dialog.getByRole('checkbox', { name: 'Delete ideas left on no other list (1)', exact: true })
	).not.toBeChecked();
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.locator('.list-lifecycle-status')).toBeFocused();
	await expect(page.locator('.list-lifecycle-status')).toContainText('3 ideas kept');
	await expect(page.locator('.list-lifecycle-status')).not.toContainText(/undo/i);
	expect((await context.request.get(origin + '/api/products/keep-unique')).ok()).toBe(true);
	const author = await browser.newContext();
	await signIn(author, 'guest');
	const inbox = await (await author.request.get(origin + '/api/products?inbox=1')).json();
	expect(inbox.products.map((product: { id: string }) => product.id)).toContain('keep-unique');
	await author.close();
	await page.getByRole('checkbox', { name: 'Show hidden lists', exact: true }).check();
	dialog = await openDelete(page, 'cleanup');
	await dialog
		.getByRole('checkbox', { name: 'Delete ideas left on no other list (1)', exact: true })
		.check();
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	await expect(dialog).toBeHidden();
	for (const suffix of ['shared', 'hidden', 'unlisted'])
		expect((await context.request.get(origin + `/api/products/cleanup-${suffix}`)).ok()).toBe(true);
	expect((await context.request.get(origin + '/api/products/cleanup-unique')).status()).toBe(404);
	const status = await (await context.request.get(origin + '/api/catalogue-actions')).json();
	expect(status.undo.actionId).toBe(undoBefore.actionId);
	await page.goto(origin + '/catalogue');
	await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Undo last action', exact: true })).toBeDisabled();
	expect((await context.request.get(origin + '/api/lists/keep')).status()).toBe(404);
});

test('names the confirmation, contains keyboard focus and cancels without navigating or writing', async ({
	page,
	context
}) => {
	seed('keyboard');
	await signIn(context);
	await page.goto(origin + '/lists');
	const trigger = page.getByRole('button', {
		name: 'Delete Ideas keyboard for Recipient keyboard',
		exact: true
	});
	const dialog = await openDelete(page, 'keyboard');
	await expect(page).toHaveURL(origin + '/lists');
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(dialog.getByRole('button', { name: 'Delete list', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(dialog.getByRole('checkbox')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
	expect((await context.request.get(origin + '/api/lists/keyboard')).ok()).toBe(true);
	expect(
		database((db) =>
			db
				.prepare('SELECT COUNT(*) AS count FROM list_deletion_receipts WHERE list_id=?')
				.get('keyboard')
		)
	).toEqual({ count: 0 });
	await openDelete(page, 'keyboard');
	await page.screenshot({
		path: test.info().outputPath('gift-list-delete-desktop.png'),
		fullPage: true
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect
		.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
		.toBe(true);
	await page.screenshot({
		path: test.info().outputPath('gift-list-delete-mobile.png'),
		fullPage: true
	});
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	await page.screenshot({ path: test.info().outputPath('gift-lists-mobile.png'), fullPage: true });
});

test('requires deliberate fresh confirmation after buying and membership change without resetting cleanup', async ({
	page,
	context
}) => {
	seed('changed', true);
	await signIn(context);
	await page.goto(origin + '/lists');
	const dialog = await openDelete(page, 'changed');
	await dialog
		.getByRole('checkbox', { name: 'Delete ideas left on no other list (1)', exact: true })
		.check();
	const allocation = await context.request.post(origin + '/api/entries/changed-entry/allocation', {
		headers: { origin },
		data: { actionId: crypto.randomUUID(), action: 'assign', expectedVersion: 0, buyerId: 'admin' }
	});
	expect(allocation.ok()).toBe(true);
	database((db) =>
		db
			.prepare('INSERT INTO entries(id,product_id,list_id) VALUES (?,?,?)')
			.run('changed-new-membership', 'changed-unique', 'visible')
	);
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	await expect(dialog).toContainText('This list changed');
	await expect(dialog).toContainText('1 reserved or assigned gift');
	await expect(
		dialog.getByRole('checkbox', { name: 'Delete ideas left on no other list (0)', exact: true })
	).toBeChecked();
	expect((await context.request.get(origin + '/api/lists/changed')).ok()).toBe(true);
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	await expect(dialog).toBeHidden();
	expect((await context.request.get(origin + '/api/products/changed-unique')).ok()).toBe(true);
});

test('recovers a committed deletion after reload with its card absent and retries the identical command', async ({
	page,
	context
}) => {
	seed('lost');
	await signIn(context);
	await page.goto(origin + '/lists');
	const requests: string[] = [];
	await page.route('**/api/lists/lost', async (route) => {
		if (route.request().method() !== 'DELETE') return route.continue();
		requests.push(route.request().postData()!);
		if (requests.length === 1) {
			expect((await route.fetch()).ok()).toBe(true);
			await route.abort('failed');
		} else await route.continue();
	});
	let dialog = await openDelete(page, 'lost');
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	await expect(
		dialog.getByRole('button', { name: 'Retry last request', exact: true })
	).toBeEnabled();
	await page.reload();
	dialog = page.getByRole('dialog', { name: 'Delete Ideas lost for Recipient lost?', exact: true });
	await expect(dialog).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Delete Ideas lost for Recipient lost', exact: true })
	).toHaveCount(0);
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
	await dialog.getByRole('button', { name: 'Retry last request', exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(requests).toHaveLength(2);
	expect(requests[1]).toBe(requests[0]);
	expect(
		database((db) =>
			db.prepare('SELECT COUNT(*) AS count FROM list_deletion_receipts WHERE list_id=?').get('lost')
		)
	).toEqual({ count: 1 });
	await expect(page.locator('.list-lifecycle-status')).toBeFocused();
});

test('bounds stalled requests and stalled response bodies while preserving committed commands', async ({
	page,
	context
}) => {
	seed('stalled');
	seed('body');
	await signIn(context);
	await page.clock.install();
	await page.goto(origin + '/lists');
	const requests: string[] = [];
	let committed!: () => void;
	const firstCommit = new Promise<void>((resolve) => (committed = resolve));
	await page.route('**/api/lists/stalled', async (route) => {
		if (route.request().method() !== 'DELETE') return route.continue();
		requests.push(route.request().postData()!);
		if (requests.length === 1) {
			expect((await route.fetch()).ok()).toBe(true);
			committed();
			return;
		}
		await route.continue();
	});
	let dialog = await openDelete(page, 'stalled');
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	await firstCommit;
	await page.clock.fastForward(13_000);
	await expect(
		dialog.getByRole('button', { name: 'Retry last request', exact: true })
	).toBeEnabled();
	await dialog.getByRole('button', { name: 'Retry last request', exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(requests[1]).toBe(requests[0]);
	stallNextBody = true;
	dialog = await openDelete(page, 'body');
	const sent: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'DELETE' && request.url().endsWith('/api/lists/body'))
			sent.push(request.postData()!);
	});
	const bodyHeaders = page.waitForResponse(
		(response) =>
			response.url() === origin + '/api/lists/body' &&
			response.request().method() === 'DELETE' &&
			response.status() === 200
	);
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	await bodyHeaders;
	await expect
		.poll(async () => (await context.request.get(origin + '/api/lists/body')).status())
		.toBe(404);
	await page.clock.fastForward(13_000);
	await expect(
		dialog.getByRole('button', { name: 'Retry last request', exact: true })
	).toBeEnabled();
	await dialog.getByRole('button', { name: 'Retry last request', exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toBe(sent[0]);
});

test('retains unreadable and unauthorised replies and scopes saved commands to the verified administrator', async ({
	page,
	context
}) => {
	seed('replies');
	await signIn(context);
	await page.goto(origin + '/lists');
	const bodies: string[] = [];
	let attempt = 0;
	await page.route('**/api/lists/replies', async (route) => {
		if (route.request().method() !== 'DELETE') return route.continue();
		bodies.push(route.request().postData()!);
		attempt++;
		if (attempt === 1)
			return route.fulfill({ status: 200, contentType: 'text/html', body: 'Unreadable reply' });
		if (attempt === 2)
			return route.fulfill({ status: 401, contentType: 'text/html', body: 'Sign in' });
		if (attempt === 3)
			return route.fulfill({
				json: {
					administratorId: 'other',
					listId: 'replies',
					operationId: JSON.parse(bodies[0]).operationId,
					deleteOrphans: false,
					productCount: 1,
					deletedProductCount: 0,
					keptProductCount: 1
				}
			});
		await route.continue();
	});
	let dialog = await openDelete(page, 'replies');
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	await expect(dialog).toContainText('unreadable confirmation');
	await dialog.getByRole('button', { name: 'Retry last request', exact: true }).click();
	await expect(dialog.getByRole('link', { name: 'Sign in again', exact: true })).toBeVisible();
	await dialog.getByRole('button', { name: 'Retry last request', exact: true }).click();
	await expect(dialog).toContainText('does not confirm the saved request');
	database((db) =>
		db
			.prepare('UPDATE application_settings SET administrator_id=?, administrator_google_subject=?')
			.run('other', 'google-other')
	);
	await signIn(context, 'other');
	await page.reload();
	await expect(
		page.getByRole('button', { name: 'Delete Ideas replies for Recipient replies', exact: true })
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Retry last request', exact: true })).toHaveCount(
		0
	);
	expect(bodies).toHaveLength(3);
	database((db) =>
		db
			.prepare('UPDATE application_settings SET administrator_id=?, administrator_google_subject=?')
			.run('admin', 'google-admin')
	);
	await signIn(context);
	await page.reload();
	dialog = page.getByRole('dialog', {
		name: 'Delete Ideas replies for Recipient replies?',
		exact: true
	});
	await dialog.getByRole('button', { name: 'Retry last request', exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(bodies).toHaveLength(4);
	expect(new Set(bodies).size).toBe(1);
});

test('relative cards retain ordinary navigation and expose no administrative list controls', async ({
	page,
	context
}) => {
	await signIn(context, 'guest');
	await page.goto(origin + '/lists');
	await expect(page.getByRole('checkbox', { name: 'Show hidden lists', exact: true })).toHaveCount(
		0
	);
	await expect(page.getByRole('button', { name: /^(Hide|Show|Delete) / })).toHaveCount(0);
	const open = page.getByRole('link', { name: /Birthday.*Child|Child.*Birthday/ });
	await expect(open).toBeVisible();
	await open.click();
	await expect(page).toHaveURL(origin + '/lists/visible');
});

test('detail-page visibility retries remain attached to the original list after membership navigation', async ({
	page,
	context
}) => {
	seed('detail-navigation', true);
	await signIn(context);
	await page.goto(origin + '/lists/detail-navigation');
	const sent: { url: string; body: string }[] = [];
	await page.route('**/api/lists/*', async (route) => {
		if (route.request().method() !== 'PATCH') return route.continue();
		sent.push({ url: route.request().url(), body: route.request().postData()! });
		if (sent.length === 1) return route.abort('failed');
		await route.continue();
	});
	await page.getByRole('button', { name: 'Hide list', exact: true }).click();
	await expect(page.getByRole('button', { name: /Retry/ })).toBeEnabled();
	await page
		.getByRole('link', { name: 'Recipient detail-navigation · shared', exact: true })
		.click();
	await expect(page).toHaveURL(origin + '/lists/detail-navigation-shared');
	await expect(page.locator('.list-lifecycle-status')).toContainText(
		'Unconfirmed request: Hide Ideas detail-navigation for Recipient detail-navigation.'
	);
	await page.getByRole('button', { name: /Retry/ }).click();
	await expect.poll(() => sent.length).toBe(2);
	expect(sent[1]).toEqual(sent[0]);
	expect(
		database((db) =>
			db.prepare('SELECT archived_at FROM lists WHERE id=?').get('detail-navigation-shared')
		)
	).toEqual({ archived_at: null });
	await expect(page.getByRole('button', { name: 'Hide list', exact: true })).toBeEnabled();
});

test('detail-page visibility recovers its saved absolute change after reload and return to all lists', async ({
	page,
	context
}) => {
	seed('detail-reload');
	await signIn(context);
	await page.goto(origin + '/lists/detail-reload');
	const bodies: string[] = [];
	await page.route('**/api/lists/detail-reload', async (route) => {
		if (route.request().method() !== 'PATCH') return route.continue();
		bodies.push(route.request().postData()!);
		if (bodies.length === 1) {
			expect((await route.fetch()).ok()).toBe(true);
			return route.fulfill({ status: 408, json: { message: 'Intermediary timeout' } });
		}
		await route.continue();
	});
	await page.getByRole('button', { name: 'Hide list', exact: true }).click();
	await expect(page.getByRole('button', { name: /Retry/ })).toBeEnabled();
	await page.reload();
	await expect(page.getByRole('button', { name: /Retry/ })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Show list', exact: true })).toBeDisabled();
	await page.getByRole('link', { name: '← All lists', exact: true }).click();
	await page.getByRole('button', { name: 'Retry last request', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Retry last request', exact: true })).toHaveCount(
		0
	);
	expect(bodies).toEqual([JSON.stringify({ archived: true }), JSON.stringify({ archived: true })]);
	expect(
		(await (await context.request.get(origin + '/api/lists/detail-reload')).json()).list.archivedAt
	).not.toBeNull();
});

test('unrecognised JSON client errors retain committed deletions for identical receipt recovery', async ({
	page,
	context
}) => {
	await signIn(context);
	for (const [index, status] of [408, 404, 429, 409, 404].entries()) {
		const id = `json-${status}-${index}`;
		seed(id);
		await page.goto(origin + '/lists');
		const bodies: string[] = [];
		await page.route(`**/api/lists/${id}`, async (route) => {
			if (route.request().method() !== 'DELETE') return route.continue();
			bodies.push(route.request().postData()!);
			if (bodies.length === 1) {
				expect((await route.fetch()).ok()).toBe(true);
				return route.fulfill({
					status,
					json:
						index === 4
							? {
									reason: 'list-unavailable',
									administratorId: 'admin',
									listId: id,
									operationId: crypto.randomUUID()
								}
							: status === 409
								? { reason: 'refresh-impact', impact: {} }
								: { message: 'Intermediary error' }
				});
			}
			await route.continue();
		});
		let dialog = await openDelete(page, id);
		await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
		await expect(
			dialog.getByRole('button', { name: 'Retry last request', exact: true })
		).toBeEnabled();
		await page.reload();
		dialog = page.getByRole('dialog', {
			name: `Delete Ideas ${id} for Recipient ${id}?`,
			exact: true
		});
		await dialog.getByRole('button', { name: 'Retry last request', exact: true }).click();
		await expect(dialog).toBeHidden();
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toBe(bodies[0]);
		expect(
			database((db) =>
				db.prepare('SELECT COUNT(*) AS count FROM list_deletion_receipts WHERE list_id=?').get(id)
			)
		).toEqual({ count: 1 });
	}
});

test('deletion confirmation names follow the validated preview and changed-impact response', async ({
	page,
	context
}) => {
	seed('renamed');
	await signIn(context);
	await page.goto(origin + '/lists');
	const rename = (suffix: string) =>
		database((db) => {
			db.prepare('UPDATE lists SET name=? WHERE id=?').run(`Ideas ${suffix}`, 'renamed');
			db.prepare('UPDATE recipients SET name=? WHERE id=?').run(`Recipient ${suffix}`, 'renamed');
		});
	rename('current');
	await page
		.getByRole('button', { name: 'Delete Ideas renamed for Recipient renamed', exact: true })
		.click();
	let dialog = page.getByRole('dialog', {
		name: 'Delete Ideas current for Recipient current?',
		exact: true
	});
	await expect(dialog.getByRole('button', { name: 'Delete list', exact: true })).toBeEnabled();
	rename('reviewed');
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	dialog = page.getByRole('dialog', {
		name: 'Delete Ideas reviewed for Recipient reviewed?',
		exact: true
	});
	await expect(dialog).toContainText('This list changed');
	expect((await context.request.get(origin + '/api/lists/renamed')).ok()).toBe(true);
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.locator('.list-lifecycle-status')).toContainText(
		'Ideas reviewed for Recipient reviewed deleted'
	);
});

test('a recognised non-commit reply releases a deletion superseded by another operation', async ({
	page,
	context
}) => {
	seed('superseded');
	await signIn(context);
	await page.goto(origin + '/lists');
	const dialog = await openDelete(page, 'superseded');
	const impact = await (
		await context.request.get(origin + '/api/lists/superseded/deletion-impact')
	).json();
	expect(
		(
			await context.request.delete(origin + '/api/lists/superseded', {
				headers: { origin },
				data: {
					operationId: crypto.randomUUID(),
					deleteOrphans: false,
					impactFingerprint: impact.fingerprint
				}
			})
		).ok()
	).toBe(true);
	await dialog.getByRole('button', { name: 'Delete list', exact: true }).click();
	await expect(dialog).toContainText('This list is no longer available');
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
	await expect(dialog.getByRole('button', { name: 'Retry last request', exact: true })).toHaveCount(
		0
	);
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	await page.reload();
	await expect(page.getByRole('dialog')).toHaveCount(0);
});
