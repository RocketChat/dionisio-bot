import { Context } from "probot";
import semver from "semver";
import { upsertProject } from "./upsertProject";
import { ErrorCherryPickConflict } from "./errors/ErrorCherryPickConflict";

export const handlePatch = async ({
  context,
  pr,
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
  assignee: string;
}) => {
  const latestRelease = await context.octokit.repos.getLatestRelease(
    context.repo()
  );

  const pathRelease = semver.inc(latestRelease.data.tag_name, "patch");
  if (!pathRelease) {
    await context.octokit.issues.createComment({
      ...context.issue(),
      body: "Could not find a valid version to patch",
    });
    return;
  }

  try {
    await upsertProject(
      context,
      pathRelease,
      {
        id: pr.node_id,
        sha: pr.merge_commit_sha,
        title: pr.title,
        number: pr.number,
        author: pr.author,
      },
      latestRelease.data.tag_name,
      assignee,
      "master"
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
git cherry-pick ${err.arg.commits.join(" ")}
// solve the conflict
git push
\`\`\`


after that just run \`/patch\` again
`,
      });
    }
    console.log(err);
  }
};
