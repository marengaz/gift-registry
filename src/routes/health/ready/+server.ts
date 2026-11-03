import { json } from '@sveltejs/kit';
import { inspectReadiness } from '#lib/server/diagnostics.ts';
import { getDatabase } from '#lib/server/db/client.ts';
export const GET = async () => {
	const result = await inspectReadiness({
		database: getDatabase,
		mediaPath: process.env.MEDIA_PATH ?? 'data/media',
		environment: process.env
	});
	return json(
		{ ready: result.ready },
		{ status: result.ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
	);
};
