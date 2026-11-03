import { json } from '@sveltejs/kit';
import { AccessError } from './access';
export function privateJson(value: unknown, status = 200) {
	return json(value, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}
export function assertSameOrigin(request: Request, url: URL) {
	if (
		!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
		request.headers.get('origin') !== url.origin
	)
		throw new AccessError(403, 'This request must come from this site.');
}
export async function apiResponse(action: () => unknown | Promise<unknown>) {
	try {
		return privateJson(await action());
	} catch (error) {
		if (error instanceof AccessError) return privateJson({ message: error.message }, error.status);
		if (error instanceof SyntaxError)
			return privateJson({ message: 'The request body is invalid.' }, 400);
		throw error;
	}
}
