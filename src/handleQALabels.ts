import { Context } from "probot";
import { handleMessage } from "./handleMessage";

const { GITHUB_LOGIN = "dionisio-bot" } = process.env;

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
  context: Context<
    | "pull_request.opened"
    | "pull_request.synchronize"
    | "pull_request.labeled"
    | "pull_request.unlabeled"
  >
) => {
  try {
    const { mergeable, labels, mergeable_state, milestone, url } =
      context.payload.pull_request;

    const hasConflicts = mergeable_state === "dirty";

    /**
     * Since 7.0 we don't use `stat: QA tested` and `stat: QA skipped` labels
     * they were causing confusion, where people were assuming that PR was not being tested
     *
     * we merged both labels into one `stat: QA: assured` label which is more clear for external contributors
     */

    const originalLabels = labels
      .map((label) => label.name)
      .map((label) => {
        if (label === "stat: QA tested" || label === "stat: QA skipped") {
          return "stat: QA assured";
        }
        return label;
      });

    const assured = Boolean(originalLabels.includes("stat: QA assured"));

    context.octokit.projects.listForRepo({
      ...context.repo(),
    });

    const hasMilestone = Boolean(
      milestone || (await getProjects(context.octokit, url))
    );

    const newLabels: string[] = [
      ...new Set([...originalLabels, "stat: ready to merge", "stat: conflict"]),
    ].filter((label) => {
      if (label === "stat: conflict") {
        return hasConflicts;
      }

      if (
        label === "stat: needs QA" ||
        label === "stat: QA skipped" ||
        label === "stat: QA tested"
      ) {
        return false; // it was replaced by stat: QA: assured it should not be here but just in case
      }

      if (label === "stat: ready to merge") {
        return !hasConflicts && assured && mergeable && hasMilestone;
      }
      return true;
    });

    if (
      newLabels.length === originalLabels.length &&
      newLabels.every((label) => originalLabels.includes(label))
    ) {
      return;
    }

    // list all comments on the PR
    // get the first from the bot
    // if have a message, edit it
    // if not, create a new one

    const comments = await context.octokit.issues.listComments({
      ...context.issue(),
    });

    console.log(comments);
    const botComment = comments.data.find(
      (comment) => comment.user?.login === GITHUB_LOGIN
    );

    const message = await handleMessage({
      assured,
      hasConflicts,
      mergeable: Boolean(mergeable && !hasConflicts),
      hasMilestone,
    });

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

    console.log("DEBUG->", originalLabels, newLabels);
    await context.octokit.issues.setLabels({
      ...context.issue(),
      labels: newLabels,
    });
  } catch (error) {
    console.log(error);
    // error instanceof Error && core.setFailed(error.message);
  }
};
