export type CatalogueActionKind = 'add' | 'delete';

export type CatalogueActionRequest =
	| { operationId: string; kind: 'add'; productIds: string[]; listIds: string[] }
	| { operationId: string; kind: 'delete'; productIds: string[]; impactFingerprint?: string };

export type CatalogueUndoRequest = { operationId: string; expectedActionId: string };

export type CatalogueUndoSummary = {
	actionId: string;
	kind: CatalogueActionKind;
	productCount: number;
	entryCount: number;
	createdAt: number;
};

export type CatalogueActionStatus = {
	administratorId: string;
	undo: CatalogueUndoSummary | null;
};

export type CatalogueActionAcknowledgement = {
	operationId: string;
	actionId: string;
	kind: CatalogueActionKind | 'undo';
	productCount: number;
	entryCount: number;
	effective: boolean;
};

export type CatalogueActionResult = CatalogueActionStatus & {
	acknowledgement: CatalogueActionAcknowledgement;
};

export type CatalogueDeleteImpact = {
	fingerprint: string;
	allocatedCount: number;
	purchasedCount: number;
	entries: {
		entryId: string;
		productId: string;
		listId: string;
		state: 'allocated' | 'purchased';
		version: number;
	}[];
};

export type CatalogueActionConflictReason =
	'operation-reused' | 'stale-target' | 'refresh-impact' | 'stale-undo' | 'unsafe-undo';

export type CatalogueActionError = {
	message: string;
	reason?: CatalogueActionConflictReason;
	impact?: CatalogueDeleteImpact;
};
