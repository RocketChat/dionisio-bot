export type MergeDecision = { merge: true } | { merge: false; reason: MergeSkipReason };

export type MergeSkipReason =
	| 'already-merged'
	| 'pr-not-open'
	| 'draft'
	| 'mergeability-unknown'
	| 'conflicts'
	| 'reviews'
	| 'qa-not-ready';

export interface MergeCandidate {
	state: string;
	draft: boolean;
	merged: boolean;
	mergeable: boolean | null;
	mergeableState: string;
	readyToMerge: boolean;
	hasReviews: boolean;
}

/**
 * Decides whether a pull request may be merged, from a snapshot taken just now.
 *
 * Pure on purpose: the merge used to be authorised by whatever conclusion the check run happened
 * to be storing, which could have been computed hours earlier under different conditions.
 * The `reason` is logged, so "why did it not merge?" is answerable without reproducing the state.
 */
export const evaluateMergeDecision = (pr: MergeCandidate): MergeDecision => {
	if (pr.merged) {
		return { merge: false, reason: 'already-merged' };
	}

	if (pr.state !== 'open') {
		return { merge: false, reason: 'pr-not-open' };
	}

	if (pr.draft) {
		return { merge: false, reason: 'draft' };
	}

	// Never act on a mergeability GitHub has not finished computing.
	if (pr.mergeable === null) {
		return { merge: false, reason: 'mergeability-unknown' };
	}

	if (!pr.mergeable || pr.mergeableState === 'dirty') {
		return { merge: false, reason: 'conflicts' };
	}

	if (!pr.hasReviews) {
		return { merge: false, reason: 'reviews' };
	}

	if (!pr.readyToMerge) {
		return { merge: false, reason: 'qa-not-ready' };
	}

	return { merge: true };
};
