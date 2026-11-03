import { shareRecoveryResponse } from '#lib/client/share-import.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = () =>
	shareRecoveryResponse(
		'The local share receiver was not ready. Open Add an idea online to initialise it, then share again.',
		503
	);
export const GET: RequestHandler = () =>
	shareRecoveryResponse('Share from the original app, or add an idea manually.');
