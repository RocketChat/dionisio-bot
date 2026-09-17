import {
	blockedOnlyByMergeability,
	buildCheckVerdict,
	formatCheckRunOutput,
	runQAChecks,
	type PullRequestForQA,
	type QAChecksResult,
	type QAStep,
} from '../src/qaChecks';
import type { Log } from '../src/logger';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Log;

// runQAChecks only needs `request` (package.json on the base ref) and `graphql` (projects lookup).
const fakeOctokit = (version = '7.10.1') =>
	({
		request: async () => ({ data: JSON.stringify({ version }) }),
		graphql: async () => ({ totalCount: { projectsV2: { totalCount: 0 } } }),
	}) as never;

const prForQA = (overrides: Partial<PullRequestForQA> = {}): PullRequestForQA => ({
	mergeable: true,
	draft: false,
	labels: [{ name: 'stat: QA assured' }],
	mergeable_state: 'clean',
	milestone: '7.10.1',
	url: 'https://github.com/o/r/pull/1',
	number: 1,
	title: 'fix: something',
	...overrides,
});

const step = (name: string, passed: boolean): QAStep => ({ name, passed });

const approved = { approvals: ['alice'], changesRequested: [], satisfied: true };
const unreviewed = { approvals: [], changesRequested: [], satisfied: false };
const blocked = { approvals: ['alice'], changesRequested: ['bob'], satisfied: false };

const result = (overrides: Partial<QAChecksResult> = {}): QAChecksResult => {
	const steps = overrides.steps ?? [
		step('Ready for review', true),
		step('No merge conflicts', true),
		step('QA assured', true),
		step('Mergeable', true),
		step('Has milestone or project', true),
		step('Valid PR title', true),
		step('Correct target version', true),
	];

	return {
		steps,
		readyToMerge: steps.every((s) => s.passed),
		hasConflicts: false,
		assured: true,
		mergeable: true,
		mergeabilityUnknown: false,
		isDraft: false,
		hasMilestone: true,
		hasInvalidTitle: false,
		targetingVersion: [],
		originalLabels: [],
		currentLabels: [],
		newLabels: [],
		...overrides,
	};
};

describe('runQAChecks', () => {
	const run = (pr: Partial<PullRequestForQA>) => runQAChecks(prForQA(pr), 'o', 'r', 'develop', fakeOctokit(), silentLog);

	test('a clean, assured, milestoned PR is ready to merge', async () => {
		const qa = await run({});

		expect(qa?.readyToMerge).toBe(true);
		expect(qa?.steps.every((s) => s.passed)).toBe(true);
	});

	// The original defect: `mergeable: null` rendered a ✅ step while readyToMerge went false,
	// producing "Conclusion: failure" under an all-green step list.
	test('unknown mergeability never yields a passing step', async () => {
		const qa = await run({ mergeable: null });

		expect(qa?.mergeabilityUnknown).toBe(true);
		expect(qa?.steps.find((s) => s.name === 'Mergeable')?.passed).toBe(false);
		expect(qa?.readyToMerge).toBe(false);
	});

	test('a draft is not ready to merge', async () => {
		const qa = await run({ draft: true });

		expect(qa?.isDraft).toBe(true);
		expect(qa?.readyToMerge).toBe(false);
		expect(qa?.newLabels).not.toContain('stat: ready to merge');
	});

	// Guards the seam the bug lived in: steps and readyToMerge must be one decision.
	test('readyToMerge always equals "every step passed"', async () => {
		const cases: Partial<PullRequestForQA>[] = [
			{},
			{ mergeable: null },
			{ mergeable: false },
			{ draft: true },
			{ mergeable_state: 'dirty' },
			{ labels: [] },
			{ title: 'not a conventional title' },
			{ milestone: undefined },
			{ milestone: '8.0.0' },
		];

		for (const override of cases) {
			const qa = await run(override);

			expect(qa).not.toBeNull();
			expect(qa?.readyToMerge).toBe(qa?.steps.every((s) => s.passed));
		}
	});
});

describe('blockedOnlyByMergeability', () => {
	// Decides whether waiting on GitHub is worth seconds inside a webhook.
	test('true when mergeability is the last thing missing', async () => {
		const qa = await runQAChecks(prForQA({ mergeable: null }), 'o', 'r', 'develop', fakeOctokit(), silentLog);

		expect(blockedOnlyByMergeability(qa!)).toBe(true);
	});

	test('false when something else already fails, so the answer cannot change the outcome', async () => {
		const qa = await runQAChecks(prForQA({ mergeable: null, labels: [] }), 'o', 'r', 'develop', fakeOctokit(), silentLog);

		expect(blockedOnlyByMergeability(qa!)).toBe(false);
	});

	test('false once mergeability is known', async () => {
		const qa = await runQAChecks(prForQA({ mergeable: true }), 'o', 'r', 'develop', fakeOctokit(), silentLog);

		expect(blockedOnlyByMergeability(qa!)).toBe(false);
	});
});

describe('buildCheckVerdict', () => {
	test('a fully passing, reviewed PR succeeds', () => {
		const verdict = buildCheckVerdict(result(), { reviews: approved });

		expect(verdict.conclusion).toBe('success');
		expect(verdict.steps.every((s) => s.passed)).toBe(true);
	});

	test('unknown mergeability is neutral, never a silent pass', () => {
		const steps = result().steps.map((s) => (s.name === 'Mergeable' ? step('Mergeable', false) : s));
		const verdict = buildCheckVerdict(result({ steps, mergeable: false, mergeabilityUnknown: true }), { reviews: approved });

		expect(verdict.conclusion).toBe('neutral');
		expect(verdict.title).toBe('Waiting for GitHub to compute mergeability');
	});

	test('a draft is neutral even when everything else passes', () => {
		const steps = result().steps.map((s) => (s.name === 'Ready for review' ? step('Ready for review', false) : s));
		const verdict = buildCheckVerdict(result({ steps, isDraft: true }), { reviews: approved });

		expect(verdict.conclusion).toBe('neutral');
		expect(verdict.title).toBe('Draft — not ready for review');
	});

	test('an unreviewed PR is neutral and says so in the steps', () => {
		const verdict = buildCheckVerdict(result(), { reviews: unreviewed });

		expect(verdict.conclusion).toBe('neutral');
		expect(verdict.title).toBe('Waiting for reviews');
		expect(verdict.steps.find((s) => s.name === 'Reviewed')?.passed).toBe(false);
	});

	test('a failing step produces failure', () => {
		const steps = result().steps.map((s) => (s.name === 'QA assured' ? step('QA assured', false) : s));
		const verdict = buildCheckVerdict(result({ steps }), { reviews: approved });

		expect(verdict.conclusion).toBe('failure');
	});

	// "Changes requested" must never be printed over an all-green step list — that is the same
	// contradiction the conclusion line used to produce, arriving through the review gate.
	test('changes requested fails and names who is blocking, in the steps', () => {
		const verdict = buildCheckVerdict(result(), { reviews: blocked });

		expect(verdict.conclusion).toBe('failure');
		expect(verdict.title).toBe('Changes requested');

		const reviewed = verdict.steps.find((s) => s.name === 'Reviewed');
		expect(reviewed?.passed).toBe(false);
		expect(reviewed?.message).toContain('bob');
		expect(verdict.steps.every((s) => s.passed)).toBe(false);
	});

	// This is the regression that produced "Conclusion: failure" under six green steps.
	test('conclusion is success if and only if every step passed', () => {
		const names = ['Ready for review', 'No merge conflicts', 'QA assured', 'Mergeable', 'Has milestone or project'];

		for (const failing of [null, ...names]) {
			for (const reviews of [approved, unreviewed, blocked]) {
				const steps = result().steps.map((s) => (s.name === failing ? step(s.name, false) : s));
				const verdict = buildCheckVerdict(
					result({
						steps,
						isDraft: failing === 'Ready for review',
						mergeabilityUnknown: failing === 'Mergeable',
					}),
					{ reviews },
				);

				expect(verdict.conclusion === 'success').toBe(verdict.steps.every((s) => s.passed));
			}
		}
	});
});

describe('formatCheckRunOutput', () => {
	test('the summary reports the emitted conclusion, not a recomputed one', () => {
		const verdict = buildCheckVerdict(result(), { reviews: unreviewed });
		const { title, summary } = formatCheckRunOutput(verdict);

		expect(verdict.conclusion).toBe('neutral');
		expect(summary).toContain('**Conclusion:** neutral');
		expect(summary).not.toContain('**Conclusion:** success');
		expect(title).toBe(verdict.title);
	});

	test('every failing step explains itself', () => {
		const steps = [step('Ready for review', true), { name: 'QA assured', passed: false, message: 'missing label' }];
		const { summary } = formatCheckRunOutput(buildCheckVerdict(result({ steps }), { reviews: approved }));

		expect(summary).toContain('- ✅ **Ready for review**');
		expect(summary).toContain('- ❌ **QA assured** — missing label');
	});
});
