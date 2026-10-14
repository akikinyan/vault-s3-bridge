import { fromSSO } from '@aws-sdk/credential-provider-sso';
import type { NodeHttpHandler } from '@smithy/node-http-handler';
import type { AwsCredentialIdentity } from '@smithy/types';

export type CredentialCheck =
	| { ok: true; principalType: 'assumed-role' }
	| { ok: false; reason: 'no-session-token' | 'not-assumed-role' };

/**
 * Resolves temporary role credentials through IAM Identity Center only.
 * A new provider is created on every call; nothing is cached by the plugin.
 */
export function resolveSsoCredentials(
	profile: string,
	requestHandler: NodeHttpHandler,
): Promise<AwsCredentialIdentity> {
	// requestHandler is forwarded to both the SSO client and the SSO-OIDC token refresh.
	return fromSSO({ profile, clientConfig: { requestHandler } })();
}

/** Extracts the principal type from an ARN, e.g. "assumed-role" or "user". */
export function principalTypeOf(arn: string | undefined): string {
	const resource = arn?.split(':')[5];
	return resource?.split('/')[0] ?? 'unknown';
}

/**
 * Defense in depth after resolution: credentials must be temporary and belong to an assumed role.
 * Temporary credentials issued for an IAM user (GetSessionToken) are rejected by the ARN check.
 */
export function checkResolvedCredentials(credentials: AwsCredentialIdentity, callerArn: string | undefined): CredentialCheck {
	if (!credentials.sessionToken) return { ok: false, reason: 'no-session-token' };
	if (principalTypeOf(callerArn) !== 'assumed-role') return { ok: false, reason: 'not-assumed-role' };
	return { ok: true, principalType: 'assumed-role' };
}
