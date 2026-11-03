import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './identity-fixture';
import { inspectReadiness, diagnosticsGet } from '../../src/lib/server/diagnostics';
import { createHandle } from '../../src/hooks.server';
import type { CatalogueEvent } from '../../src/lib/server/catalogue';
vi.mock('$app/env', () => ({ building: false }));
const environment = {
	ORIGIN: 'https://gifts.example.test',
	BETTER_AUTH_SECRET: 'test-only-secret-long-enough-for-configuration',
	GOOGLE_CLIENT_ID: 'test-client',
	GOOGLE_CLIENT_SECRET: 'test-provider',
	ADMINISTRATOR_EMAIL: 'admin@example.test',
	PROTOCOL_HEADER: 'x-forwarded-proto'
};
function event(
	actor: ReturnType<ReturnType<typeof fixture>['actor']> | null,
	origin = 'https://gifts.example.test'
): CatalogueEvent {
	const url = new URL(origin + '/api/diagnostics');
	return { url, request: new Request(url), locals: { actor } };
}
describe('operation readiness and private diagnostics', () => {
	it('checks real database and media access without contacting authentication or image providers', async () => {
		const model = fixture();
		const directory = await mkdtemp(join(tmpdir(), 'gift-health-'));
		try {
			expect(
				await inspectReadiness({
					database: () => model.connection,
					mediaPath: join(directory, 'media'),
					environment
				})
			).toEqual({ ready: true, database: true, media: true, authentication: true });
			await writeFile(join(directory, 'not-a-directory'), 'x');
			expect(
				await inspectReadiness({
					database: () => model.connection,
					mediaPath: join(directory, 'not-a-directory'),
					environment
				})
			).toMatchObject({ ready: false, database: true, media: false });
			expect(
				await inspectReadiness({
					database: () => {
						throw new Error('private database path');
					},
					mediaPath: join(directory, 'media'),
					environment: {}
				})
			).toEqual({ ready: false, database: false, media: true, authentication: false });
		} finally {
			model.connection.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it('restricts detailed diagnostics to the fresh administrator and reports proxy mismatch without secrets or records', async () => {
		const model = fixture();
		const directory = await mkdtemp(join(tmpdir(), 'gift-diagnostics-'));
		try {
			expect(
				(await diagnosticsGet(model.connection, event(null), { mediaPath: directory, environment }))
					.status
			).toBe(401);
			expect(
				(
					await diagnosticsGet(model.connection, event(model.actor('guest')), {
						mediaPath: directory,
						environment
					})
				).status
			).toBe(403);
			const response = await diagnosticsGet(
				model.connection,
				event(model.admin, 'http://localhost:4193'),
				{ mediaPath: directory, environment }
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toContain('no-store');
			const result = await response.json();
			expect(result.proxy).toEqual({ originMatches: false, forwardedProtocolConfigured: true });
			const text = JSON.stringify(result);
			expect(text).not.toContain(environment.BETTER_AUTH_SECRET);
			expect(text).not.toContain(directory);
			expect(text).not.toContain('admin@example.test');
			expect(text).not.toContain('Child');
			model.connection.sqlite.exec("DELETE FROM session WHERE id='session-admin'");
			expect(
				(
					await diagnosticsGet(model.connection, event(model.admin), {
						mediaPath: directory,
						environment
					})
				).status
			).toBe(401);
		} finally {
			model.connection.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it('lets only exact GET health paths bypass unavailable auth and keeps other mutations protected', async () => {
		let authCalls = 0;
		const handle = createHandle({
			auth: () => {
				authCalls++;
				throw new Error('Auth unavailable');
			},
			database: () => {
				throw new Error('Database unavailable');
			}
		});
		for (const path of ['/health/live', '/health/ready']) {
			const url = new URL('https://gifts.example.test' + path);
			const response = await handle({
				event: { url, request: new Request(url), locals: { actor: null } },
				resolve: async () => Response.json({ live: true })
			} as never);
			expect(response.status).toBe(200);
		}
		expect(authCalls).toBe(0);
		const url = new URL('https://gifts.example.test/health/live');
		const response = await handle({
			event: {
				url,
				request: new Request(url, {
					method: 'POST',
					headers: { origin: 'https://elsewhere.example.test' }
				}),
				locals: { actor: null }
			},
			resolve: async () => Response.json({ live: true })
		} as never);
		expect(response.status).toBe(403);
		expect(authCalls).toBe(0);
	});
});
