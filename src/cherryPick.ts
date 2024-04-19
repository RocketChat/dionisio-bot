import { cherryPickCommits } from "github-cherry-pick";
import { Context } from "probot";

export const cherryPick = ({
  context,
  commits,
  head,
}: {
  context: Context;
  commits: string[];
  head: string;
}) => {
  console.log(
    "[CHERRY PICK]",
    JSON.stringify(
      {
        head,
        commits,
      },
      null,
      2
    )
  );
  return cp(context, {
    commit: commits[0],
    base: head,
  });
};

const cp = async (
  context: Context,
  {
    commit,
    base,
  }: {
    base: string;
    commit: string;
  }
) => {
  const { octokit } = context;

  const { data: branch } = await octokit.repos.getBranch({
    ...context.repo(),
    branch: base,
  });
  const branchTree = branch.commit.commit.tree.sha;

  await octokit.git.createRef({
    ...context.repo(),
    ref: `refs/head/cherry-pick-${base}`,
    sha: branchTree,
  });

  try {
    const sha = await perform(context, {
      base,
      commit,
    });

    // Replace the temp commit with the cherry-pick commit
    await octokit.git.updateRef({
      ...context.repo(),
      ref: base,
      sha,
      force: true,
    });
    return sha;
  } finally {
    await octokit.git.deleteRef({
      ...context.repo(),
      ref: `heads/cherry-pick-${base}`,
    });
  }
};

const perform = async (
  context: Context,
  {
    commit: sha,
    base,
  }: {
    base: string;
    commit: string;
  }
) => {
  const { octokit } = context;
  const { data: branch } = await octokit.repos.getBranch({
    ...context.repo(),
    branch: base,
  });

  const branchTree = branch.commit.commit.tree.sha;

  // Get the parent SHA of the commit we want to merge
  const {
    data: {
      parents: [{ sha: parentSha }],
    },
  } = await octokit.git.getCommit({
    ...context.repo(),
    commit_sha: sha,
  });

  // Create a temporary commit with the current tree of the target branch
  const { data: tempCommit } = await octokit.git.createCommit({
    ...context.repo(),
    message: "temp",
    tree: branchTree,
    parents: [parentSha],
  });

  // Temporarily force the branch over to the temp commit
  await octokit.git.updateRef({
    ...context.repo(),
    ref: `heads/${base}`,
    sha: tempCommit.sha,
    force: true,
  });

  // Merge the commit we want into this mess
  const { data: merge } = await octokit.repos.merge({
    ...context.repo(),
    base,
    head: sha,
  });

  // Get the tree SHA of the merge commit
  const mergeTree = merge.commit.tree.sha;

  // Create the cherry-pick commit with the merge tree
  const { data: cherry } = await octokit.git.createCommit({
    ...context.repo(),
    message: "cherry-pick",
    tree: mergeTree,
    parents: [branchTree],
  });

  // Replace the temp commit with the cherry-pick commit
  await octokit.git.updateRef({
    ...context.repo(),
    ref: `heads/${base}`,
    sha: cherry.sha,
    force: true,
  });

  return cherry.sha;
};
