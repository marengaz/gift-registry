import { describe, it, expect, vi } from 'vitest';
import {
	publicFetch,
	pinnedRequest,
	type PublicFetchDependencies
} from '../../src/lib/server/enrichment/fetch';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RequestOptions } from 'node:https';

function dependencies(
	addresses: string[],
	responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>
) {
	const requests: Array<{ url: string; address: string }> = [];
	const deps: PublicFetchDependencies = {
		resolve: async () =>
			addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
		request: async (url, address) => {
			requests.push({ url: url.href, address: address.address });
			const response = responses.shift()!;
			return {
				status: response.status,
				headers: response.headers ?? {},
				body: Buffer.from(response.body ?? '')
			};
		}
	};
	return { deps, requests };
}
describe('public HTTPS fetch boundary', () => {
	it.each([
		'https://localhost/x',
		'https://127.0.0.1/x',
		'https://10.0.0.1/x',
		'https://169.254.169.254/x',
		'https://[::1]/x',
		'https://[fd00::1]/x',
		'https://[::ffff:127.0.0.1]/x',
		'http://example.com',
		'https://u:p@example.com',
		'https://example.com:8443'
	])('rejects protected target %s before transport', async (url) => {
		const { deps, requests } = dependencies(['93.184.216.34'], []);
		await expect(publicFetch(url, {}, deps)).rejects.toThrow();
		expect(requests).toEqual([]);
	});
	it('rejects a hostname when any answer is private and checks every redirect', async () => {
		const mixed = dependencies(['93.184.216.34', '192.168.1.1'], []);
		await expect(publicFetch('https://shop.example', {}, mixed.deps)).rejects.toThrow();
		expect(mixed.requests).toHaveLength(0);
		const redirect = dependencies(
			['93.184.216.34'],
			[{ status: 302, headers: { location: 'https://192.168.1.1/admin' } }]
		);
		await expect(publicFetch('https://shop.example', {}, redirect.deps)).rejects.toThrow();
		expect(redirect.requests).toHaveLength(1);
	});
	it('pins the validated address into the actual HTTPS lookup callback, with original TLS host and no credentials', async () => {
		let captured: RequestOptions | undefined;
		const requestFactory = vi.fn(
			(_url: URL, options: RequestOptions, callback: (response: PassThrough) => void) => {
				captured = options;
				const request = new EventEmitter() as EventEmitter & {
					end: () => void;
					destroy: () => void;
				};
				request.destroy = () => {};
				request.end = () => {
					const response = Object.assign(new PassThrough(), {
						statusCode: 200,
						headers: { 'content-type': 'text/html' }
					});
					callback(response);
					response.end('public page');
				};
				return request;
			}
		);
		const response = await pinnedRequest(
			new URL('https://shop.example/item'),
			{ address: '93.184.216.34', family: 4 },
			{ maxBytes: 1024, timeoutMs: 5000 },
			requestFactory as never
		);
		expect(response.body.toString()).toBe('public page');
		expect(captured?.servername).toBe('shop.example');
		expect(captured?.agent).toBe(false);
		expect(captured?.headers).toEqual({
			'User-Agent': 'FamilyGiftCatalogue/1.0',
			Accept: 'text/html,image/*;q=0.8',
			'Accept-Encoding': 'identity'
		});
		const lookup = captured!.lookup! as (
			host: string,
			options: unknown,
			cb: (error: null, address: unknown, family?: number) => void
		) => void;
		const results: unknown[] = [];
		lookup('shop.example', {}, (_err, address, family) => results.push({ address, family }));
		expect(results).toEqual([{ address: '93.184.216.34', family: 4 }]);
	});
	it('bounds response size through the streaming transport', async () => {
		const requestFactory = (
			_url: URL,
			_options: RequestOptions,
			callback: (response: PassThrough) => void
		) => {
			const request = new EventEmitter() as EventEmitter & {
				end: () => void;
				destroy: (error?: Error) => void;
			};
			request.destroy = (error) => {
				if (error) request.emit('error', error);
			};
			request.end = () => {
				const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
				callback(response);
				response.end('too much data');
			};
			return request;
		};
		await expect(
			pinnedRequest(
				new URL('https://shop.example'),
				{ address: '93.184.216.34', family: 4 },
				{ maxBytes: 4, timeoutMs: 5000 },
				requestFactory as never
			)
		).rejects.toThrow('large');
	});
});

import { createServer, request as realRequest } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('uses the pinned address through a real TLS socket and never connects a protected resolution', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'gift-public-tls-'));
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			join(directory, 'key.pem'),
			'-out',
			join(directory, 'cert.pem'),
			'-days',
			'1',
			'-subj',
			'/CN=shop.fixture.test',
			'-addext',
			'subjectAltName=DNS:shop.fixture.test'
		],
		{ stdio: 'ignore' }
	);
	const certificate = readFileSync(join(directory, 'cert.pem'));
	let connections = 0;
	const received: Array<{
		host: string | undefined;
		sni: string | false | null;
		authorization: string | undefined;
		cookie: string | undefined;
	}> = [];
	const server = createServer(
		{ key: readFileSync(join(directory, 'key.pem')), cert: certificate },
		(request, response) => {
			received.push({
				host: request.headers.host,
				sni: (request.socket as import('node:tls').TLSSocket).servername,
				authorization: request.headers.authorization,
				cookie: request.headers.cookie
			});
			response.end(
				request.url === '/large'
					? 'x'.repeat(3 * 1024 * 1024)
					: request.url === '/oversized'
						? 'x'.repeat(8 * 1024 * 1024 + 1)
						: 'real TLS product page'
			);
		}
	);
	server.on('connection', () => connections++);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as import('node:net').AddressInfo).port;
	const factory = ((
		url: URL,
		options: RequestOptions,
		callback: Parameters<typeof realRequest>[2]
	) => realRequest(url, { ...options, ca: certificate }, callback)) as typeof realRequest;
	try {
		const result = await pinnedRequest(
			new URL(`https://shop.fixture.test:${port}/product`),
			{ address: '127.0.0.1', family: 4 },
			{ maxBytes: 1024, timeoutMs: 5000 },
			factory
		);
		expect(result.body.toString()).toBe('real TLS product page');
		expect(received).toEqual([
			{
				host: `shop.fixture.test:${port}`,
				sni: 'shop.fixture.test',
				authorization: undefined,
				cookie: undefined
			}
		]);
		expect(connections).toBe(1);
		const blocked: PublicFetchDependencies = {
			resolve: async () => [{ address: '127.0.0.1', family: 4 }],
			request: (url, address, limits) =>
				pinnedRequest(new URL(`https://${url.hostname}:${port}/private`), address, limits, factory)
		};
		await expect(publicFetch('https://shop.fixture.test/private', {}, blocked)).rejects.toThrow(
			'protected network'
		);
		expect(connections).toBe(1);
		expect(received).toHaveLength(1);
		const retailer: PublicFetchDependencies = {
			resolve: async () => [{ address: '93.184.216.34', family: 4 }],
			request: (url, _address, limits) =>
				pinnedRequest(
					new URL(`https://shop.fixture.test:${port}${url.pathname}`),
					{ address: '127.0.0.1', family: 4 },
					limits,
					factory
				)
		};
		const large = await publicFetch('https://shop.fixture.test/large', {}, retailer);
		expect(large.body.length).toBe(3 * 1024 * 1024);
		await expect(publicFetch('https://shop.fixture.test/oversized', {}, retailer)).rejects.toThrow(
			'too large'
		);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(directory, { recursive: true, force: true });
	}
});
