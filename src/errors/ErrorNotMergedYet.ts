export class ErrorNotMergedYet extends Error {
	constructor(message?: string) {
		super(message);
		this.name = 'ErrorNotMergedYet';
	}
}
