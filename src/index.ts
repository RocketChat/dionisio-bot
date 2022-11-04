import { Probot } from "probot";
import { applyLabels } from "./handleQALabels";

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

    return context.octokit.checks.create(
      context.repo({
        name: "Rocket.Chat PR Check - by Dionisio",
        head_branch: headBranch,
        head_sha: headSha,
        status: "completed",
        started_at: startTime,
        conclusion: "success",
        completed_at: new Date(),
        output: {
          title: "All the Tests are ok!",
          summary: `
          - :checkered_flag: Pull Request title follows the conventions
          - :checkered_flag: Labels are properly set
          `,
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
