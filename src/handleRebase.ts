import { Context } from 'probot';
import semver from 'semver';
import { cherryPick } from './cherryPick';
import type { Log } from './logger';

export const handleRebase = async ({
	context,
	backportNumber,
	release,
	log,
}: {
	context: Context;
	backportNumber: number;
	release: string;
	log: Log;
}) => {
	if (!semver.valid(release)) {
		log.warn({ release }, 'rebase requested for an invalid release version');
		await context.octokit.issues.createComment({
			...context.issue(),
			body: 'Could not find a valid version to patch',
		});
		return;
	}

	const backportPR = await context.octokit.pulls.get({
		...context.issue(),
		pull_number: backportNumber,
	});

	const releaseBrach = await context.octokit.git.getRef({
		...context.repo(),
		ref: `heads/release-${release}`,
	});

	const tempRef = `rebase-backport-${release}-${backportNumber}`;
	log.debug({ ref: tempRef, sha: releaseBrach.data.object.sha }, 'creating temp rebase ref');
	await context.octokit.git.createRef({
		...context.repo(),
		ref: `refs/heads/${tempRef}`,
		sha: releaseBrach.data.object.sha,
	});

	try {
		if (backportPR.data.merge_commit_sha) {
			const newHeadSha = await cherryPick({
				context,
				commits: [backportPR.data.merge_commit_sha],
				head: tempRef,
				log,
			});

			await context.octokit.git.updateRef({
				...context.repo(),
				ref: `heads/backport-${release}-${backportNumber}`,
				force: true,
				sha: newHeadSha,
			});
			log.info({ backportNumber, release, sha: newHeadSha }, 'backport branch rebased');
		}
	} catch (err) {
		log.warn({ err, backportNumber, release }, 'rebase failed, restoring backport branch');
		await context.octokit.issues.createComment({
			...context.issue(),
			body: `
        Sorry, I couldn't rebase this pull request because of conflicts. Could you please solve them?

        you can do so by running the following commands:
\`\`\`
git fetch
git checkout backport-${release}-${backportNumber}
git cherry-pick ${backportPR.data.merge_commit_sha}
// solve the conflict
git push
\`\`\`

`,
		});

		await context.octokit.git.updateRef({
			...context.repo(),
			ref: `heads/backport-${release}-${backportNumber}`,
			force: true,
			sha: releaseBrach.data.object.sha,
		});

		throw err;
	}

	await context.octokit.git.deleteRef({
		...context.repo(),
		ref: `heads/${tempRef}`,
	});
};
