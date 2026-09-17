export interface ReviewSummary {
	approvals: string[];
	changesRequested: string[];
	/** At least one approval and nothing outstanding against it. */
	satisfied: boolean;
}

interface ReviewLike {
	user?: { login?: string; type?: string } | null;
	state: string;
}

/**
 * Reduces a review list to where each human currently stands, following GitHub's own rules:
 * only the latest review that expresses a position counts, and a later comment does not withdraw
 * an earlier objection.
 *
 * Reviews must be in the order the API returns them, oldest first.
 */
export const summarizeReviews = (reviews: ReviewLike[]): ReviewSummary => {
	const stance = new Map<string, string>();

	for (const review of reviews) {
		const login = review.user?.login;

		if (!login || review.user?.type === 'Bot') {
			continue;
		}

		const state = review.state.toUpperCase();

		// A comment expresses no position, and a pending review has not been submitted.
		if (state === 'COMMENTED' || state === 'PENDING') {
			continue;
		}

		// A dismissed review no longer counts for or against.
		if (state === 'DISMISSED') {
			stance.delete(login);
			continue;
		}

		stance.set(login, state);
	}

	const entries = [...stance.entries()];
	const approvals = entries.filter(([, state]) => state === 'APPROVED').map(([login]) => login);
	const changesRequested = entries.filter(([, state]) => state === 'CHANGES_REQUESTED').map(([login]) => login);

	return {
		approvals,
		changesRequested,
		satisfied: approvals.length > 0 && changesRequested.length === 0,
	};
};
