import { Context } from "probot";
import { cherryPick } from "./cherryPick";

const consoleProps = <T>(title: string, args: T) => {
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
  base: string = "master"
) => {
  const branch = await context.octokit.repos.getBranch({
    ...context.repo(),
    branch: `release-${base}`,
  });

  await context.octokit.git.createRef(
    consoleProps(`Create ref for backport`, {
      ...context.repo(),
      ref: `refs/heads/backport-${release}-${pr.number}`,
      sha: branch.data.commit.sha,
    })
  );

  await cherryPick(
    consoleProps(`Cherry-pick backport`, {
      ...context.repo(),
      commits: [pr.sha],
      head: `backport-${release}-${pr.id}`,
      octokit: context.octokit,
    })
  );

  const pullRequest = await context.octokit.pulls.create(
    consoleProps(`Created backport PR`, {
      ...context.repo(),
      title: pr.title,
      head: `backport-${release}-${pr.number}`,
      base: `release-${release}`,
      body: `Backport of #${pr.number}

@${pr.author}
    `,
    })
  );

  await context.octokit.issues.addLabels({
    ...context.repo(),
    issue_number: pullRequest.data.number,
    labels: ["backport"],
  });

  return pullRequest;
};
