import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrateDatabase } from '../../src/lib/server/db/client';
import {
	getIdentificationSettings,
	updateIdentificationSettings,
	reserveAllowance,
	allowanceSummary
} from '../../src/lib/server/enrichment/allowance';
const directories: string[] = [];
const connections: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
	connections.forEach((c) => c.close());
	connections.length = 0;
	directories.forEach((d) => rmSync(d, { recursive: true, force: true }));
	directories.length = 0;
});
function setup() {
	const directory = mkdtempSync(join(tmpdir(), 'gift-allowance-'));
	directories.push(directory);
	const filename = join(directory, 'test.sqlite');
	const first = createDatabase({ filename });
	migrateDatabase(first);
	const second = createDatabase({ filename });
	connections.push(first, second);
	for (const id of ['one', 'two', 'three'])
		first.sqlite
			.prepare(
				"INSERT INTO lookup_jobs(id,product_id,actor_id,actor_session_id,operation_id,fingerprint,kind) VALUES(?,'product','admin','session',?,?,'vision')"
			)
			.run(id, id, id);
	return { first, second };
}
describe('durable identification admission', () => {
	it('starts disabled with the conservative one-dollar allowance', () => {
		const { first } = setup();
		expect(getIdentificationSettings(first)).toMatchObject({
			enabled: false,
			monthlyLimitMicrodollars: 1000000,
			unitMicrodollars: 3500
		});
		expect(() => reserveAllowance(first, 'one', 'personal-project')).toThrow('disabled');
	});
	it('admits a single winner across connections and never reserves a repeated job twice', async () => {
		const { first, second } = setup();
		updateIdentificationSettings(first, {
			enabled: true,
			monthlyLimitMicrodollars: 3500,
			unitMicrodollars: 3500,
			pricingRevision: 'published-v1'
		});
		const outcomes = await Promise.all([
			Promise.resolve().then(() => {
				try {
					return reserveAllowance(first, 'one', 'personal-project', Date.UTC(2026, 10, 3));
				} catch {
					return null;
				}
			}),
			Promise.resolve().then(() => {
				try {
					return reserveAllowance(second, 'two', 'personal-project', Date.UTC(2026, 10, 3));
				} catch {
					return null;
				}
			})
		]);
		expect(outcomes.filter(Boolean)).toHaveLength(1);
		expect(reserveAllowance(second, 'one', 'personal-project', Date.UTC(2026, 10, 3))).toEqual(
			outcomes[0]
		);
		expect(allowanceSummary(first, Date.UTC(2026, 10, 3))).toMatchObject({
			reservedMicrodollars: 3500,
			remainingMicrodollars: 0
		});
		expect(first.sqlite.prepare('SELECT * FROM allowance_reservations').all()).toHaveLength(1);
	});
	it('keeps old reservations through UTC rollover, pricing revision and disable', () => {
		const { first } = setup();
		updateIdentificationSettings(first, {
			enabled: true,
			monthlyLimitMicrodollars: 7000,
			unitMicrodollars: 3500,
			pricingRevision: 'published-v1'
		});
		reserveAllowance(first, 'one', 'personal-project', Date.UTC(2026, 10, 30, 23, 59));
		updateIdentificationSettings(first, {
			enabled: true,
			monthlyLimitMicrodollars: 7000,
			unitMicrodollars: 7000,
			pricingRevision: 'published-v2'
		});
		const next = reserveAllowance(first, 'two', 'personal-project', Date.UTC(2026, 11, 1));
		expect(next).toMatchObject({
			month: '2026-12',
			amountMicrodollars: 7000,
			pricingRevision: 'published-v2'
		});
		updateIdentificationSettings(first, {
			enabled: false,
			monthlyLimitMicrodollars: 0,
			unitMicrodollars: 7000,
			pricingRevision: 'published-v2'
		});
		expect(() =>
			reserveAllowance(first, 'three', 'personal-project', Date.UTC(2026, 11, 1))
		).toThrow('disabled');
		expect(
			first.sqlite
				.prepare(
					'SELECT month,amount_microdollars FROM allowance_reservations ORDER BY created_at,job_id'
				)
				.all()
		).toEqual([
			{ month: '2026-11', amount_microdollars: 3500 },
			{ month: '2026-12', amount_microdollars: 7000 }
		]);
	});
});
