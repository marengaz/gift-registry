import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './identity-fixture';
import { acceptInvitation, createInvitation, setGrant } from '../../src/lib/server/invitations';
import {
	canCapture,
	eligibleListMembers,
	requireMediaAccess,
	canReadProduct,
	projectProduct,
	visibleEntries,
	requireListRole
} from '../../src/lib/server/access';
let context: ReturnType<typeof fixture>;
afterEach(() => context?.connection.close());
describe('current per-list access projection', () => {
	it('restricts assignment choices to signed-in active list members and the administrator', () => {
		context = fixture();
		const { connection, admin, actor } = context;
		acceptInvitation(
			connection,
			actor('guest'),
			createInvitation(connection, admin, {
				email: 'guest@example.test',
				grants: [{ listId: 'visible', role: 'viewer' }]
			}).token
		);
		expect(
			eligibleListMembers(connection, admin, 'visible')
				.map((person) => person.id)
				.sort()
		).toEqual(['admin', 'guest']);
		expect(() => eligibleListMembers(connection, actor('guest'), 'visible')).toThrow();
		setGrant(connection, admin, 'guest', { listId: 'visible', role: null });
		expect(eligibleListMembers(connection, admin, 'visible').map((person) => person.id)).toEqual([
			'admin'
		]);
	});
	it('hides allocations, cross-list metadata and images even from the original contributor', () => {
		context = fixture();
		const { connection, admin, actor } = context;
		const s = connection.sqlite;
		acceptInvitation(
			connection,
			actor('guest'),
			createInvitation(connection, admin, {
				email: 'guest@example.test',
				grants: [{ listId: 'visible', role: 'contributor' }]
			}).token
		);
		s.exec(
			"INSERT INTO products (id,title,contributor_id) VALUES ('shared','Shared','guest'),('hidden','Hidden','guest'),('inbox','Inbox','guest'); INSERT INTO entries (id,product_id,list_id) VALUES ('public-entry','shared','visible'),('secret-entry','shared','secret'); INSERT INTO entries (id,product_id,list_id,state,buyer_id,allocated_by_id,allocation_source) VALUES ('hidden-entry','hidden','visible','allocated','other','other','self');"
		);
		const guest = actor('guest');
		expect(visibleEntries(connection, guest).map((e) => e.id)).toEqual(['public-entry']);
		const projected = projectProduct(connection, guest, 'shared');
		expect(projected?.entries.map((e) => e.listId)).toEqual(['visible']);
		expect(JSON.stringify(projected)).not.toContain('secret');
		expect(projectProduct(connection, guest, 'hidden')).toBeNull();
		expect(canReadProduct(connection, guest, 'hidden')).toBe(false);
		connection.sqlite.exec(
			"INSERT INTO media (id,product_id,storage_path,mime_type,byte_size) VALUES ('private-image','hidden','private/hidden.png','image/png',123);"
		);
		expect(() => requireMediaAccess(connection, guest, 'private-image')).toThrow();
		expect(requireMediaAccess(connection, admin, 'private-image').storagePath).toBe(
			'private/hidden.png'
		);
		expect(canReadProduct(connection, guest, 'inbox')).toBe(true);
		expect(canCapture(connection, guest)).toBe(true);
		setGrant(connection, admin, 'guest', { listId: 'visible', role: 'viewer' });
		expect(canCapture(connection, guest)).toBe(false);
		expect(() => requireListRole(connection, guest, 'visible', ['buyer', 'contributor'])).toThrow();
		setGrant(connection, admin, 'guest', { listId: 'visible', role: null });
		expect(projectProduct(connection, guest, 'shared')).toBeNull();
	});
	it('shows a viewer their own assignment and denies expired session access', () => {
		context = fixture();
		const { connection, admin, actor } = context;
		acceptInvitation(
			connection,
			actor('guest'),
			createInvitation(connection, admin, {
				email: 'guest@example.test',
				grants: [{ listId: 'visible', role: 'viewer' }]
			}).token
		);
		connection.sqlite.exec(
			"INSERT INTO products (id,title,contributor_id) VALUES ('assigned','Assigned','admin'); INSERT INTO entries (id,product_id,list_id,state,buyer_id,allocated_by_id,allocation_source) VALUES ('assigned-entry','assigned','visible','allocated','guest','admin','administrator');"
		);
		const guest = actor('guest');
		expect(visibleEntries(connection, guest)).toHaveLength(1);
		connection.sqlite
			.prepare('UPDATE session SET expires_at = 0 WHERE id = ?')
			.run('session-guest');
		expect(() => visibleEntries(connection, guest)).toThrow();
	});
});
