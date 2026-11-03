import type { Identity } from '../catalogue-types';
import { DraftStore, draftStore } from './drafts';
import type { CaptureAcknowledgement } from '../shared/capture';
export async function refreshCaptureIdentity(
	store = draftStore,
	transport: typeof fetch = fetch
): Promise<Identity | null> {
	const response = await transport('/api/me', { cache: 'no-store' });
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			await store.remember(null);
			return null;
		}
		throw new Error('Current permissions could not be checked. Your local drafts are safe.');
	}
	const person = (await response.json()) as Identity;
	await store.remember(person);
	return person;
}
export async function syncDrafts(
	store: DraftStore = draftStore,
	transport: typeof fetch = fetch,
	expectedOwnerId?: string
) {
	let person: Identity | null;
	try {
		person = await refreshCaptureIdentity(store, transport);
	} catch {
		return;
	}
	if (!person?.member || (expectedOwnerId && person.id !== expectedOwnerId)) return;
	for (const record of await store.list(person.id)) {
		if (record.status === 'saved') continue;
		let claimed: Awaited<ReturnType<DraftStore['claim']>> = undefined;
		try {
			claimed = await store.claim(record.id, person.id);
			if (!claimed) continue;
			const body = new FormData();
			body.set('ownerId', person.id);
			body.set('operationId', claimed.operationId);
			body.set('draft', JSON.stringify(claimed.payload));
			for (const photo of await store.files(record.id, person.id)) body.append('photos', photo);
			const response = await transport('/api/captures', { method: 'POST', body });
			const result = await response.json();
			if (!response.ok) {
				await store.release(
					record.id,
					person.id,
					result.message ?? 'Reconnect or sign in again, then retry.',
					result.editable === true,
					claimed.leaseToken
				);
				continue;
			}
			if (
				result.operationId !== claimed.operationId ||
				typeof result.productId !== 'string' ||
				!Array.isArray(result.entryIds) ||
				result.entryIds.some((id: unknown) => typeof id !== 'string')
			)
				throw new Error(
					'The server response was incomplete. Retry to check whether this idea was saved.'
				);
			await store.acknowledge(record.id, person.id, result as CaptureAcknowledgement);
		} catch (error) {
			await store.release(
				record.id,
				person.id,
				error instanceof Error ? error.message : 'The response was lost. Retry when connected.',
				false,
				claimed?.leaseToken
			);
		}
	}
}
