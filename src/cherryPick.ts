import { cherryPickCommits } from "github-cherry-pick";

export const cherryPick: typeof cherryPickCommits = (args) => {
  console.log("[CHERRY PICK]", JSON.stringify(args, null, 2));
  return cherryPickCommits(args);
};
