import { createHash } from 'node:crypto';
import { AccessError, requireMember } from './access';
import { parseCapture, saveCapture, type CatalogueEvent } from './catalogue';
import type { DatabaseConnection } from './db/client';
import { assertSameOrigin, privateJson } from './http';
import { prepareMedia, type MediaOptions } from './media';
import type { CaptureAcknowledgement } from '../shared/capture';
function canonical(value: unknown): string {
	if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
	if (value && typeof value === 'object')
		return (
			'{' +
			Object.entries(value)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, v]) => JSON.stringify(key) + ':' + canonical(v))
				.join(',') +
			'}'
		);
	return JSON.stringify(value);
}
export async function capturesPost(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	options: MediaOptions = {}
) {
	let prepared: Awaited<ReturnType<typeof prepareMedia>> | undefined;
	let committed = false;
	let editable = false;
	let operation: { ownerId: string; operationId: string } | undefined;
	try {
		assertSameOrigin(event.request, event.url);
		const actor = requireMember(connection, event.locals.actor);
		const multipart = event.request.headers.get('content-type')?.includes('multipart/form-data');
		const body = multipart ? await event.request.formData() : await event.request.json();
		if (!multipart && (!body || typeof body !== 'object' || Array.isArray(body)))
			throw new AccessError(400, 'The request body is invalid.');
		const get = (key: string) => (multipart ? (body as FormData).get(key) : body[key]);
		const ownerId = get('ownerId');
		const operationId = get('operationId');
		if (ownerId !== actor.userId)
			throw new AccessError(409, 'This draft belongs to another account. Sign in as its author.');
		if (
			typeof operationId !== 'string' ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				operationId
			)
		)
			throw new AccessError(400, 'A valid capture operation identifier is required.');
		operation = { ownerId: actor.userId, operationId };
		const input = parseCapture(multipart ? JSON.parse(String(get('draft'))) : get('draft'));
		const files = multipart
			? (body as FormData).getAll('photos').filter((value): value is File => value instanceof File)
			: [];
		const fingerprint = createHash('sha256').update(canonical(input));
		for (const file of files) {
			if (file.size > 12 * 1024 * 1024)
				throw new AccessError(413, 'Each photo must be 12 MB or smaller.');
			fingerprint.update(canonical({ name: file.name, type: file.type, size: file.size }));
			fingerprint.update(
				createHash('sha256')
					.update(Buffer.from(await file.arrayBuffer()))
					.digest()
			);
		}
		const digest = fingerprint.digest('hex');
		prepared = await prepareMedia(files, options);
		const result = connection.sqlite
			.transaction(() => {
				const current = requireMember(connection, actor);
				const existing = connection.sqlite
					.prepare(
						'SELECT result_json AS resultJson FROM capture_receipts WHERE actor_id=? AND operation_id=?'
					)
					.get(current.userId, operationId) as { resultJson: string } | undefined;
				if (existing) {
					const receipt = JSON.parse(existing.resultJson) as {
						fingerprint: string;
						ack: CaptureAcknowledgement;
					};
					if (receipt.fingerprint !== digest)
						throw new AccessError(
							409,
							'This operation was already saved with different details. Keep this draft and check the saved idea before making another.'
						);
					return receipt.ack;
				}
				let product: ReturnType<typeof saveCapture>;
				try {
					product = saveCapture(connection, current, input, prepared!.media);
				} catch (error) {
					if (error instanceof AccessError && error.status === 403) editable = true;
					throw error;
				}
				const ack: CaptureAcknowledgement = {
					operationId,
					productId: product.id,
					entryIds: product.entries.map((entry) => entry.id)
				};
				connection.sqlite
					.prepare(
						'INSERT INTO capture_receipts (actor_id,operation_id,product_id,result_json) VALUES (?,?,?,?)'
					)
					.run(
						current.userId,
						operationId,
						product.id,
						JSON.stringify({ fingerprint: digest, ack })
					);
				committed = true;
				return ack;
			})
			.immediate();
		return privateJson(result);
	} catch (error) {
		// The receipt and product share the transaction; a failed commit keeps neither.
		committed = false;
		if (operation && error instanceof AccessError && [400, 413].includes(error.status)) {
			try {
				connection.sqlite
					.transaction(() => {
						requireMember(connection, event.locals.actor);
						editable = !connection.sqlite
							.prepare('SELECT 1 FROM capture_receipts WHERE actor_id=? AND operation_id=?')
							.get(operation!.ownerId, operation!.operationId);
					})
					.immediate();
			} catch (checkError) {
				if (!(checkError instanceof AccessError)) throw checkError;
				editable = false;
			}
		}
		if (error instanceof AccessError)
			return privateJson(
				{ message: error.message, ...(editable ? { editable: true } : {}) },
				error.status
			);
		if (error instanceof SyntaxError)
			return privateJson({ message: 'The request body is invalid.' }, 400);
		throw error;
	} finally {
		if (prepared && !committed) await prepared.cleanup();
	}
}
