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
		const ignoreUpdate = botComment && botComment.body === message;

		if (ignoreUpdate) {
			log.debug('QA comment and labels unchanged');
			return;
		}

		if (botComment) {
			await context.octokit.issues.updateComment({
				...context.issue(),
				comment_id: botComment.id,
				body: message,
			});
		} else {
			await context.octokit.issues.createComment({
				...context.issue(),
				body: message,
			});
		}

		await context.octokit.issues.setLabels({
			...context.issue(),
			labels: newLabels,
		});

		if (addedLabels.length > 0 || removedLabels.length > 0) {
			log.info({ addedLabels, removedLabels }, 'QA labels changed');
		} else {
			log.debug('QA comment updated, labels unchanged');
		}
	} catch (error) {
		log.error({ err: error }, 'applying QA labels failed');
	}
};
