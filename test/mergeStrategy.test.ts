import { chooseMergeStrategy, type MergeCapabilities } from '../src/mergeStrategy';

const caps = (overrides: Partial<MergeCapabilities> = {}): MergeCapabilities => ({
	hasMergeQueue: false,
	allowAutoMerge: false,
	mergeableState: 'clean',
	allowDirectSquash: true,
	...overrides,
});

describe('chooseMergeStrategy', () => {
	// The bug: a rejected enqueue used to fall through to a direct squash, bypassing the queue.
	test('a branch with a merge queue always uses the queue', () => {
		expect(chooseMergeStrategy(caps({ hasMergeQueue: true }))).toEqual({ strategy: 'queue' });
	});

	test('never squashes on a merge-queue branch, whatever else is true', () => {
		for (const allowAutoMerge of [true, false]) {
			for (const allowDirectSquash of [true, false]) {
				for (const mergeableState of ['clean', 'blocked', 'behind', 'unstable']) {
					const choice = chooseMergeStrategy(caps({ hasMergeQueue: true, allowAutoMerge, allowDirectSquash, mergeableState }));

					expect(choice).not.toEqual({ strategy: 'squash' });
				}
			}
		}
	});

	test('prefers auto-merge when the repository allows it', () => {
		expect(chooseMergeStrategy(caps({ allowAutoMerge: true }))).toEqual({ strategy: 'auto-merge' });
	});

	// Failing to detect a queue must not be read as "there is no queue".
	test('refuses to squash when the merge queue lookup failed', () => {
		expect(chooseMergeStrategy(caps({ hasMergeQueue: null }))).toEqual({ skip: 'merge-queue-unknown' });
	});

	test('still uses auto-merge when the merge queue lookup failed', () => {
		expect(chooseMergeStrategy(caps({ hasMergeQueue: null, allowAutoMerge: true }))).toEqual({ strategy: 'auto-merge' });
	});

	test('squashes only when nothing else is available and the state is clean', () => {
		expect(chooseMergeStrategy(caps())).toEqual({ strategy: 'squash' });
	});

	test.each(['blocked', 'behind', 'unstable', 'dirty', 'unknown'])('refuses to squash a %s pull request', (mergeableState) => {
		expect(chooseMergeStrategy(caps({ mergeableState }))).toEqual({ skip: 'squash-not-clean' });
	});

	test('respects the kill switch', () => {
		expect(chooseMergeStrategy(caps({ allowDirectSquash: false }))).toEqual({ skip: 'squash-disabled' });
	});
});
