import { Context } from "probot";
import semver from "semver";
import { upsertProject } from "./upsertProject";

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
    assignee
  );

  await triggerWorkflow(context);
};

const triggerWorkflow = async (context: Context, base: string = "master") =>
  context.octokit.actions.createWorkflowDispatch({
    ...context.repo(),
    inputs: {
      name: "patch",
      "base-ref": base,
    },
    ref: "refs/heads/develop",
    workflow_id: "new-release.yml",
  });
