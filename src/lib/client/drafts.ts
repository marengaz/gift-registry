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
	createdAt: number;
	updatedAt: number;
	attemptedAt?: number;
	payload?: ReturnType<typeof capturePayload>;
	leaseUntil?: number;
	leaseToken?: string;
	message?: string;
	ack?: CaptureAcknowledgement;
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
const ownerKey = (ownerId: string | null) => ownerId ?? ':unbound';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export class DraftStore extends Dexie {
	drafts!: Table<LocalDraft, string>;
	blobs!: Table<StoredBlob, [string, number]>;
	context!: Table<CaptureContext, string>;
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
	}
	async save(input: { id?: string; ownerId: string | null; draft: CaptureDraft; photos: File[] }) {
		// Svelte's reactive values are copied before entering IndexedDB structured cloning.
		const draft = copy(input.draft);
		const now = Date.now();
		return this.transaction('rw', this.drafts, this.blobs, this.context, async () => {
			const active = await this.current();
			if (active?.ownerId === input.ownerId && (active.logoutUntil ?? 0) > Date.now())
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
				createdAt: previous?.createdAt ?? now,
				updatedAt: now
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
	async remember(person: Identity | null) {
		if (!person?.member) {
			await this.context.delete('active');
			return;
		}
		await this.transaction('rw', this.context, async () => {
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
	async claim(id: string, ownerId: string) {
		return this.transaction('rw', this.drafts, this.context, async () => {
			const active = await this.current();
			if (active?.ownerId === ownerId && (active.logoutUntil ?? 0) > Date.now()) return;
			const record = await this.get(id, ownerId);
			if (!record || record.status === 'saved' || (record.leaseUntil ?? 0) > Date.now()) return;
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
		await this.transaction('rw', this.drafts, this.context, async () => {
			const active = await this.current();
			if (active?.ownerId !== ownerId)
				throw new Error('The signed-in account changed. Review its drafts before signing out.');
			if ((await this.list(ownerId)).some((record) => (record.leaseUntil ?? 0) > Date.now()))
				throw new Error('Synchronisation is still running. Wait before signing out.');
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
