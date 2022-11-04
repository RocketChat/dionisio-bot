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

      const { owner, repo } = context.repo();

      const suites = await context.octokit.checks.listSuitesForRef({
        owner,
        repo,
        ref: context.payload.pull_request.head.ref,
      });

      const suite = suites.data.check_suites.find((suite) => {
        return suite.app?.name === "dionisio-bot";
      });

      if (!suite) {
        return;
      }

      console.log("suite.id", suite.id);
      try {
        await context.octokit.checks.rerequestSuite({
          owner,
          repo,
          check_suite_id: suite.id,
        });
      } catch (error) {
        console.log(error);
      }
    }
  );

  app.on(["check_suite.requested"], async function check(context) {
    const startTime = new Date();
    // Do stuff
    const { head_branch: headBranch, head_sha: headSha } =
      context.payload.check_suite;

    context.payload;

    context.octokit.checks.create(
      context.repo({
        name: "Auto label QA",
        head_branch: headBranch,
        head_sha: headSha,
        status: "completed",
        started_at: startTime,
        conclusion: "success",
        completed_at: new Date(),
        output: {
          summmary: "Labels are properly applied",
        },
      })
    );
  });
  app.on(["check_suite.rerequested"], async function check(context) {
    console.log(
      "check_suite.rerequested started at",
      context.payload.check_suite.id
    );
    // Do stuff

    const checkRuns = await context.octokit.checks.listForSuite(
      context.repo({
        check_suite_id: context.payload.check_suite.id,
      })
    );

    context.octokit.checks.update(
      context.repo({
        name: "Auto label QA",
        conclusion: "success",
        output: {
          summmary: "Labels are properly applied",
        },
        check_run_id: checkRuns.data.check_runs[0].id,
      })
    );
  });
};
