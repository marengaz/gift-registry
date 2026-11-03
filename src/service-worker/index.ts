import { self } from '$app/service-worker';
import { version } from '$app/env';
import { immutable, assets } from '$app/manifest';
import { importShare, shareRecoveryResponse } from '../lib/client/share-import';

const cachePrefix = 'family-gifts-public-';
const cacheName = `${cachePrefix}${version}`;
const captureUrl = new URL('capture', self.registration.scope).href;
const staticUrls = new Set(
	[...immutable, ...assets].map((asset) => new URL(asset.path, self.registration.scope).href)
);

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(cacheName);
			for (const url of [...staticUrls, captureUrl]) {
				const response = await fetch(new Request(url, { credentials: 'omit', cache: 'reload' }));
				if (!response.ok) throw new Error('The public capture shell could not be initialised.');
				await cache.put(url, response);
			}
		})()
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key.startsWith(cachePrefix) && key !== cacheName) await caches.delete(key);
			}
			await self.clients.claim();
		})()
	);
});

async function receiveShare(request: Request) {
	try {
		if (!request.headers.get('content-type')?.includes('multipart/form-data'))
			return shareRecoveryResponse('The sharing app did not send a supported photo or link form.');
		const record = await importShare(await request.formData());
		const destination = new URL(captureUrl);
		destination.searchParams.set('draft', record.id);
		return Response.redirect(destination.href, 303);
	} catch (error) {
		return shareRecoveryResponse(
			error instanceof Error && error.name === 'QuotaExceededError'
				? 'Device storage is full. Free some space, then share the original again.'
				: error instanceof Error
					? error.message
					: 'Device storage could not save this share. Try again from the original.',
			400
		);
	}
}

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;
	if (event.request.method === 'POST' && url.pathname === '/share') {
		const response = receiveShare(event.request);
		event.respondWith(response);
		event.waitUntil(response.then(() => undefined));
		return;
	}
	if (event.request.method !== 'GET') return;
	if (staticUrls.has(url.href)) {
		event.respondWith(
			(async () => (await (await caches.open(cacheName)).match(url.href)) ?? fetch(event.request))()
		);
		return;
	}
	if (event.request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				try {
					return await fetch(event.request);
				} catch {
					if (url.pathname !== '/capture') return Response.redirect(captureUrl, 303);
					return (
						(await (await caches.open(cacheName)).match(captureUrl)) ??
						shareRecoveryResponse(
							'The offline capture screen is not ready. Reconnect and open Add an idea first.',
							503
						)
					);
				}
			})()
		);
	}
});
