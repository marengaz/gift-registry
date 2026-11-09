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

export type ListDeletionFailure =
	| {
			message: string;
			reason: 'operation-reused' | 'list-unavailable';
			administratorId: string;
			listId: string;
			operationId: string;
	  }
	| { message: string; reason: 'refresh-impact'; impact: ListDeletionImpact };

export type ListVisibilityFailure = {
	message: string;
	reason: 'list-unavailable';
	administratorId: string;
	listId: string;
	archived: boolean;
};
