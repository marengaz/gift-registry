import Dexie, { type Table } from 'dexie';
import {
	capturePayload,
	type CaptureDraft,
	type GiftList,
	type Identity
} from '../catalogue-types';
import type { CaptureAcknowledgement } from '../shared/capture';
export type DraftStatus = 'local' | 'queued' | 'syncing' | 'saved' | 'needsattention';
export type LocalDraft = {
	id: string;
	ownerId: string | null;
	ownerKey: string;
	operationId: string;
	draft: CaptureDraft;
	status: DraftStatus;
	readyToSync?: boolean;
	incomingShare?: boolean;
	createdAt: number;
	updatedAt: number;
	attemptedAt?: number;
	payload?: ReturnType<typeof capturePayload>;
	leaseUntil?: number;
	leaseToken?: string;
	message?: string;
	ack?: CaptureAcknowledgement;
	editorToken?: string;
};
type StoredBlob = {
	draftId: string;
	position: number;
	blob: Blob;
	name: string;
	type: string;
	lastModified: number;
};
export type CaptureContext = {
	id: 'active';
	ownerId: string;
	name: string;
	administrator: boolean;
	lists: GiftList[];
	logoutUntil?: number;
};
const browserLocks = () => (typeof navigator === 'undefined' ? undefined : navigator.locks);
const editorKey = (database: string, id: string) => `gift-editor:${database}:${id}`;
const ownerKey = (ownerId: string | null) => ownerId ?? ':unbound';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export class DraftStore extends Dexie {
	drafts!: Table<LocalDraft, string>;
	blobs!: Table<StoredBlob, [string, number]>;
	context!: Table<CaptureContext, string>;
	identity!: Table<{ id: string; generation: number }, string>;
	constructor(name = 'family-gift-captures') {
		super(name);
		this.version(1).stores({
			drafts: 'id,ownerKey,status,updatedAt',
			blobs: '[draftId+position],draftId',
			context: 'id'
		});
		this.version(2)
			.stores({
				drafts: 'id,ownerKey,status,updatedAt',
				blobs: '[draftId+position],draftId',
				context: 'id'
			})
			.upgrade(async (transaction) => {
				await transaction
					.table('drafts')
					.toCollection()
					.modify((record: LocalDraft) => {
						record.ownerKey = ownerKey(record.ownerId);
						record.status ??= 'local';
						record.createdAt ??= record.updatedAt ?? Date.now();
					});
			});
		this.version(3).stores({
			drafts: 'id,ownerKey,status,updatedAt',
			blobs: '[draftId+position],draftId',
			context: 'id',
			identity: 'id'
		});
	}
	async save(input: {
		id?: string;
		ownerId: string | null;
		draft: CaptureDraft;
		photos: File[];
		editorToken?: string;
		preserve?: boolean;
		submit?: boolean;
		incomingShare?: boolean;
	}) {
		// Svelte's reactive values are copied before entering IndexedDB structured cloning.
		const draft = copy(input.draft);
		const now = Date.now();
		return this.transaction('rw', this.drafts, this.blobs, this.context, async () => {
			const active = await this.current();
			if (
				!input.preserve &&
				active?.ownerId === input.ownerId &&
				(active.logoutUntil ?? 0) > Date.now()
			)
				throw new Error('Sign-out is in progress. Cancel it before saving another draft.');
			const previous = input.id ? await this.drafts.get(input.id) : undefined;
			if (input.id && (!previous || previous.ownerId !== input.ownerId))
				throw new Error('This draft belongs to another account.');
			if (previous?.attemptedAt || previous?.status === 'saved')
				throw new Error(
					'This idea has already been attempted. Retry synchronisation before editing.'
				);
			const record: LocalDraft = {
				id: previous?.id ?? crypto.randomUUID(),
				ownerId: input.ownerId,
				ownerKey: ownerKey(input.ownerId),
				operationId: previous?.operationId ?? crypto.randomUUID(),
				draft,
				status: 'local',
				readyToSync: input.submit ?? true,
				incomingShare: input.incomingShare ?? previous?.incomingShare,
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
				editorToken: input.editorToken
			};
			await this.drafts.put(record);
			await this.blobs.where('draftId').equals(record.id).delete();
			await this.blobs.bulkPut(
				input.photos.map((file, position) => ({
					draftId: record.id,
					position,
					blob: file.slice(0, file.size, file.type),
					name: file.name,
					type: file.type,
					lastModified: file.lastModified
				}))
			);
			return record;
		});
	}
	async list(ownerId: string | null) {
		return (await this.drafts.where('ownerKey').equals(ownerKey(ownerId)).toArray())
			.filter((record) => record.ownerId === ownerId)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}
	async get(id: string, ownerId: string | null) {
		const record = await this.drafts.get(id);
		return record?.ownerId === ownerId ? record : undefined;
	}
	async files(id: string, ownerId: string | null) {
		return this.transaction('r', this.drafts, this.blobs, async () => {
			if (!(await this.get(id, ownerId)))
				throw new Error('This draft is not available to this account.');
			return (await this.blobs.where('draftId').equals(id).sortBy('position')).map(
				(item) =>
					new File([item.blob], item.name, { type: item.type, lastModified: item.lastModified })
			);
		});
	}
	async firstPhoto(id: string, ownerId: string | null) {
		return this.transaction('r', this.drafts, this.blobs, async () => {
			if (!(await this.get(id, ownerId)))
				throw new Error('This draft is not available to this account.');
			const item = await this.blobs
				.where('[draftId+position]')
				.between([id, Dexie.minKey], [id, Dexie.maxKey])
				.first();
			return item
				? new File([item.blob], item.name, { type: item.type, lastModified: item.lastModified })
				: undefined;
		});
	}
	async beginIdentityRefresh() {
		return this.transaction('rw', this.identity, async () => {
			const generation = ((await this.identity.get('generation'))?.generation ?? 0) + 1;
			await this.identity.put({ id: 'generation', generation });
			return generation;
		});
	}
	async remember(person: Identity | null, expectedGeneration?: number) {
		return this.transaction('rw', this.context, this.identity, async () => {
			const generation = (await this.identity.get('generation'))?.generation ?? 0;
			if (expectedGeneration !== undefined && expectedGeneration !== generation) return false;
			if (expectedGeneration === undefined)
				await this.identity.put({ id: 'generation', generation: generation + 1 });
			if (!person?.member) {
				await this.context.delete('active');
				return true;
			}
			const previous = await this.current();
			await this.context.put({
				id: 'active',
				ownerId: person.id,
				name: person.name,
				administrator: person.administrator,
				lists: copy(
					person.lists.filter(
						(list) => !list.archivedAt && (person.administrator || list.role === 'contributor')
					)
				),
				logoutUntil: previous?.ownerId === person.id ? previous.logoutUntil : undefined
			});
			return true;
		});
	}
	async forgetOwner(ownerId: string) {
		return this.transaction('rw', this.context, this.identity, async () => {
			if ((await this.current())?.ownerId !== ownerId) return false;
			await this.beginIdentityRefresh();
			await this.context.delete('active');
			return true;
		});
	}
	async current() {
		return this.context.get('active');
	}
	async adopt(id: string, person: Identity) {
		if (
			!person.member ||
			(!person.administrator &&
				!person.lists.some((list) => !list.archivedAt && list.role === 'contributor'))
		)
			throw new Error('Current contributor access is needed to adopt this draft.');
		return this.transaction('rw', this.drafts, async () => {
			const record = await this.get(id, null);
			if (!record || record.attemptedAt) throw new Error('Only an unbound draft can be adopted.');
			const adopted = {
				...record,
				ownerId: person.id,
				ownerKey: ownerKey(person.id),
				updatedAt: Date.now()
			};
			await this.drafts.put(adopted);
			return adopted;
		});
	}
	async attachIncoming(
		incomingId: string,
		targetId: string,
		expectedOwnerId: string | null
	): Promise<LocalDraft> {
		if (incomingId === targetId) throw new Error('Choose a different unfinished idea.');
		const locks = browserLocks();
		if (!locks) return this.attachIncomingUnlocked(incomingId, targetId, expectedOwnerId, false);
		const ids = [incomingId, targetId].sort();
		return locks.request(editorKey(this.name, ids[0]), { ifAvailable: true }, (first) => {
			if (!first)
				throw new Error('This idea is being edited in another tab. Close it and try again.');
			return locks.request(editorKey(this.name, ids[1]), { ifAvailable: true }, (second) => {
				if (!second)
					throw new Error('This idea is being edited in another tab. Close it and try again.');
				return this.attachIncomingUnlocked(incomingId, targetId, expectedOwnerId, true);
			});
		});
	}
	private async attachIncomingUnlocked(
		incomingId: string,
		targetId: string,
		expectedOwnerId: string | null,
		exclusive: boolean
	) {
		return this.transaction('rw', this.drafts, this.blobs, this.context, async () => {
			const active = await this.current();
			if (
				expectedOwnerId &&
				(active?.ownerId !== expectedOwnerId || (!active.administrator && !active.lists.length))
			)
				throw new Error('The account changed. Reopen the idea with its original account.');
			if ((active?.logoutUntil ?? 0) > Date.now())
				throw new Error('Sign-out is in progress. Cancel it before continuing this idea.');
			const incoming = await this.get(incomingId, null);
			const target = await this.get(targetId, expectedOwnerId);
			if (!incoming || !target)
				throw new Error('This unfinished idea is not available to this account.');
			for (const record of [incoming, target]) {
				if (
					record.attemptedAt ||
					['queued', 'syncing', 'saved'].includes(record.status) ||
					(record.readyToSync !== false && record.draft.browserCapture?.pendingReview !== true) ||
					(record.leaseUntil ?? 0) > Date.now()
				)
					throw new Error('Choose an unfinished idea that has not been saved or started sending.');
				if (!exclusive && record.editorToken)
					throw new Error('This idea is being edited in another tab. Close it and try again.');
			}
			const draft = copy(target.draft);
			const evidence = [draft.sourceText];
			for (const part of [
				incoming.draft.sourceText,
				incoming.draft.sourceUrl !== draft.sourceUrl ? incoming.draft.sourceUrl : '',
				incoming.draft.title,
				incoming.draft.description,
				incoming.draft.variant
			]) {
				if (part.trim() && !evidence.some((kept) => kept.includes(part))) evidence.push(part);
			}
			draft.sourceText = evidence.filter(Boolean).join('\n\n');
			if (!draft.sourceUrl.trim()) draft.sourceUrl = incoming.draft.sourceUrl;
			const photos = await this.blobs.where('draftId').equals(target.id).toArray();
			const addedPhotos = await this.blobs.where('draftId').equals(incoming.id).sortBy('position');
			const position = photos.reduce((last, photo) => Math.max(last, photo.position), -1) + 1;
			const merged: LocalDraft = {
				...target,
				draft,
				status: 'local',
				readyToSync: false,
				incomingShare: false,
				editorToken: undefined,
				message: undefined,
				updatedAt: Date.now()
			};
			await this.drafts.put(merged);
			await this.blobs.bulkPut(
				addedPhotos.map((photo, index) => ({
					...photo,
					draftId: target.id,
					position: position + index
				}))
			);
			await this.blobs.where('draftId').equals(incoming.id).delete();
			await this.drafts.delete(incoming.id);
			return merged;
		});
	}
	async lockEditor(
		id: string,
		ownerId: string | null,
		token: string
	): Promise<(() => Promise<void>) | undefined> {
		const locks = browserLocks();
		if (!locks) {
			if (!(await this.markEditor(id, ownerId, token))) return;
			return () => this.releaseEditor(id, ownerId, token);
		}
		return new Promise((resolve, reject) => {
			const completion = locks
				.request(editorKey(this.name, id), { ifAvailable: true }, async (lock) => {
					if (!lock || !(await this.markEditor(id, ownerId, token))) {
						resolve(undefined);
						return;
					}
					let release!: () => void;
					const held = new Promise<void>((done) => {
						release = done;
					});
					resolve(async () => {
						await this.releaseEditor(id, ownerId, token);
						release();
						await completion;
					});
					await held;
				})
				.catch(reject);
		});
	}
	private async markEditor(id: string, ownerId: string | null, token: string) {
		return this.transaction('rw', this.drafts, async () => {
			const record = await this.get(id, ownerId);
			if (!record || record.attemptedAt || record.status === 'saved') return false;
			await this.drafts.put({ ...record, editorToken: token });
			return true;
		});
	}
	async releaseEditor(id: string, ownerId: string | null, token: string) {
		await this.transaction('rw', this.drafts, async () => {
			const record = await this.get(id, ownerId);
			if (record?.editorToken === token)
				await this.drafts.put({ ...record, editorToken: undefined });
		});
	}
	async claim(id: string, ownerId: string) {
		const locks = browserLocks();
		if (locks)
			return locks.request(editorKey(this.name, id), { ifAvailable: true }, (lock) =>
				lock ? this.claimUnlocked(id, ownerId, true) : undefined
			);
		return this.claimUnlocked(id, ownerId, false);
	}
	private async claimUnlocked(id: string, ownerId: string, exclusive: boolean) {
		return this.transaction('rw', this.drafts, this.blobs, this.context, async () => {
			const active = await this.current();
			if (active?.ownerId === ownerId && (active.logoutUntil ?? 0) > Date.now()) return;
			const record = await this.get(id, ownerId);
			if (
				!record ||
				record.status === 'saved' ||
				record.readyToSync === false ||
				record.draft.browserCapture?.pendingReview === true ||
				(record.leaseUntil ?? 0) > Date.now() ||
				(!exclusive && !!record.editorToken)
			)
				return;
			if (!record.attemptedAt) {
				const photos = await this.blobs.where('draftId').equals(id).toArray();
				const bytes =
					new TextEncoder().encode(JSON.stringify(capturePayload(record.draft))).byteLength +
					4096 +
					photos.reduce(
						(total, photo) =>
							total + photo.blob.size + new TextEncoder().encode(photo.name).byteLength + 1024,
						0
					);
				if (bytes > 60_000_000) {
					await this.drafts.put({
						...record,
						status: 'needsattention',
						message:
							'These photos are too large together. Remove some photos or choose smaller versions, then save again.',
						updatedAt: Date.now()
					});
					return;
				}
			}
			const attempted = {
				...record,
				status: 'syncing' as const,
				attemptedAt: record.attemptedAt ?? Date.now(),
				payload: record.payload ?? capturePayload(record.draft),
				leaseUntil: Date.now() + 60_000,
				leaseToken: crypto.randomUUID(),
				message: undefined,
				updatedAt: Date.now()
			};
			await this.drafts.put(attempted);
			return attempted;
		});
	}
	async release(
		id: string,
		ownerId: string,
		message: string,
		editable = false,
		leaseToken?: string
	) {
		await this.transaction('rw', this.drafts, async () => {
			const record = await this.get(id, ownerId);
			if (!record || record.status === 'saved' || (leaseToken && record.leaseToken !== leaseToken))
				return;
			await this.drafts.put({
				...record,
				status: 'needsattention',
				leaseUntil: undefined,
				leaseToken: undefined,
				message,
				...(editable ? { attemptedAt: undefined, payload: undefined } : {}),
				updatedAt: Date.now()
			});
		});
	}
	async acknowledge(id: string, ownerId: string, ack: CaptureAcknowledgement) {
		await this.transaction('rw', this.drafts, this.blobs, async () => {
			const record = await this.get(id, ownerId);
			if (!record || record.operationId !== ack.operationId)
				throw new Error('The saved acknowledgement does not match this draft.');
			await this.drafts.put({
				...record,
				status: 'saved',
				ack,
				message: undefined,
				leaseToken: undefined,
				leaseUntil: undefined,
				updatedAt: Date.now()
			});
			await this.blobs.where('draftId').equals(id).delete();
		});
	}
	async beginSignOut(ownerId: string) {
		await this.transaction('rw', this.drafts, this.context, this.identity, async () => {
			const active = await this.current();
			if (active?.ownerId !== ownerId)
				throw new Error('The signed-in account changed. Review its drafts before signing out.');
			if ((await this.list(ownerId)).some((record) => (record.leaseUntil ?? 0) > Date.now()))
				throw new Error('Synchronisation is still running. Wait before signing out.');
			await this.beginIdentityRefresh();
			await this.context.put({ ...active, logoutUntil: Date.now() + 60_000 });
		});
	}
	async endSignOut(ownerId: string) {
		await this.transaction('rw', this.context, async () => {
			const active = await this.current();
			if (active?.ownerId === ownerId)
				await this.context.put({ ...active, logoutUntil: undefined });
		});
	}
	async discard(ownerId: string | null, id?: string) {
		await this.transaction('rw', this.drafts, this.blobs, async () => {
			const records = id
				? [await this.get(id, ownerId)].filter((record): record is LocalDraft => !!record)
				: await this.list(ownerId);
			if (records.some((record) => (record.leaseUntil ?? 0) > Date.now()))
				throw new Error('Synchronisation is still running. Wait before discarding this draft.');
			for (const record of records) {
				await this.blobs.where('draftId').equals(record.id).delete();
				await this.drafts.delete(record.id);
			}
		});
	}
}
export const draftStore = new DraftStore();
export async function requestPersistentStorage(): Promise<
	'persistent' | 'temporary' | 'unavailable'
> {
	if (typeof navigator === 'undefined' || !navigator.storage) return 'unavailable';
	try {
		if (await navigator.storage.persisted()) return 'persistent';
		if (!('persist' in navigator.storage) || typeof navigator.storage.persist !== 'function')
			return 'temporary';
		return (await navigator.storage.persist()) ? 'persistent' : 'temporary';
	} catch {
		return 'temporary';
	}
}
