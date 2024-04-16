import { Context, Probot } from "probot";
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

        const repo = await context.octokit.repos.get(context.repo());

        const pathRelease = semver.inc(latestRelease.data.tag_name, "patch");

        const projects = (await context.octokit.graphql({
          query: `query{
            organization(login: "${repo.data.owner.login}"){
              projectsV2(first: 100, query: "is:open in:title ${pathRelease}") {
                nodes {
                  id
                  title
                }
              }
            }}`,
        })) as {
          organization: {
            projectsV2: {
              nodes: {
                id: string;
                title: string;
              }[];
            };
          };
        };

        console.log("PROJECTS ->>", JSON.stringify(projects, null, 2));

        const project = projects.organization.projectsV2.nodes.find(
          (project) => project.title === `Patch ${pathRelease}`
        );

        if (project) {
          context.log.info(`Project ${pathRelease} already exists`);

          await addPrToProject(context, String(pr.data.id), String(project.id));

          return;
        }
        context.log.info(`Creating project ${pathRelease}`);

        const projectCreated = (await context.octokit.graphql({
          query: `
              mutation{
                createProjectV2(
                  input: {
                    ownerId: "${repo.data.owner.node_id}",
                    title: "Patch ${pathRelease}",
                  }
                ){
                  projectV2 {
                    id
                  }
                }
              }
            `,
        })) as {
          projectV2: {
            id: string;
          };
        };
        console.log(
          "createWorkflowDispatch->>>>",
          JSON.stringify(
            {
              ...context.repo(),
              inputs: {
                name: "patch",
                "base-ref": `master`,
              },
              ref: "refs/heads/develop",
              workflow_id: "new-release.yml",
            },
            null,
            2
          )
        );

        // await context.octokit.actions.createWorkflowDispatch({
        //   ...context.repo(),
        //   inputs: {
        //     name: "patch",
        //     "base-ref": `master`,
        //   },
        //   ref: "refs/heads/develop",
        //   workflow_id: "new-release.yml",
        // });

        await addPrToProject(
          context,
          String(pr.data.id),
          projectCreated.projectV2.id
        );

        // adds the pull request to the release
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

const addPrToProject = (context: Context, pr: string, project: string) => {
  return context.octokit.graphql({
    query: `mutation($project:ID!, $pr:ID!) {
    addProjectV2ItemById(input: {projectId: $project, contentId: $pr}) {
      item {
        id
      }
    }
  }`,
    variables: {
      project,
      pr,
    },
  });
};
