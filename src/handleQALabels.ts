import { Context } from "probot";

const {
  REQUIRE_REGRESSION = 'false',
  REQUIRE_MILESTONE = '',
} = process.env;

const requiredRegressionLabel = Boolean(REQUIRE_REGRESSION === 'true');

export const applyLabels = async (
  context: Context<
    | "pull_request.opened"
    | "pull_request.synchronize"
    | "pull_request.labeled"
    | "pull_request.unlabeled"
  >
) => {
  try {
    const { mergeable, labels, mergeable_state, milestone } = context.payload.pull_request;

    const hasConflicts = mergeable_state === "dirty";

    const originalLabels = labels.map((label) => label.name);

    const tested = Boolean(originalLabels.includes("stat: QA tested"));
    const skipped = Boolean(originalLabels.includes("stat: QA skipped"));
    const hasRegression = Boolean(originalLabels.includes("type: regression"));
    const hasRequiredMilestone = !REQUIRE_MILESTONE || Boolean(milestone && milestone.number == parseInt(REQUIRE_MILESTONE));

    const newLabels: string[] = [
      ...new Set([
        ...originalLabels,
        "stat: needs QA",
        "stat: ready to merge",
        "stat: conflict",
      ]),
    ].filter((label) => {
      if (label === "stat: conflict") {
        return hasConflicts;
      }

      if (label === "stat: needs QA") {
        return !(skipped || tested);
      }

      if (label === "stat: QA skipped") {
        return !tested && skipped;
      }

      if (label === "stat: ready to merge") {
        return !hasConflicts && (skipped || tested) && mergeable && (!requiredRegressionLabel || hasRegression) && hasRequiredMilestone;
      }
      return true;
    });

    if (
      newLabels.length === originalLabels.length &&
      newLabels.every((label) => originalLabels.includes(label))
    ) {
      return;
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
