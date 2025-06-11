import { Context } from 'probot';
import { cherryPick } from './cherryPick';
import { ErrorCherryPickConflict } from './errors/ErrorCherryPickConflict';

export const consoleProps = <T>(title: string, args: T) => {
	console.log(title, JSON.stringify(args, null, 2));
	return args;
};

export const createPullRequest = async (
	context: Context,
	release: string,
	pr: {
		id: string;
		sha: string;
		number: number;
		title: string;
		author: string;
	},
	commit_sha: string,
	base: string,
	assignee: string,
) => {
	const milestone = (
		await context.octokit.issues.listMilestones({
			...context.repo(),
			direction: 'desc',
			state: 'all',
		})
	).data.find((tag) => {
		const [major, minor] = release.split('.');
		return tag.title === `${major}.${minor}`;
	});

	const ref = await context.octokit.git
		.createRef(
			consoleProps(`Create ref for backport`, {
				...context.repo(),
				ref: `refs/heads/backport-${release}-${pr.number}`,
				sha: commit_sha,
			}),
		)
		.catch(() => undefined);

	/**
	 * if the ref was created we should try to cherry pick
	 * if not just open the pull request
	 */
	if (ref) {
		try {
			await cherryPick(
				consoleProps(`Cherry-pick backport`, {
					...context.repo(),
					commits: [pr.sha],
					head: `backport-${release}-${pr.number}`,
					context,
				}),
			);
		} catch (e) {
			console.log(e);
			throw new ErrorCherryPickConflict({
				...context.repo(),
				commits: [pr.sha],
				head: `backport-${release}-${pr.number}`,
				base,
			});
		}
	}

	const pullRequest = await context.octokit.pulls.create(
		consoleProps(`Created backport PR`, {
			...context.repo(),
			title: pr.title,
			head: `backport-${release}-${pr.number}`,
			base: `release-${release}`,
			body: `Backport of #${pr.number}`,
		}),
	);

	await context.octokit.pulls.requestReviewers({
		...context.repo(),
		pull_number: pullRequest.data.number,
		reviewers: [pr.author],
	});

	await context.octokit.issues
		.update({
			...context.repo(),
			issue_number: pullRequest.data.number,
			...(milestone?.number && { milestone: milestone.number }),
			assignees: [assignee],
		})
		.catch(() => undefined);

	await context.octokit.issues.addLabels({
		...context.repo(),
		issue_number: pullRequest.data.number,
		labels: ['backport'],
	});

	return pullRequest;
};
