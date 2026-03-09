import { Context } from 'probot';
import { runQAChecks } from './qaChecks';
import { handleMessage } from './handleMessage';

const { GITHUB_LOGIN = 'dionisio-bot[bot]' } = process.env;

export const applyLabels = async (
	pullRequest: {
		mergeable?: boolean | null;
		labels: { name: string }[];
		mergeable_state: string;
		milestone?: string;
		url: string;
		number: number;
		title: string;
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
) => {
	try {
		if (context.payload.sender?.login === GITHUB_LOGIN) {
			console.log('ignoring event triggered by bot', {
				sender: context.payload.sender?.login,
				prNumber: pullRequest.number,
			});
			return;
		}

		const result = await runQAChecks(pullRequest, owner, repo, ref, context.octokit);

		if (!result) {
			return;
		}

		const { originalLabels, newLabels } = result;
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

		console.log('changing labels ->', {
			sender: context.payload.sender?.login,
			prNumber: pullRequest.number,
			ignoreUpdate,
			originalLabels,
			newLabels,
			addedLabels,
			removedLabels,
		});

		if (ignoreUpdate) {
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
	} catch (error) {
		console.log(error);
	}
};
