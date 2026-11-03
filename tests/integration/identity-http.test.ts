import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './identity-fixture';
import {
	peopleGet,
	peoplePost,
	ownIdentity,
	type PeopleEvent
} from '../../src/lib/server/people-api';
import { makeSignature } from 'better-auth/crypto';
import { authSetup, createAuth } from '../../src/lib/server/auth';
let context: ReturnType<typeof fixture>;
afterEach(() => context?.connection.close());
function event(id: string | null, body?: unknown, origin = 'http://localhost:4173'): PeopleEvent {
	const url = new URL('http://localhost:4173/api/people');
	return {
		url,
		locals: { actor: id ? context.actor(id) : null },
		request: new Request(url, {
			method: body ? 'POST' : 'GET',
			headers: { origin, 'Content-Type': 'application/json' },
			...(body ? { body: JSON.stringify(body) } : {})
		})
	};
}
describe('identity HTTP boundaries', () => {
	it('enforces administrator, origin, validation and no-store on real people handlers', async () => {
		context = fixture();
		const { connection } = context;
		expect((await peopleGet(connection, event(null))).status).toBe(401);
		expect((await peopleGet(connection, event('guest'))).status).toBe(403);
		expect(
			(
				await peoplePost(
					connection,
					event(
						'admin',
						{ action: 'invite', email: 'guest@example.test', grants: [] },
						'https://attacker.example'
					)
				)
			).status
		).toBe(403);
		expect(
			(
				await peoplePost(
					connection,
					event('admin', { action: 'invite', email: 'invalid', grants: [] })
				)
			).status
		).toBe(400);
		const response = await peoplePost(
			connection,
			event('admin', {
				action: 'invite',
				email: 'guest@example.test',
				grants: [{ listId: 'visible', role: 'buyer' }]
			})
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect((await response.json()).url).toMatch(
			/^http:\/\/localhost:4173\/invite\/[A-Za-z0-9_-]+$/
		);
		const identity = await ownIdentity(connection, event('guest'));
		expect(await identity.json()).toMatchObject({ id: 'guest', member: false, lists: [] });
	});
	it('returns safely to sign-in for cancelled and invalid-state OAuth without grants', async () => {
		context = fixture();
		const auth = createAuth(context.connection, {
			origin: 'http://localhost:4173',
			secret: 'test-only-random-secret-8d10a957acf165810d9a',
			googleClientId: 'test-google-client',
			googleClientSecret: 'test-only-provider-secret',
			administratorEmail: 'admin@example.test'
		});
		for (const query of [
			'error=access_denied&state=invalid',
			'code=untrusted-code&state=invalid'
		]) {
			const response = await auth.handler(
				new Request(`http://localhost:4173/api/auth/callback/google?${query}`)
			);
			expect(response.status).toBe(302);
			expect(response.headers.get('location')).toContain('/login');
		}
		expect(context.connection.sqlite.prepare('SELECT * FROM grants').all()).toHaveLength(0);
		expect(auth.options.emailAndPassword?.enabled).toBe(false);
		expect(Object.keys(auth.options.socialProviders!)).toEqual(['google']);
		expect(auth.options.account?.accountLinking?.enabled).toBe(false);
		expect(auth.options.session?.cookieCache?.enabled).toBe(false);
	});
	it('uses the real adapter for signed session cookies and rejects a deleted session immediately', async () => {
		context = fixture();
		const secret = 'test-only-random-secret-8d10a957acf165810d9a';
		const auth = createAuth(context.connection, {
			origin: 'http://localhost:4173',
			secret,
			googleClientId: 'test-google-client',
			googleClientSecret: 'test-only-provider-secret',
			administratorEmail: 'admin@example.test'
		});
		const cookie =
			'better-auth.session_token=' +
			encodeURIComponent('token-guest.' + (await makeSignature('token-guest', secret)));
		const request = () =>
			new Request('http://localhost:4173/api/auth/get-session', { headers: { cookie } });
		const valid = await auth.handler(request());
		expect((await valid.json()).user.id).toBe('guest');
		context.connection.sqlite.prepare('DELETE FROM session WHERE id=?').run('session-guest');
		const revoked = await auth.handler(request());
		expect(await revoked.json()).toBeNull();
	});
	it('leaves sign-in unconfigured when secrets or an explicit administrator are missing', () => {
		expect(authSetup({}).ready).toBe(false);
		expect(
			authSetup({
				origin: 'https://gifts.example',
				secret: 'test-only-long-secret-that-is-at-least-32',
				googleClientId: 'id',
				googleClientSecret: 'secret'
			}).missing
		).toContain('ADMINISTRATOR_EMAIL or ADMINISTRATOR_GOOGLE_SUBJECT');
	});
});
