import { Context } from "probot";

export const addPrToProject = (
  context: Context,
  pr: string,
  project: string
) => {
  console.log(
    `addPrToProject ->>`,
    JSON.stringify(
      {
        project,
        pr,
      },
      null,
      2
    )
  );

  return context.octokit.graphql({
    query: `mutation($project:ID!, $pr:ID!) {
    addProjectV2ItemById(input: {projectId: $project, contentId: $pr}) {
      item {
        id
      }
    }
  }`,

    project,
    pr,
  });
};
