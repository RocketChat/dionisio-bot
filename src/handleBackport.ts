import { Context } from 'probot';
import semver from 'semver';
import { upsertProject } from './upsertProject';
import { ErrorCherryPickConflict } from './errors/ErrorCherryPickConflict';
import { consoleProps } from './createPullRequest';

export const handleBackport = async ({
	context,
	pr,
	tags,
	assignee,
}: {
	context: Context;
	pr: {
		merge_commit_sha: string | null;
		node_id: string;
		title: string;
		author: string;
		number: number;
	};
	tags: string[];
	assignee: string;
}) => {
	if (tags.length === 0) {
		await context.octokit.issues.createComment({
			...context.issue(),
			body: 'Please provide a list of tags to backport',
		});
		return;
	}

	// Filter out the tags that are already in the project

	try {
		await Promise.allSettled(
			tags.map(async (tag): Promise<void> => {
				console.log('tag', tag);
				const result = await context.octokit.repos
					.getReleaseByTag({
						...context.repo(),
						tag,
					})
					.catch(() => undefined);

				if (result?.data) {
					await context.octokit.issues.createComment({
						...context.issue(),
						body: `${tag} already exists in the project`,
					});
					return;
				}

				const ver = semver.patch(tag) - 1;

				console.log('ver', ver);

				if (ver < 0) {
					return;
				}

				const previousTag = semver.major(tag) + '.' + semver.minor(tag) + '.' + ver;

				console.log('previousTag', previousTag);

				try {
					await context.octokit.repos.getReleaseByTag({
						...context.repo(),
						tag: previousTag,
					});
				} catch (err) {
					console.log('Failed to get previous tag', previousTag, err);
					throw err;
				}
				try {
					await upsertProject(
						context,
						tag,
						consoleProps('upsertProject', {
							id: pr.node_id,
							sha: pr.merge_commit_sha,
							title: pr.title,
							number: pr.number,
							author: pr.author,
						}),
						previousTag,
						assignee,
					);
				} catch (err) {
					if (err instanceof ErrorCherryPickConflict) {
						context.octokit.issues.createComment({
							...context.issue(),
							body: `
  Sorry, I couldn't do that backport because of conflicts. Could you please solve them?
  
  you can do so by running the following commands:
  \`\`\`
  git fetch
  git checkout ${err.arg.head}
  git cherry-pick ${err.arg.commits.join(' ')}
  // solve the conflict
  git push
  \`\`\`
  
  
  after that just run \`/backport ${tag}\` again
  `,
						});
					}
					console.log(err);
				}
			}),
		);
	} catch (err) {
		console.log(err);
	}
};
