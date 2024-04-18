import { Context } from "probot";
import SemVer from "semver";
import { upsertProject } from "./upsertProject";

export const handlePatch = async ({
  context,
  pr,
}: {
  context: Context;
  pr: {
    merge_commit_sha: string | null;
    node_id: string;
    title: string;
    author: string;
    number: number;
  };
}) => {
  const latestRelease = await context.octokit.repos.getLatestRelease(
    context.repo()
  );

  const pathRelease = SemVer.inc(latestRelease.data.tag_name, "patch");
  if (!pathRelease) {
    await context.octokit.issues.createComment({
      ...context.issue(),
      body: "Could not find a valid version to patch",
    });
    return;
  }

  await upsertProject(context, pathRelease, {
    id: pr.node_id,
    sha: pr.merge_commit_sha,
    title: pr.title,
    number: pr.number,
    author: pr.author,
  });
};
