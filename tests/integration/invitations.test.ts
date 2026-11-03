import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './identity-fixture';
import {
	acceptInvitation,
	createInvitation,
	setGrant,
	revokeMember
} from '../../src/lib/server/invitations';
import { requireMember, requireAdministrator, resolveActor } from '../../src/lib/server/access';

let context: ReturnType<typeof fixture>;
afterEach(() => context?.connection.close());
describe('Google invitation boundary', () => {
	it('does not bootstrap a first visitor or promote a second configured identity', () => {
		context = fixture();
		const { connection } = context;
		connection.sqlite.prepare('DELETE FROM application_settings').run();
		expect(
			resolveActor(connection, 'session-other', { administratorEmail: 'admin@example.test' })
		).toMatchObject({ administrator: false, member: false });
		expect(connection.sqlite.prepare('SELECT * FROM application_settings').all()).toHaveLength(0);
		expect(
			resolveActor(connection, 'session-admin', { administratorGoogleSubject: 'google-admin' })
		).toMatchObject({ administrator: true });
		expect(
			resolveActor(connection, 'session-other', { administratorEmail: 'other@example.test' })
		).toMatchObject({ administrator: false });
	});
	it('admits only the intended verified email once and stores only a token digest', () => {
		context = fixture();
		const { connection, admin, actor } = context;
		expect(() => requireMember(connection, actor('guest'))).toThrow();
		const invite = createInvitation(connection, admin, {
			email: ' Guest@Example.Test ',
			grants: [{ listId: 'visible', role: 'contributor' }]
		});
		expect(
			JSON.stringify(connection.sqlite.prepare('SELECT * FROM invitations').get())
		).not.toContain(invite.token);
		expect(() => acceptInvitation(connection, actor('other'), invite.token)).toThrow();
		acceptInvitation(connection, actor('guest'), invite.token);
		expect(requireMember(connection, actor('guest')).userId).toBe('guest');
		expect(() => acceptInvitation(connection, actor('guest'), invite.token)).toThrow();
		expect(() => requireAdministrator(connection, actor('guest'))).toThrow();
	});
	it('rejects expired invitations and unverified identities without creating membership', () => {
		context = fixture();
		const { connection, admin, actor } = context;
		const invite = createInvitation(connection, admin, { email: 'guest@example.test', grants: [] });
		connection.sqlite.prepare('UPDATE invitations SET expires_at = 0').run();
		expect(() => acceptInvitation(connection, actor('guest'), invite.token)).toThrow();
		connection.sqlite.prepare('UPDATE user SET email_verified = 0 WHERE id = ?').run('guest');
		expect(actor('guest')).toBeNull();
		expect(connection.sqlite.prepare('SELECT * FROM household_members').all()).toHaveLength(0);
	});
	it('binds exactly one configured Google subject and rechecks revoked sessions and grants', () => {
		context = fixture();
		const { connection, admin, actor } = context;
		const invite = createInvitation(connection, admin, {
			email: 'guest@example.test',
			grants: [{ listId: 'visible', role: 'buyer' }]
		});
		acceptInvitation(connection, actor('guest'), invite.token);
		expect(() => requireAdministrator(connection, actor('other'))).toThrow();
		connection.sqlite
			.prepare('UPDATE user SET email = ? WHERE id = ?')
			.run('changed@example.test', 'admin');
		expect(actor('admin')?.administrator).toBe(true);
		setGrant(connection, admin, 'guest', { listId: 'visible', role: 'viewer' });
		const stale = actor('guest');
		revokeMember(connection, admin, 'guest');
		expect(() => requireMember(connection, stale)).toThrow();
		expect(actor('guest')).toBeNull();
	});
});
