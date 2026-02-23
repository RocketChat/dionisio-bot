import type { Context } from 'probot';

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
	hasMilestone: boolean;
	hasInvalidTitle: boolean;
	wrongVersion?: { currentVersion: string; targetVersion: string };
	version?: string;
	targetingVersion: string[];
	originalLabels: string[];
	currentLabels: string[];
	newLabels: string[];
}

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

export interface PullRequestForQA {
	mergeable?: boolean | null;
	labels: { name: string }[];
	mergeable_state: string;
	milestone?: string;
	url: string;
	number: number;
}

export const runQAChecks = async (
	pullRequest: PullRequestForQA,
	owner: string,
	repo: string,
	ref: string,
	octokit: Context['octokit'],
): Promise<QAChecksResult | null> => {
	try {
		const hasConflicts = pullRequest.mergeable_state === 'dirty';
		const hasInvalidTitle = pullRequest.labels.some((label) => label.name === 'Invalid PR Title');

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
		const mergeable = Boolean(pullRequest.mergeable !== false && !hasConflicts);

		const wrongVersion =
			hasMilestone && !isTargetingRightVersion && targetingVersion[0]
				? { currentVersion: version, targetVersion: targetingVersion[0] }
				: undefined;

		const steps: QAStep[] = [
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
				name: 'Mergeable',
				passed: mergeable,
				message: !mergeable ? 'This PR is not mergeable' : undefined,
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
					? `Targeting wrong base: should target ${wrongVersion.targetVersion}, but targets ${wrongVersion.currentVersion}`
					: undefined,
			},
		];

		const readyToMerge = !hasConflicts && assured && Boolean(pullRequest.mergeable) && hasMilestone && !hasInvalidTitle && !wrongVersion;

		const newLabels = [...new Set([...currentLabels, 'stat: ready to merge', 'stat: conflict'])].filter((label) => {
			if (label === 'stat: conflict') return hasConflicts;
			if (label === 'stat: QA skipped' || label === 'stat: QA tested') return false;
			if (label === 'stat: ready to merge') return readyToMerge;
			return true;
		});

		return {
			readyToMerge,
			steps,
			hasConflicts,
			assured,
			mergeable,
			hasMilestone,
			hasInvalidTitle,
			wrongVersion,
			version,
			targetingVersion,
			originalLabels,
			currentLabels,
			newLabels,
		};
	} catch {
		return null;
	}
};

const CHECK_RUN_NAME = 'Dionisio QA';

export function formatCheckRunOutput(result: QAChecksResult): { title: string; summary: string } {
	const status = result.readyToMerge ? 'success' : 'failure';
	const title = result.readyToMerge ? 'Everything is fine — ready to merge' : 'Some checks did not pass';

	const stepLines = result.steps.map((step) => {
		const icon = step.passed ? '✅' : '❌';
		const msg = step.message ? ` — ${step.message}` : '';
		return `- ${icon} **${step.name}**${msg}`;
	});

	const summary = [`**Conclusion:** ${status}`, '', '### Steps', ...stepLines].join('\n');

	return { title, summary };
}

export { CHECK_RUN_NAME };
