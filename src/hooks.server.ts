import { building } from '$app/env';
import type { Handle } from '@sveltejs/kit/hooks';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { authEnvironment, getAuth, type AuthService } from '#lib/server/auth.ts';
import { getDatabase, type DatabaseConnection } from '#lib/server/db/client.ts';
import { AccessError, resolveActor } from '#lib/server/access.ts';
import { assertSameOrigin, privateJson } from '#lib/server/http.ts';

export function createHandle(dependencies: {
	auth: () => AuthService | null;
	database: () => DatabaseConnection;
}): Handle {
	return async ({ event, resolve }) => {
		if (building) return resolve(event);
		event.locals.actor = null;
		try {
			// The share fallback accepts a browser share, but has no authority to create records.
			if (!(event.url.pathname === '/share' && event.request.method === 'POST'))
				assertSameOrigin(event.request, event.url);
			const auth = dependencies.auth();
			if (auth) {
				const current = await auth.api.getSession({
					headers: event.request.headers,
					query: { disableCookieCache: true }
				});
				if (current)
					event.locals.actor = resolveActor(
						dependencies.database(),
						current.session.id,
						authEnvironment()
					);
			}
			let response: Response;
			if (event.url.pathname.startsWith('/api/auth/') && !auth)
				response = privateJson({ message: 'Google sign-in is not configured.' }, 503);
			else
				response = auth
					? await svelteKitHandler({ event, resolve, auth, building: false })
					: await resolve(event);
			response.headers.set('Cache-Control', 'private, no-store');
			response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
			response.headers.append('Vary', 'Cookie');
			return response;
		} catch (error) {
			if (error instanceof AccessError)
				return privateJson({ message: error.message }, error.status);
			throw error;
		}
	};
}
export const handle = createHandle({ auth: getAuth, database: getDatabase });
