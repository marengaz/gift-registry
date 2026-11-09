export type ListDeletionImpact = {
	administratorId: string;
	listId: string;
	listName: string;
	recipientName: string;
	fingerprint: string;
	productCount: number;
	orphanProductCount: number;
	allocatedCount: number;
	purchasedCount: number;
};

export type ListDeleteCommand = {
	operationId: string;
	deleteOrphans: boolean;
	impactFingerprint: string;
};

export type ListDeletionAcknowledgement = {
	administratorId: string;
	listId: string;
	operationId: string;
	deleteOrphans: boolean;
	productCount: number;
	deletedProductCount: number;
	keptProductCount: number;
};

export type ListDeletionConflictReason = 'operation-reused' | 'refresh-impact';

export type ListDeletionConflict =
	| { message: string; reason: 'operation-reused' }
	| { message: string; reason: 'refresh-impact'; impact: ListDeletionImpact };
