import { Probot } from "probot";
import { applyLabels } from "./handleQALabels";
import semver from "semver";

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

      await applyLabels(
        {
          ...pr.data,
          milestone: pr.data.milestone?.title,
        },
        pr.data.base.ref,
        context
      );
    }
  );

  app.on(
    [
      "pull_request.opened",
      "pull_request.synchronize",
      "pull_request.labeled",
      "pull_request.unlabeled",
    ],
    async (context): Promise<void> => {
      if (context.payload.pull_request.closed_at) {
        return;
      }

      await applyLabels(
        {
          ...context.payload.pull_request,
          milestone: context.payload.pull_request.milestone?.title,
        },
        context.payload.pull_request.head.ref,
        context
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

  app.on(["issue_comment.created"], async (context) => {
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

    const [, command] = comment.body.match(matcher) || [];

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

    if (command === "patch") {
      try {
        const latestRelease = await context.octokit.repos.getLatestRelease(
          context.repo()
        );

        const pathRelease = semver.inc(latestRelease.data.tag_name, "patch");

        const projects = await context.octokit.projects.listForRepo({
          ...context.repo(),
        });

        if (!projects.data.some((p) => p.name === `Release ${pathRelease}`)) {
          context.log.info(`Creating project ${pathRelease}`);

          await context.octokit.graphql({
            query: `
              mutation{
                createProjectV2(
                  input: {
                    ownerId: ${comment.user.login},
                    title: "Patch ${pathRelease}",
                  }
                ){
                  projectV2 {
                    id
                  }
                }
              }
            `,
          });

          // await context.octokit.projects.createForRepo({
          //   ...context.repo(),
          //   name: `Release ${pathRelease}`,
          //   body: `This is a patch release of ${pathRelease}`,
          //   auto_init: true,
          //   private: true,
          // });

          await context.octokit.actions.createWorkflowDispatch({
            ...context.repo(),
            inputs: {
              name: "patch",
              "base-ref": "develop",
            },
            ref: "refs/heads/develop",
          });
        } else {
          context.log.info(`Project ${pathRelease} already exists`);
        }

        // adds the pull request to the release
        await context.octokit.projects.createCard({
          ...context.repo(),
          card_id: pr.data.id,
          content_id: latestRelease.data.id,
          content_type: "release",
          state: "open",
          assignees: [comment.user.login],
          labels: ["patch"],
        });
      } catch (error: any) {
        context.log.error(error);
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
};
