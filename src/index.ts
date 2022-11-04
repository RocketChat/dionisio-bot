import { Context, Probot } from "probot";

const applyLabels = async (
  context: Context<
    | "pull_request.opened"
    | "pull_request.synchronize"
    | "pull_request.labeled"
    | "pull_request.unlabeled"
  >
) => {
  try {
    const issue = context.payload.pull_request;

    const originalLabels = issue.labels.map((label) => label.name);
    const tested = Boolean(originalLabels.includes("stat: QA tested"));
    const skipped = Boolean(originalLabels.includes("stat: QA skipped"));

    const labels: string[] = [
      ...new Set([...originalLabels, "stat: needs QA", "stat: ready to merge"]),
    ].filter((label) => {
      if (label === "stat: needs QA") {
        return !(skipped || tested);
      }

      if (label === "stat: QA skipped") {
        return !tested && skipped;
      }

      if (label === "stat: ready to merge") {
        return skipped || tested;
      }
      return true;
    });

    if (
      labels.length === originalLabels.length &&
      labels.every((label) => originalLabels.includes(label))
    ) {
      return;
    }
    const pull = context.pullRequest({
      labels,
    });
    console.log(pull);

    await context.octokit.issues.addLabels(
      context.issue({
        labels,
      })
    );
  } catch (error) {
    console.log(error);
    // error instanceof Error && core.setFailed(error.message);
  }
};

export = (app: Probot) => {
  app.on(
    [
      "pull_request.opened",
      "pull_request.synchronize",
      "pull_request.labeled",
      "pull_request.unlabeled",
    ],
    async (context) => {
      applyLabels(context);
    }
  );

  app.on(["check_suite.requested"], async function check(context) {
    const startTime = new Date();
    console.log("check_suite started at", startTime);
    // Do stuff
    const { head_branch: headBranch, head_sha: headSha } =
      context.payload.check_suite;
    // Probot API note: context.repo() => {username: 'hiimbex', repo: 'testing-things'}
    return context.octokit.checks.create(
      context.repo({
        name: "My app!",
        head_branch: headBranch,
        head_sha: headSha,
        status: "completed",
        started_at: startTime,
        conclusion: "success",
        completed_at: new Date(),
        output: {
          title: "Probot check!",
          summary: "The check has passed!",
        },
      })
    );
  });

  app.on("issues.opened", async (context) => {
    const issueComment = context.issue({
      body: "Perfect",
    });
    await context.octokit.issues.createComment(issueComment);
  });
};
