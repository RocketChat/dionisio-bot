export class ErrorCherryPickConflict extends Error {
  constructor(
    readonly arg: {
      commits: string[];
      head: string;
      base: string;
    }
  ) {
    super();
    this.name = "ErrorCherryPickConflict";
  }
}
