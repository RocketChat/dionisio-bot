import { Context } from "probot";
import { handleMessage } from "./handleMessage";

const { GITHUB_LOGIN = "dionisio-bot[bot]" } = process.env;

// just gets the pr

const getProjects = async (
  octokit: Context["octokit"],
  url: string
): Promise<boolean> => {
  const query = `query ($pull_request_url: URI!){ 
    totalCount :resource(url:$pull_request_url) {
      ... on PullRequest {
        projectsV2{
          totalCount
        }
      }
    }
  }`;

  const result = (await octokit.graphql(query, {
    pull_request_url: url,
  })) as {
    totalCount?: {
      projectsV2: {
        totalCount: number;
      };
    };
  };

  return Boolean(result.totalCount?.projectsV2.totalCount);
};

export const applyLabels = async (
  pullRequest: {
    mergeable?: boolean | null;
    labels: { name: string }[];
    mergeable_state: string;
    milestone?: string;
    url: string;
  },
  ref: string,
  context: Context<
    | "pull_request.opened"
    | "pull_request.synchronize"
    | "pull_request.labeled"
    | "pull_request.unlabeled"
    | "issues.milestoned"
    | "issues.demilestoned"
  >
) => {
  try {
    const hasConflicts = pullRequest.mergeable_state === "dirty";

    const hasInvalidTitle = pullRequest.labels.some(
      (label) => label.name === "Invalid PR Title"
    );

    const { data } = await context.octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        path: "package.json",
        ref,
        headers: {
          Accept: "application/vnd.github.raw+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (typeof data !== "string") {
      return;
    }

    const { version: versionFromPackage } = JSON.parse(data);

    const targetingVersion = [pullRequest.milestone]
      .filter(Boolean)
      .filter((milestone) => /(\d+\.\d+\.\d+)/.test(milestone!));

    const hasMilestone = Boolean(
      pullRequest.milestone ||
        (await getProjects(context.octokit, pullRequest.url))
    );

    /**
     * Compare milestone/project with the current version
     * The idea is to check if the PR is targeting the correct version
     * Milestones has the version as x.y.z
     * version is in the package.json follows the x.y.z(-develop|-rc.x) pattern
     */

    const [version] = versionFromPackage.version.split("-");

    const isTargetingRightVersion = targetingVersion.some((milestone) => {
      return version.startsWith(milestone);
    });

    /**
     * Since 7.0 we don't use `stat: QA tested` and `stat: QA skipped` labels
     * they were causing confusion, where people were assuming that PR was not being tested
     *
     * we merged both labels into one `stat: QA: assured` label which is more clear for external contributors
     */

    const originalLabels = pullRequest.labels.map((label) => label.name);

    const currentLabels = originalLabels.map((label) => {
      if (label === "stat: QA tested" || label === "stat: QA skipped") {
        return "stat: QA assured";
      }
      return label;
    });

    const assured = Boolean(currentLabels.includes("stat: QA assured"));

    const newLabels: string[] = [
      ...new Set([...currentLabels, "stat: ready to merge", "stat: conflict"]),
    ].filter((label) => {
      if (label === "stat: conflict") {
        return hasConflicts;
      }

      if (label === "stat: QA skipped" || label === "stat: QA tested") {
        return false; // it was replaced by stat: QA: assured it should not be here but just in case
      }

      if (label === "stat: ready to merge") {
        return (
          !hasConflicts &&
          assured &&
          pullRequest.mergeable &&
          hasMilestone &&
          !hasInvalidTitle
        );
      }
      return true;
    });

    // list all comments on the PR
    // get the first from the bot
    // if have a message, edit it
    // if not, create a new one

    const comments = await context.octokit.issues.listComments({
      ...context.issue(),
    });

    const botComment = comments.data.find(
      (comment) => comment.user?.login === GITHUB_LOGIN
    );

    const message = await handleMessage({
      assured,
      hasConflicts,
      mergeable: Boolean(pullRequest.mergeable !== false && !hasConflicts),
      hasMilestone,
      hasInvalidTitle,
      isTargetingRightVersion:
        targetingVersion[0] && isTargetingRightVersion
          ? {
              currentVersion: version,
              targetVersion: targetingVersion[0],
            }
          : undefined,
    });

    // compares if the message is the same as the one in the comment
    // if it is, it does not update the comment
    if (botComment && botComment.body === message) {
      return;
    }

    // adds a meta tag containing the labels

    if (botComment) {
      await context.octokit.issues.updateComment({
        ...context.issue(),
        comment_id: botComment.id,
        body: message,
      });
    } else {
      await context.octokit.issues.createComment({
        ...context.issue(),
        body: message,
      });
    }

    await context.octokit.issues.setLabels({
      ...context.issue(),
      labels: newLabels,
    });
  } catch (error) {
    console.log(error);
  }
};
