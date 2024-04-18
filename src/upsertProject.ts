// import { cherryPickCommits } from "github-cherry-pick";
import { Context } from "probot";
import { addPrToProject } from "./addPrToProject";
import { createPullRequest } from "./createPullRequest";

export const upsertProject = async (
  context: Context,
  release: string,
  pr: {
    id: string;
    sha: string | null;
    number: number;
    title: string;
    author: string;
  },
  base: string = "master"
) => {
  const project = await getProjectsV2(context, release);

  if (project) {
    context.log.info(`Project ${release} already exists`);

    console.log(
      "upsertProject",
      JSON.stringify(
        {
          release,
          pr,
          base,
        },
        null,
        2
      )
    );

    /**
     * Creates the patch branch
     * Created the pull request based on the new branch
     * cherry-picks the old pr into the new one
     */

    if (pr.sha !== null) {
      const pullRequest = await createPullRequest(
        context,
        release,
        { ...pr, sha: pr.sha },
        base
      );

      await addPrToProject(context, pr.id, project.id);

      await addPrToProject(context, pullRequest.data.node_id, project.id);

      await context.octokit.issues.createComment({
        ...context.issue(),
        body: `Pull request #${pullRequest.data.number} added to Project: "${project.title}"`,
      });
    }

    return;
  }

  context.log.info(`Creating project ${release}`);

  const projectCreated = await createProjectV2(
    context,
    release,
    context.repo().owner
  );

  await triggerWorkflow(context, base);

  await addPrToProject(context, pr.id, projectCreated.projectV2.id);
  // TODO: bark to inform dionisio received the command
  await context.octokit.issues.createComment({
    ...context.issue(),
    body: `Pull request added to Project: "${projectCreated.projectV2.title}"`,
  });
};

const createProjectV2 = async (
  context: Context,
  release: string,
  owner: string
) =>
  (await context.octokit.graphql({
    query: `
            mutation{
              createProjectV2(
                input: {
                  ownerId: "${owner}",
                  title: "Patch ${release}",
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
      title: string;
    };
  };

const triggerWorkflow = async (context: Context, base: string = "master") =>
  context.octokit.actions.createWorkflowDispatch({
    ...context.repo(),
    inputs: {
      name: "patch",
      "base-ref": base,
    },
    ref: "refs/heads/develop",
    workflow_id: "new-release.yml",
  });

export const getProjectsV2 = async (context: Context, release: string) => {
  const repo = await context.octokit.repos.get(context.repo());
  const login = repo.data.owner.login;
  const projects = (await context.octokit.graphql({
    query: `query{
          organization(login: "${login}"){
            projectsV2(first: 100, query: "is:open in:title ${release}") {
              nodes {
                id
                title
                number
              }
            }
          }}`,
  })) as {
    organization: {
      projectsV2: {
        nodes: {
          id: string;
          title: string;
          number: number;
        }[];
      };
    };
  };

  const project = projects.organization.projectsV2.nodes.find(
    (project) => project.title === `Patch ${release}`
  );

  return project;
};
