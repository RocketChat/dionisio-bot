declare module 'md-to-adf' {
	interface AdfDocument {
		toJSON(): { type: string; version: number; content: unknown[] };
	}

	function mdToAdf(markdown: string): AdfDocument;

	export = mdToAdf;
}
