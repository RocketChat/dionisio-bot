import { evaluateMergeDecision, type MergeCandidate } from '../src/mergeDecision';

const mergeable = (overrides: Partial<MergeCandidate> = {}): MergeCandidate => ({
	state: 'open',
	draft: false,
	merged: false,
	mergeable: true,
	mergeableState: 'clean',
	readyToMerge: true,
	hasReviews: true,
	...overrides,
});

describe('evaluateMergeDecision', () => {
	test('merges a PR that satisfies everything', () => {
		expect(evaluateMergeDecision(mergeable())).toEqual({ merge: true });
	});

	test.each([
		['already-merged', { merged: true }],
		['pr-not-open', { state: 'closed' }],
		['draft', { draft: true }],
		['mergeability-unknown', { mergeable: null }],
		['conflicts', { mergeable: false }],
		['conflicts', { mergeableState: 'dirty' }],
		['reviews', { hasReviews: false }],
		['qa-not-ready', { readyToMerge: false }],
	])('refuses with reason %s', (reason, overrides) => {
		expect(evaluateMergeDecision(mergeable(overrides as Partial<MergeCandidate>))).toEqual({ merge: false, reason });
	});

	// The state the bot used to merge on: QA passed earlier, conditions changed, nothing re-ran.
	test('refuses a PR whose review was dismissed after QA passed', () => {
		expect(evaluateMergeDecision(mergeable({ hasReviews: false, readyToMerge: true }))).toEqual({ merge: false, reason: 'reviews' });
	});

	test('refuses when the base branch moved and left conflicts', () => {
		expect(evaluateMergeDecision(mergeable({ mergeable: false, mergeableState: 'dirty' }))).toEqual({ merge: false, reason: 'conflicts' });
	});

	test('never merges on a mergeability GitHub has not finished computing', () => {
		expect(evaluateMergeDecision(mergeable({ mergeable: null, mergeableState: 'unknown' }))).toEqual({
			merge: false,
			reason: 'mergeability-unknown',
		});
	});
});
