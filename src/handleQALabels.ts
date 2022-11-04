import { Context } from "probot";

export const applyLabels = async (
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

    context.octokit.issues.setLabels(
      context.issue({
        labels,
      })
    );
  } catch (error) {
    console.log(error);
    // error instanceof Error && core.setFailed(error.message);
  }
};
