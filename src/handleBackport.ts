import { Context } from "probot";
import semver from "semver";
import { upsertProject } from "./upsertProject";

export const handleBackport = async ({
  context,
  pr,
  tags,
}: {
  context: Context;
  pr: {
    merge_commit_sha: string | null;
    node_id: string;
  };
  tags: string[];
}) => {
  if (tags.length === 0) {
    await context.octokit.issues.createComment({
      ...context.issue(),
      body: "Please provide a list of tags to backport",
    });
    return;
  }

  // Filter out the tags that are already in the project

  await Promise.allSettled(
    tags.map(async (tag) => {
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

      if (ver <= 0) {
        return;
      }

      const previousTag =
        semver.major(tag) + "." + semver.minor(tag) + "." + ver;

      await context.octokit.repos.getReleaseByTag({
        ...context.repo(),
        tag: previousTag,
      });

      await upsertProject(
        context,
        tag,
        { id: pr.node_id, sha: pr.merge_commit_sha },
        previousTag
      );
    })
  );
};
