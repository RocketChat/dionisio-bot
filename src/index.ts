import { Probot } from "probot";
import { applyLabels } from "./handleQALabels";
import { handlePatch } from "./handlePatch";
import { handleBackport } from "./handleBackport";
import { run } from "./Queue";
import { consoleProps } from "./createPullRequest";
import { handleRebase } from "./handleRebase";

export = (app: Probot) => {
  app.log.useLevelLabels = false;

  app.log.level = "silent";

  app.on(
    ["issues.milestoned", "issues.demilestoned"],
    async (context): Promise<void> => {
      const { issue } = context.payload;

      if (!issue.pull_request) {
        return;
      }

      const pr = await context.octokit.pulls.get({
        ...context.issue(),
        pull_number: issue.number,
      });

      if (pr.data.closed_at) {
        return;
      }

      await run(String(pr.data.number), () =>
        applyLabels(
          {
            ...pr.data,
            milestone: pr.data.milestone?.title,
          },
          pr.data.base.ref,
          context
        )
      );
    }
  );

  app.on(
    [
      // "pull_request.opened",
      "pull_request.synchronize",
      "pull_request.labeled",
      "pull_request.unlabeled",
    ],
    async (context): Promise<void> => {
      if (context.payload.pull_request.closed_at) {
        return;
      }

      await run(String(context.payload.pull_request.number), () =>
        applyLabels(
          {
            ...context.payload.pull_request,
            milestone: context.payload.pull_request.milestone?.title,
          },
          context.payload.pull_request.head.ref,
          context
        )
      );

      const { owner, repo } = context.repo();

      const suites = await context.octokit.checks.listSuitesForRef({
        owner,
        repo,
        ref: context.payload.pull_request.base.ref,
      });

      const suite = suites.data.check_suites.find((suite) => {
        return suite.app?.name === "dionisio-bot";
      });

      if (!suite) {
        return;
      }

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
          title: "Labels are properly applied",
          summary: "Labels are properly applied",
        },
      })
    );
  });

  app.on(["issue_comment.created"], async (context): Promise<void> => {
    const { comment, issue } = context.payload;

    if (!issue.pull_request) {
      return;
    }

    const pr = await context.octokit.pulls.get({
      ...context.issue(),
      pull_number: issue.number,
    });

    if (!pr.data) {
      return;
    }

    const orgs = await context.octokit.orgs.listForUser({
      username: comment.user.login,
    });

    if (!orgs.data.some(({ login }) => login === "RocketChat")) {
      return;
    }

    const matcher = /^\/([\w]+)\b *(.*)?$/m;

    const [, command, args] = comment.body.match(matcher) || [];

    if (command === "bark" || command === "howl") {
      await context.octokit.issues.createComment({
        ...context.issue(),
        body: Math.random() > 0.5 ? "AU AU" : "woof",
      });
      return;
    }

    /**
     * Gets the latest release of the repository
     * check if exists a branch with the latest version
     * triggers a workflow_dispatch event to create a new patch release
     * creates a project with the latest version
     */

    if (command === "patch" && !args?.trim()) {
      return handlePatch({
        context,
        pr: {
          ...pr.data,
          author: pr.data.user?.login!,
        },
        assignee: comment.user.login,
      });
    }
    if (command === "backport" && args?.trim()) {
      const tags = args.split(" ").filter((arg) => /\d+\.\d+\.\d+/.test(arg));

      try {
        await handleBackport({
          context,
          ...consoleProps("handleBackport", {
            pr: { ...pr.data, author: pr.data.user?.login! },
            tags,
            assignee: comment.user.login,
          }),
        });
      } catch (e) {
        console.log("handleBackport->", e);
      }
      return;
    }

    if (command === "rebase") {
      const [action, release, backportNumber] = pr.data.base.ref.split("-");

      if (
        action != backportNumber &&
        /\d+\.\d+.\d+/.test(release) &&
        Number.isInteger(backportNumber)
      ) {
        await handleRebase({
          context,
          backportNumber: parseInt(backportNumber),
          release,
        });

        context.octokit.reactions.createForIssueComment({
          ...context.issue(),
          comment_id: comment.id,
          content: "+1",
        });
      }
    }
  });

  app.on(["check_suite.rerequested"], async function check(context) {
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
          title: "Labels are properly applied",
          summary: "Labels are properly applied",
        },
        check_run_id: checkRuns.data.check_runs[0].id,
      })
    );
  });

  // app.on(["projects_v2_item.created"], (context) => {
  //   const card = context.payload;

  //   if (card.projects_v2_item.content_type !== "PullRequest") {
  //     return;
  //   }
  // });

  // app.on(["push"], async (context) => {
  //   if (!context.payload.base_ref?.startsWith("refs/heads/release")) {
  //     return;
  //   }

  //   const release = context.payload.base_ref.replace("refs/heads/release", "");

  //   const project = await getProjectsV2(context, release);

  //   if (!project) {
  //     return;
  //   }

  //   // List all cards in the project

  //   // Check if the card is already in the branch
  // });
};
// "pull_request.closed",
// "projects_v2_item.created",
// workflow_job.completed
// "workflow_run.completed"
