import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseConnection } from './db/client';
import type { CatalogueEvent } from './catalogue';
import { requireAdministrator } from './access';
import { authSetup } from './auth';
import { apiResponse } from './http';
import { visionConfiguration } from './enrichment/vision';
export type ReadinessOptions = {
	database: () => DatabaseConnection;
	mediaPath: string;
	environment: NodeJS.ProcessEnv;
};
export async function inspectReadiness(options: ReadinessOptions) {
	let database = false,
		media = false;
	try {
		const connection = options.database();
		if (connection.sqlite.pragma('quick_check', { simple: true }) !== 'ok')
			throw new Error('Database integrity');
		connection.sqlite
			.transaction(() => {
				connection.sqlite.prepare('UPDATE application_settings SET id=id WHERE 0').run();
			})
			.immediate();
		database = true;
	} catch {}
	const probe = join(options.mediaPath, `.health-${randomUUID()}`);
	let created = false;
	try {
		await mkdir(options.mediaPath, { recursive: true });
		await writeFile(probe, '', { flag: 'wx', mode: 0o600 });
		created = true;
		await rm(probe);
		created = false;
		media = true;
	} catch {
	} finally {
		if (created) await rm(probe).catch(() => {});
	}
	const env = options.environment;
	const authentication = authSetup({
		origin: env.ORIGIN,
		secret: env.BETTER_AUTH_SECRET,
		googleClientId: env.GOOGLE_CLIENT_ID,
		googleClientSecret: env.GOOGLE_CLIENT_SECRET,
		administratorEmail: env.ADMINISTRATOR_EMAIL,
		administratorGoogleSubject: env.ADMINISTRATOR_GOOGLE_SUBJECT
	}).ready;
	return { ready: database && media && authentication, database, media, authentication };
}
export function diagnosticsGet(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	options: { mediaPath?: string; environment?: NodeJS.ProcessEnv } = {}
) {
	return apiResponse(async () => {
		requireAdministrator(connection, event.locals.actor);
		const environment = options.environment ?? process.env;
		const readiness = await inspectReadiness({
			database: () => connection,
			mediaPath: options.mediaPath ?? environment.MEDIA_PATH ?? 'data/media',
			environment
		});
		requireAdministrator(connection, event.locals.actor);
		const jobs = { queued: 0, running: 0, uncertain: 0 };
		for (const row of connection.sqlite
			.prepare(
				"SELECT state,count(*) AS n FROM lookup_jobs WHERE state IN ('queued','running','uncertain') GROUP BY state"
			)
			.all() as { state: keyof typeof jobs; n: number }[])
			jobs[row.state] = row.n;
		return {
			readiness,
			proxy: {
				originMatches: event.url.origin === environment.ORIGIN,
				forwardedProtocolConfigured: environment.PROTOCOL_HEADER === 'x-forwarded-proto'
			},
			identificationConfigured: visionConfiguration(environment).ready,
			jobs
		};
	});
}
