import type { DatabaseConnection } from '../db/client';
import { AccessError } from '../access';
import { getIdentificationSettings } from './allowance';
import { serpapiConfigured } from './serpapi';
export function serpapiLimit() {
	const raw = process.env.SERPAPI_MONTHLY_SEARCH_LIMIT;
	if (raw === undefined || raw === '') return 200;
	const value = Number(raw);
	return /^\d+$/.test(raw) && Number.isSafeInteger(value) ? value : 0;
}
export function serpapiStatus(connection: DatabaseConnection, now = Date.now()) {
	const month = new Date(now).toISOString().slice(0, 7);
	const used = (
		connection.sqlite
			.prepare('SELECT count(*) AS total FROM serpapi_search_reservations WHERE month=?')
			.get(month) as { total: number }
	).total;
	const limit = serpapiLimit();
	return { configured: serpapiConfigured(), used, limit, remaining: Math.max(0, limit - used) };
}
export function reserveSerpApiSearch(
	connection: DatabaseConnection,
	jobId: string,
	now = Date.now()
) {
	return connection.sqlite
		.transaction(() => {
			const existing = connection.sqlite
				.prepare('SELECT job_id FROM serpapi_search_reservations WHERE job_id=?')
				.get(jobId);
			if (existing) return;
			if (!getIdentificationSettings(connection).enabled)
				throw new AccessError(409, 'Image identification is disabled. Your saved idea is safe.');
			if (!serpapiStatus(connection, now).remaining)
				throw new AccessError(
					409,
					'The monthly photo-search allowance is exhausted. Your saved idea is safe; try in a later month.'
				);
			connection.sqlite
				.prepare('INSERT INTO serpapi_search_reservations(job_id,month,created_at) VALUES (?,?,?)')
				.run(jobId, new Date(now).toISOString().slice(0, 7), now);
		})
		.immediate();
}
