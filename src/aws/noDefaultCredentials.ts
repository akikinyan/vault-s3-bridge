// Replaces @aws-sdk/credential-provider-node in the plugin bundle (see esbuild.config.mjs).
// The default chain (environment variables, static keys, credential_process, ...) must never be
// used: every client receives explicit SSO credentials. Exports mirror the original module and
// only throw when a provider is actually invoked, so client construction keeps working.
import type { AwsCredentialIdentity } from '@smithy/types';

export class DefaultCredentialChainDisabledError extends Error {
	constructor() {
		super('The default AWS credential chain is disabled in Vault S3 Bridge.');
		this.name = 'DefaultCredentialChainDisabledError';
	}
}

export const defaultProvider = () => (): Promise<AwsCredentialIdentity> =>
	Promise.reject(new DefaultCredentialChainDisabledError());

export const credentialsWillNeedRefresh = (): boolean => false;
export const credentialsTreatedAsExpired = (): boolean => false;
