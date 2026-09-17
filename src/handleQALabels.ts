import { Context } from 'probot';
import { runQAChecks } from './qaChecks';
import { handleMessage } from './handleMessage';
import { isExternalContributor } from './isExternalContributor';
import type { Log } from './logger';

const { GITHUB_LOGIN = 'dionisio-bot[bot]', COMMUNITY_LABEL_EXCLUDED_EXTRA = '' } = process.env;

const COMMUNITY_LABEL_EXCLUDED_AUTHORS = [
	GITHUB_LOGIN,
	'github-copilot[bot]',
	...COMMUNITY_LABEL_EXCLUDED_EXTRA.split(',')
		.map((login) => login.trim())
		.filter(Boolean),
];

/**
 * Applies this run's decisions on top of whatever labels the PR carries now, so labels the bot
 * never decided anything about survive — including ones added since the event arrived.
 */
export const nextLabels = (currentNames: string[], addedLabels: string[], removedLabels: string[]): string[] => [
	...new Set([...currentNames.filter((label) => !removedLabels.includes(label)), ...addedLabels]),
];

const sameLabels = (a: string[], b: string[]) => a.length === b.length && a.every((label) => b.includes(label));

/**
 * Applies only the labels this run decided to change.
 *
 * `setLabels` replaces the whole set, so writing the list captured when the event arrived would
 * drop anything a human added in between. Re-reading first and applying the delta keeps those.
 */
const reconcileLabels = async (
	context: Context,
	{ addedLabels, removedLabels }: { addedLabels: string[]; removedLabels: string[] },
	log: Log,
) => {
	if (addedLabels.length === 0 && removedLabels.length === 0) {
		log.debug('QA labels unchanged');
		return;
	}

	const current = await context.octokit.paginate(context.octokit.issues.listLabelsOnIssue, {
		...context.issue(),
		per_page: 100,
	});
	const currentNames = current.map((label) => label.name);
	const finalLabels = nextLabels(currentNames, addedLabels, removedLabels);

	if (sameLabels(finalLabels, currentNames)) {
		log.debug('QA labels already up to date');
		return;
	}

	await context.octokit.issues.setLabels({
		...context.issue(),
		labels: finalLabels,
	});

	log.info({ addedLabels, removedLabels }, 'QA labels changed');
};

export const applyLabels = async (
	pullRequest: {
		mergeable?: boolean | null;
		labels: { name: string }[];
		mergeable_state: string;
		milestone?: string;
		url: string;
		number: number;
		title: string;
		user?: { login?: string } | null;
	},
	owner: string,
	repo: string,
	ref: string,
	context: Context<
		| 'pull_request.opened'
		| 'pull_request.synchronize'
		| 'pull_request.edited'
		| 'pull_request.labeled'
		| 'pull_request.unlabeled'
		| 'issues.milestoned'
		| 'issues.demilestoned'
	>,
	log: Log,
) => {
	try {
		if (context.payload.sender?.login === GITHUB_LOGIN) {
			log.debug('ignoring event triggered by the bot itself');
			return;
		}

		const result = await runQAChecks(pullRequest, owner, repo, ref, context.octokit, log);

		if (!result) {
			return;
		}

		const { originalLabels } = result;
		let newLabels = result.newLabels;
		const authorLogin = pullRequest.user?.login;
		if (authorLogin && !COMMUNITY_LABEL_EXCLUDED_AUTHORS.includes(authorLogin)) {
			const external = await isExternalContributor(context.octokit, authorLogin, log);
			if (external && !newLabels.includes('community')) {
				newLabels = [...newLabels, 'community'];
			}
		}
		const addedLabels = newLabels.filter((label) => !originalLabels.includes(label));
		const removedLabels = originalLabels.filter((label) => !newLabels.includes(label));

		const message = await handleMessage({
			assured: result.assured,
			hasConflicts: result.hasConflicts,
			mergeable: result.mergeable,
			hasMilestone: result.hasMilestone,
			hasInvalidTitle: result.hasInvalidTitle,
			wrongVersion: result.wrongVersion,
		});

		const comments = await context.octokit.issues.listComments({
			...context.issue(),
		});

		const botComment = comments.data.find((comment) => comment.user?.login === GITHUB_LOGIN);

		// The comment and the labels are reconciled independently. An unchanged comment used to
		// short-circuit the label write as well, so a label removed by hand was never restored.
		if (!botComment) {
			await context.octokit.issues.createComment({
				...context.issue(),
				body: message,
			});
		} else if (botComment.body !== message) {
			await context.octokit.issues.updateComment({
				...context.issue(),
				comment_id: botComment.id,
				body: message,
			});
		} else {
			log.debug('QA comment unchanged');
		}

		await reconcileLabels(context, { addedLabels, removedLabels }, log);
	} catch (error) {
		log.error({ err: error }, 'applying QA labels failed');
	}
};
