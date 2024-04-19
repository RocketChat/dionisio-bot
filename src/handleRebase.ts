import { Context } from "probot";
import semver from "semver";
import { cherryPick } from "./cherryPick";

export const handleRebase = async ({
  context,
  backportNumber,
  release,
}: {
  context: Context;
  backportNumber: number;
  release: string;
}) => {
  const backportPR = await context.octokit.pulls.get({
    ...context.issue(),
    pull_number: backportNumber,
  });

  if (!semver.valid(release)) {
    await context.octokit.issues.createComment({
      ...context.issue(),
      body: "Could not find a valid version to patch",
    });
    return;
  }

  const releaseBrach = await context.octokit.git.getRef({
    ...context.repo(),
    ref: `heads/release-${release}`,
  });

  await context.octokit.git.updateRef({
    ...context.repo(),
    ref: `heads/backport-${release}-${backportNumber}`,
    force: true,
    sha: releaseBrach.data.object.sha,
  });

  try {
    await cherryPick({
      ...context.repo(),
      commits: [backportPR.data.merge_commit_sha!],
      head: `backport-${release}-${backportNumber}`,
      octokit: context.octokit,
    });
  } catch (err) {
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
    throw err;
  }
};
