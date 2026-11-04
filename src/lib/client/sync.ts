import type { Identity } from '../catalogue-types';
import { DraftStore, draftStore } from './drafts';
import type { CaptureAcknowledgement } from '../shared/capture';
async function bounded<T>(
	milliseconds: number,
	operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			operation(controller.signal),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(
						new Error('The connection timed out. Your local draft is safe; retry when connected.')
					);
				}, milliseconds);
			})
		]);
	} finally {
		clearTimeout(timer!);
	}
}
export async function refreshCaptureIdentity(
	store = draftStore,
	transport: typeof fetch = fetch
): Promise<Identity | null> {
	const generation = await store.beginIdentityRefresh();
	const person = await bounded(10_000, async (signal) => {
		const response = await transport('/api/me', { cache: 'no-store', signal });
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) return null;
			throw new Error('Current permissions could not be checked. Your local drafts are safe.');
		}
		return (await response.json()) as Identity;
	});
	return (await store.remember(person, generation)) ? person : null;
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
			const { response, result } = await bounded(30_000, async (signal) => {
				const response = await transport('/api/captures', { method: 'POST', body, signal });
				return { response, result: await response.json() };
			});
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
