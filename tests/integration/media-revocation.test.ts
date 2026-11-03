import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fixture } from './identity-fixture';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';
import { mediaGet } from '../../src/lib/server/media';

const io = vi.hoisted(() => ({ pause: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async (original) => {
	const actual = await original<typeof import('node:fs/promises')>();
	return {
		...actual,
		readFile: async (...args: Parameters<typeof actual.readFile>) => {
			const bytes = await actual.readFile(...args);
			if (String(args[0]).endsWith('preview.webp')) await io.pause?.();
			return bytes;
		}
	};
});
afterEach(() => {
	io.pause = undefined;
});
describe('private media during concurrent access changes', () => {
	it.each(['allocation', 'grant', 'session'] as const)(
		'rechecks %s after reading the private file',
		async (change) => {
			const model = fixture();
			const directory = await mkdtemp(join(tmpdir(), 'gift-media-revoke-'));
			let release!: () => void;
			try {
				acceptInvitation(
					model.connection,
					model.actor('guest'),
					createInvitation(model.connection, model.admin, {
						email: 'guest@example.test',
						grants: [{ listId: 'visible', role: 'viewer' }]
					}).token
				);
				model.connection.sqlite.exec(
					"INSERT INTO products(id,title,contributor_id) VALUES('private-product','Gift','admin'); INSERT INTO entries(id,product_id,list_id) VALUES('private-entry','private-product','visible'); INSERT INTO media(id,product_id,storage_path,mime_type,byte_size) VALUES('photo','private-product','photo/original','image/webp',1)"
				);
				await mkdir(join(directory, 'photo'));
				const image = await sharp({
					create: { width: 2, height: 2, channels: 3, background: '#abc' }
				})
					.webp()
					.toBuffer();
				await writeFile(join(directory, 'photo', 'preview.webp'), image);
				let started!: () => void;
				const reading = new Promise<void>((resolve) => {
					started = resolve;
				});
				const blocked = new Promise<void>((resolve) => {
					release = resolve;
				});
				io.pause = async () => {
					started();
					await blocked;
				};
				const url = new URL('http://localhost/api/media/photo');
				const pending = mediaGet(
					model.connection,
					{ url, request: new Request(url), locals: { actor: model.actor('guest') } },
					'photo',
					{ mediaRoot: directory }
				);
				await reading;
				if (change === 'allocation')
					model.connection.sqlite.exec(
						"UPDATE entries SET state='allocated',buyer_id='other',allocation_source='administrator',allocated_by_id='admin',allocated_at=1 WHERE id='private-entry'"
					);
				if (change === 'grant')
					model.connection.sqlite.exec("DELETE FROM grants WHERE user_id='guest'");
				if (change === 'session')
					model.connection.sqlite.exec("DELETE FROM session WHERE id='session-guest'");
				release();
				const response = await pending;
				expect(response.status).toBe(change === 'session' ? 401 : 404);
				expect(response.headers.get('content-type')).toContain('application/json');
			} finally {
				release?.();
				model.connection.close();
				await rm(directory, { recursive: true, force: true });
			}
		}
	);
});
