import { Plugin } from 'obsidian';

export default class VaultS3BridgePlugin extends Plugin {
	async onload(): Promise<void> {
		// Features are registered here as they are implemented.
	}

	onunload(): void {
		// Resources are released by the registered handlers.
	}
}
