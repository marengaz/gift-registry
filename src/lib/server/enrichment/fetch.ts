import { lookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import type { IncomingHttpHeaders, ClientRequest } from 'node:http';
import ipaddr from 'ipaddr.js';
export class PublicFetchError extends Error {}

export type Address = { address: string; family: number };
export type FetchLimits = { maxBytes: number; timeoutMs: number };
export type FetchResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer };
export type PublicFetchDependencies = {
	resolve: (hostname: string) => Promise<Address[]>;
	request: (url: URL, address: Address, limits: FetchLimits) => Promise<FetchResponse>;
};
function publicAddress(address: string) {
	try {
		return ipaddr.parse(address).range() === 'unicast';
	} catch {
		return false;
	}
}
export function publicUrl(value: string): URL {
	const url = new URL(value);
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		(url.port && url.port !== '443') ||
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		(!host.includes('.') && !isIP(host)) ||
		(isIP(host) && !publicAddress(host))
	)
		throw new PublicFetchError('Only public HTTPS product links are supported.');
	return url;
}
export function pinnedRequest(
	url: URL,
	address: Address,
	limits: FetchLimits,
	requestFactory: typeof httpsRequest = httpsRequest
): Promise<FetchResponse> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error: Error | null, value?: FetchResponse) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(value!);
		};
		const options: RequestOptions = {
			method: 'GET',
			agent: false,
			servername: url.hostname.replace(/^\[|\]$/g, ''),
			headers: {
				'User-Agent': 'FamilyGiftCatalogue/1.0',
				Accept: 'text/html,image/*;q=0.8',
				'Accept-Encoding': 'identity'
			},
			lookup: (_hostname, options, callback) => {
				// The selected address is never resolved again when opening the socket.
				if (typeof options === 'object' && options.all)
					callback(null, [{ address: address.address, family: address.family }]);
				else callback(null, address.address, address.family);
			}
		};
		let request: ClientRequest | undefined;
		const timer = setTimeout(() => {
			finish(new PublicFetchError('The shop took too long to respond.'));
			request?.destroy();
		}, limits.timeoutMs);
		try {
			request = requestFactory(url, options, (response) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				if (
					response.headers['content-encoding'] &&
					response.headers['content-encoding'] !== 'identity'
				) {
					finish(new PublicFetchError('This shop sent a compressed page that could not be read.'));
					response.destroy();
					request?.destroy();
					return;
				}
				response.on('data', (part: Buffer) => {
					bytes += part.length;
					if (bytes > limits.maxBytes) {
						finish(new PublicFetchError('The retailer page is too large to read safely.'));
						response.destroy();
						request?.destroy();
						return;
					}
					chunks.push(Buffer.from(part));
				});
				response.on('error', (error) => finish(error));
				response.on('end', () =>
					finish(null, {
						status: response.statusCode ?? 502,
						headers: response.headers,
						body: Buffer.concat(chunks)
					})
				);
				response.on('aborted', () =>
					finish(new PublicFetchError('The public response was interrupted.'))
				);
			});
			request.on('error', (error) => finish(error));
			request.end();
		} catch (error) {
			finish(
				error instanceof Error
					? error
					: new PublicFetchError('The public request could not be opened.')
			);
		}
	});
}
const defaults: PublicFetchDependencies = {
	resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
	request: pinnedRequest
};
export async function publicFetch(
	value: string,
	limits: Partial<FetchLimits> = {},
	dependencies: PublicFetchDependencies = defaults
): Promise<FetchResponse & { url: string }> {
	const bounds = {
		maxBytes: limits.maxBytes ?? 8 * 1024 * 1024,
		timeoutMs: limits.timeoutMs ?? 10000
	};
	const started = Date.now();
	let url = publicUrl(value);
	for (let redirects = 0; redirects <= 3; redirects++) {
		const remaining = bounds.timeoutMs - (Date.now() - started);
		if (remaining <= 0) throw new PublicFetchError('The public page took too long to respond.');
		const hostname = url.hostname.replace(/^\[|\]$/g, '');
		let timer: ReturnType<typeof setTimeout> | undefined;
		let addresses: Address[];
		try {
			addresses = await Promise.race([
				isIP(hostname)
					? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
					: dependencies.resolve(hostname),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new PublicFetchError('The public address lookup timed out.')),
						remaining
					);
				})
			]);
		} finally {
			clearTimeout(timer);
		}
		if (!addresses.length || addresses.some((answer) => !publicAddress(answer.address)))
			throw new PublicFetchError('The link points to a protected network address.');
		const response = await dependencies.request(url, addresses[0], {
			...bounds,
			timeoutMs: Math.max(1, bounds.timeoutMs - (Date.now() - started))
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.location;
			if (!location || redirects === 3)
				throw new PublicFetchError('The public link redirects too many times.');
			url = publicUrl(new URL(location, url).href);
			continue;
		}
		if (response.status < 200 || response.status >= 300)
			throw new PublicFetchError(
				`This shop could not provide the page (HTTP ${response.status}). It may require a sign-in or block automatic reading.`
			);
		return { ...response, url: url.href };
	}
	throw new PublicFetchError('The public link redirects too many times.');
}
