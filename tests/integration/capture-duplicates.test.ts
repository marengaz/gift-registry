import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './identity-fixture';
import { captureDuplicates } from '../../src/lib/server/capture-duplicates';
const models: ReturnType<typeof fixture>[] = [];
afterEach(() => {
	for (const model of models.splice(0)) model.connection.close();
});
describe('capture duplicate hints', () => {
	it('only hints at ideas the contributor may see and preserves variant parameters', async () => {
		const model = fixture();
		models.push(model);
		const db = model.connection.sqlite;
		db.exec(
			"INSERT INTO household_members(user_id,google_subject,accepted_at) VALUES('guest','google-guest',1); INSERT INTO grants(list_id,user_id,role) VALUES('visible','guest','contributor');"
		);
		db.exec(
			"INSERT INTO products(id,title,source_url,contributor_id) VALUES('public','Visible console','https://shop.example/toy?colour=blue','admin'),('private','Secret console','https://shop.example/toy?colour=blue','admin'),('red','Red console','https://shop.example/toy?colour=red','admin'); INSERT INTO entries(id,product_id,list_id) VALUES('public-entry','public','visible'),('private-entry','private','secret'),('red-entry','red','visible');"
		);
		const url = new URL(
			'https://gifts.example/api/capture-duplicates?url=' +
				encodeURIComponent('https://shop.example/toy?utm_source=share&colour=blue#details')
		);
		const response = await captureDuplicates(model.connection, {
			url,
			request: new Request(url),
			locals: { actor: model.actor('guest') }
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			matches: [{ id: 'public', title: 'Visible console' }]
		});
	});
	it('does not reveal hints to an uninvited or revoked account', async () => {
		const model = fixture();
		models.push(model);
		const url = new URL(
			'https://gifts.example/api/capture-duplicates?url=https://shop.example/toy'
		);
		const response = await captureDuplicates(model.connection, {
			url,
			request: new Request(url),
			locals: { actor: model.actor('guest') }
		});
		expect(response.status).toBe(403);
	});
});
