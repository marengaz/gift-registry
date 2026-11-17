import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './identity-fixture';
import {
	acceptInvitation,
	createInvitation,
	peopleSettings,
	setGrant,
	setSiteRole,
	revokeMember
} from '../../src/lib/server/invitations';
import {
	requireMember,
	requireAdministrator,
	requireCollaborator,
	resolveActor
} from '../../src/lib/server/access';

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
	it('manages site-wide RBAC invitations, direct role updates on signed-in guests, redundant grant cleanup, and super-admin guards', () => {
		context = fixture();
		const { connection, admin, actor } = context;
		// Signed-in verified Google users appear in peopleSettings even before accepting an invitation
		const initialPeople = peopleSettings(connection, admin);
		expect(initialPeople.superAdministrator?.id).toBe('admin');
		expect(initialPeople.people).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'guest', role: 'guest', member: false }),
				expect.objectContaining({ id: 'other', role: 'guest', member: false })
			])
		);

		// Invite as site-wide buyer with extra list collaborator grant
		const buyerInvite = createInvitation(connection, admin, {
			email: 'guest@example.test',
			role: 'buyer',
			grants: [
				{ listId: 'visible', role: 'collaborator' },
				{ listId: 'secret', role: 'buyer' }
			]
		});
		acceptInvitation(connection, actor('guest'), buyerInvite.token);
		expect(actor('guest')).toMatchObject({
			siteRole: 'buyer',
			buyer: true,
			collaborator: false,
			administrator: false
		});
		// Redundant buyer grant on 'secret' is cleaned up while collaborator grant on 'visible' is preserved
		expect(peopleSettings(connection, admin).grants).toEqual([
			{ userId: 'guest', listId: 'visible', role: 'contributor' }
		]);

		// Admin can directly set a signed-in user's site role without requiring an invitation link first
		setSiteRole(connection, admin, 'other', 'collaborator');
		expect(requireCollaborator(connection, actor('other')).siteRole).toBe('collaborator');
		setSiteRole(connection, admin, 'other', 'administrator');
		expect(requireAdministrator(connection, actor('other')).superAdministrator).toBe(false);

		// Secondary admin cannot modify or revoke super admin or demote/revoke themselves
		const secondary = actor('other')!;
		expect(() => setSiteRole(connection, secondary, 'admin', 'guest')).toThrow();
		expect(() => revokeMember(connection, secondary, 'admin')).toThrow();
		expect(() => setSiteRole(connection, secondary, 'other', 'guest')).toThrow();
		expect(() => revokeMember(connection, secondary, 'other')).toThrow();

		// Super admin can demote secondary admin and promote guest to collaborator (cleaning up list grants)
		setSiteRole(connection, admin, 'other', 'guest');
		expect(() => requireAdministrator(connection, actor('other'))).toThrow();
		setSiteRole(connection, admin, 'guest', 'collaborator');
		expect(peopleSettings(connection, admin).grants).toEqual([]);
	});
	it('prevents dormant list grants on site-wide roles and does not promote non-members when clearing a grant', () => {
		context = fixture();
		const { connection, admin, actor } = context;
		// Clearing a null grant for a non-member does not promote them to member: true
		setGrant(connection, admin, 'guest', { listId: 'visible', role: null });
		expect(actor('guest')).toMatchObject({ member: false, siteRole: 'guest' });
		expect(() => requireMember(connection, actor('guest'))).toThrow();

		// Site-wide collaborator/admin reject list grants cleanly
		setSiteRole(connection, admin, 'guest', 'collaborator');
		expect(() =>
			setGrant(connection, admin, 'guest', { listId: 'visible', role: 'viewer' })
		).toThrow();
		setSiteRole(connection, admin, 'guest', 'administrator');
		expect(() =>
			setGrant(connection, admin, 'guest', { listId: 'visible', role: 'contributor' })
		).toThrow();

		// Site-wide buyer rejects redundant buyer/viewer grants while allowing list collaborator
		setSiteRole(connection, admin, 'guest', 'buyer');
		expect(() =>
			setGrant(connection, admin, 'guest', { listId: 'visible', role: 'buyer' })
		).toThrow();
		expect(() =>
			setGrant(connection, admin, 'guest', { listId: 'visible', role: 'viewer' })
		).toThrow();
		setGrant(connection, admin, 'guest', { listId: 'visible', role: 'collaborator' });
		setSiteRole(connection, admin, 'guest', 'guest');
		expect(peopleSettings(connection, admin).grants).toEqual([
			{ userId: 'guest', listId: 'visible', role: 'contributor' }
		]);
	});
});
