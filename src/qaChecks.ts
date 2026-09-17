import type { Context } from 'probot';
import type { Log } from './logger';
import type { ReviewSummary } from './reviews';

export interface QAStep {
	name: string;
	passed: boolean;
	message?: string;
}

export interface QAChecksResult {
	readyToMerge: boolean;
	steps: QAStep[];
	hasConflicts: boolean;
	assured: boolean;
	mergeable: boolean;
	mergeabilityUnknown: boolean;
	isDraft: boolean;
	hasMilestone: boolean;
	hasInvalidTitle: boolean;
	wrongVersion?: { currentVersion: string; targetVersion: string };
	version?: string;
	targetingVersion: string[];
	originalLabels: string[];
	currentLabels: string[];
	newLabels: string[];
}

const MERGEABLE_STEP = 'Mergeable';

/**
 * True when mergeability is the only thing standing between this PR and a green check.
 *
 * GitHub computes mergeability lazily, and waiting for it costs seconds inside a webhook. Waiting
 * is only worth it when the answer can still change the outcome — if anything else already fails,
 * the conclusion is the same either way.
 */
export const blockedOnlyByMergeability = (result: QAChecksResult): boolean =>
	result.mergeabilityUnknown && result.steps.every((step) => step.passed || step.name === MERGEABLE_STEP);

export const normalizeVersion = (version: string) => {
	const [major, minor = 0, patch = 0] = version.split('.');
	return `${major}.${minor}.${patch}`;
};

const getProjects = async (octokit: Context['octokit'], url: string): Promise<boolean> => {
	const query = `query ($pull_request_url: URI!){
    totalCount :resource(url:$pull_request_url) {
      ... on PullRequest {
        projectsV2{
          totalCount
        }
      }
    }
  }`;

	const result = (await octokit.graphql(query, {
		pull_request_url: url,
	})) as {
		totalCount?: {
			projectsV2: {
				totalCount: number;
			};
		};
	};

	return Boolean(result.totalCount?.projectsV2.totalCount);
};

const VALID_PR_TITLE_REGEXP =
	/(feat|fix|ci|chore|docs|test|refactor|i18n|regression|revert)(\([^)]+\))?!?: .{1,}$|(?:Bump .+)$|^Release [0-9]+\.[0-9]+\.[0-9]+$|^Merge master into develop/;

export interface PullRequestForQA {
	mergeable?: boolean | null;
	draft?: boolean;
	labels: { name: string }[];
	mergeable_state: string;
	milestone?: string;
	url: string;
	number: number;
	title: string;
}

export const runQAChecks = async (
	pullRequest: PullRequestForQA,
	owner: string,
	repo: string,
	ref: string,
	octokit: Context['octokit'],
	log: Log,
): Promise<QAChecksResult | null> => {
	try {
		const hasConflicts = pullRequest.mergeable_state === 'dirty';
		const hasInvalidTitle = !VALID_PR_TITLE_REGEXP.test(pullRequest.title);

		const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
			owner,
			repo,
			path: 'package.json',
			ref,
			headers: {
				'Accept': 'application/vnd.github.raw+json',
				'X-GitHub-Api-Version': '2022-11-28',
			},
		});

		if (typeof data !== 'string') {
			log.warn({ owner, repo, ref }, 'package.json on the base ref is not a file, skipping QA checks');
			return null;
		}

		const { version: versionFromPackage } = JSON.parse(data);
		const targetingVersion = [pullRequest.milestone]
			.filter(Boolean)
			.filter((milestone): milestone is string => Boolean(milestone && /(\d+\.\d+(\.\d+)?)/.test(milestone)));

		const hasMilestone = Boolean(pullRequest.milestone || (await getProjects(octokit, pullRequest.url)));

		const [version] = versionFromPackage.split('-');
		const isTargetingRightVersion = targetingVersion.some((m) => version.startsWith(m));

		const originalLabels = pullRequest.labels.map((label) => label.name);
		const currentLabels = originalLabels.map((label) => {
			if (label === 'stat: QA tested' || label === 'stat: QA skipped') {
				return 'stat: QA assured';
			}
			return label;
		});

		const assured = Boolean(currentLabels.includes('stat: QA assured'));
		const isDraft = Boolean(pullRequest.draft);
		// GitHub reports `null` while it is still computing mergeability. That is not the same as
		// "mergeable", and conflating the two is what let the summary contradict its own steps.
		const mergeabilityUnknown = pullRequest.mergeable === null || pullRequest.mergeable === undefined;
		const mergeable = pullRequest.mergeable === true && !hasConflicts;

		const wrongVersion =
			hasMilestone && !isTargetingRightVersion && targetingVersion[0]
				? { currentVersion: version, targetVersion: targetingVersion[0] }
				: undefined;

		const mergeableMessage = () => {
			if (mergeable) {
				return undefined;
			}
			return mergeabilityUnknown ? 'GitHub is still computing mergeability — this will refresh shortly' : 'This PR is not mergeable';
		};

		const steps: QAStep[] = [
			{
				name: 'Ready for review',
				passed: !isDraft,
				message: isDraft ? 'This PR is still a draft' : undefined,
			},
			{
				name: 'No merge conflicts',
				passed: !hasConflicts,
				message: hasConflicts ? 'This PR has conflicts, please resolve them before merging' : undefined,
			},
			{
				name: 'QA assured',
				passed: assured,
				message: !assured ? "This PR is missing the 'stat: QA assured' label" : undefined,
			},
			{
				name: MERGEABLE_STEP,
				passed: mergeable,
				message: mergeableMessage(),
			},
			{
				name: 'Has milestone or project',
				passed: hasMilestone,
				message: !hasMilestone ? 'This PR is missing the required milestone or project' : undefined,
			},
			{
				name: 'Valid PR title',
				passed: !hasInvalidTitle,
				message: hasInvalidTitle ? 'This PR has an invalid title' : undefined,
			},
			{
				name: 'Correct target version',
				passed: !wrongVersion,
				message: wrongVersion
					? `This PR is targeting the wrong base branch. It should target ${normalizeVersion(
							wrongVersion.targetVersion,
						)}, but it targets ${normalizeVersion(wrongVersion.currentVersion)}`
					: undefined,
			},
		];

		// Derived from the same values the steps render, so the two can never disagree.
		const readyToMerge = steps.every((step) => step.passed);

		const newLabels = [...new Set([...currentLabels, 'stat: ready to merge', 'stat: conflict', 'Invalid PR Title'])].filter((label) => {
			if (label === 'stat: conflict') return hasConflicts;
			if (label === 'stat: QA skipped' || label === 'stat: QA tested') return false;
			if (label === 'stat: ready to merge') return readyToMerge;
			if (label === 'Invalid PR Title') return hasInvalidTitle;
			return true;
		});

		return {
			readyToMerge,
			steps,
			hasConflicts,
			assured,
			mergeable,
			mergeabilityUnknown,
			isDraft,
			hasMilestone,
			hasInvalidTitle,
			wrongVersion,
			version,
			targetingVersion,
			originalLabels,
			currentLabels,
			newLabels,
		};
	} catch (error) {
		log.error({ err: error, prNumber: pullRequest.number, ref }, 'QA checks failed to run');
		return null;
	}
};

const CHECK_RUN_NAME = 'Dionisio QA';

export type CheckConclusion = 'success' | 'failure' | 'neutral';

export interface CheckVerdict {
	conclusion: CheckConclusion;
	title: string;
	steps: QAStep[];
}

const reviewStep = (reviews: ReviewSummary): QAStep => {
	if (reviews.changesRequested.length > 0) {
		return { name: 'Reviewed', passed: false, message: `Changes requested by ${reviews.changesRequested.join(', ')}` };
	}

	if (reviews.approvals.length === 0) {
		return { name: 'Reviewed', passed: false, message: 'This PR has not been approved yet' };
	}

	return { name: 'Reviewed', passed: true };
};

/**
 * The single place a conclusion is decided. Everything user-facing renders from the verdict,
 * so the badge, the title and the step list cannot drift apart.
 *
 * Invariant: `conclusion === 'success'` if and only if every step passed.
 */
export const buildCheckVerdict = (result: QAChecksResult, gates: { reviews: ReviewSummary }): CheckVerdict => {
	const steps = [...result.steps, reviewStep(gates.reviews)];

	if (result.isDraft) {
		return { conclusion: 'neutral', title: 'Draft — not ready for review', steps };
	}

	if (gates.reviews.changesRequested.length > 0) {
		return { conclusion: 'failure', title: 'Changes requested', steps };
	}

	if (gates.reviews.approvals.length === 0) {
		return { conclusion: 'neutral', title: 'Waiting for reviews', steps };
	}

	if (result.mergeabilityUnknown) {
		return { conclusion: 'neutral', title: 'Waiting for GitHub to compute mergeability', steps };
	}

	return steps.every((step) => step.passed)
		? { conclusion: 'success', title: 'Everything is fine — ready to merge', steps }
		: { conclusion: 'failure', title: 'Some checks did not pass', steps };
};

export function formatCheckRunOutput(verdict: CheckVerdict): { title: string; summary: string } {
	const stepLines = verdict.steps.map((step) => {
		const icon = step.passed ? '✅' : '❌';
		const msg = step.message ? ` — ${step.message}` : '';
		return `- ${icon} **${step.name}**${msg}`;
	});

	return {
		title: verdict.title,
		summary: [`**Conclusion:** ${verdict.conclusion}`, '', '### Steps', ...stepLines].join('\n'),
	};
}

export { CHECK_RUN_NAME };
