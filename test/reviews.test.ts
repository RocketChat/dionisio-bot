import { summarizeReviews } from '../src/reviews';

const review = (login: string, state: string, type = 'User') => ({ user: { login, type }, state });

describe('summarizeReviews', () => {
	test('an approval satisfies the gate', () => {
		expect(summarizeReviews([review('alice', 'APPROVED')])).toEqual({
			approvals: ['alice'],
			changesRequested: [],
			satisfied: true,
		});
	});

	// The hole this closes: a drive-by comment used to count as "reviewed" and unlock the merge.
	test('a comment-only review does not satisfy the gate', () => {
		expect(summarizeReviews([review('alice', 'COMMENTED')]).satisfied).toBe(false);
	});

	// And this one: CHANGES_REQUESTED is itself a review, so it used to count as "reviewed" too.
	test('an outstanding changes-requested blocks, even alongside an approval', () => {
		const summary = summarizeReviews([review('alice', 'APPROVED'), review('bob', 'CHANGES_REQUESTED')]);

		expect(summary.changesRequested).toEqual(['bob']);
		expect(summary.satisfied).toBe(false);
	});

	test('only the latest position per reviewer counts', () => {
		expect(summarizeReviews([review('bob', 'CHANGES_REQUESTED'), review('bob', 'APPROVED')]).satisfied).toBe(true);
	});

	test('a later comment does not withdraw an earlier objection', () => {
		const summary = summarizeReviews([review('alice', 'APPROVED'), review('bob', 'CHANGES_REQUESTED'), review('bob', 'COMMENTED')]);

		expect(summary.satisfied).toBe(false);
	});

	test('a dismissed approval no longer counts', () => {
		expect(summarizeReviews([review('alice', 'APPROVED'), review('alice', 'DISMISSED')]).satisfied).toBe(false);
	});

	test('a dismissed changes-requested stops blocking', () => {
		const summary = summarizeReviews([review('alice', 'APPROVED'), review('bob', 'CHANGES_REQUESTED'), review('bob', 'DISMISSED')]);

		expect(summary.satisfied).toBe(true);
	});

	test('bot reviews are ignored', () => {
		const summary = summarizeReviews([review('dionisio-bot[bot]', 'CHANGES_REQUESTED', 'Bot'), review('alice', 'APPROVED')]);

		expect(summary.changesRequested).toEqual([]);
		expect(summary.satisfied).toBe(true);
	});

	test('a pending review is not submitted yet', () => {
		expect(summarizeReviews([review('alice', 'PENDING')]).satisfied).toBe(false);
	});

	test('no reviews at all', () => {
		expect(summarizeReviews([])).toEqual({ approvals: [], changesRequested: [], satisfied: false });
	});
});
