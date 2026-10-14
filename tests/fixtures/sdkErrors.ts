// Error shapes produced by @aws-sdk/credential-provider-sso 3.973.18 for each situation.
// Profile names are placeholders.
function providerError(message: string, tryNextLink: boolean): Error {
	const e = new Error(message) as Error & { tryNextLink: boolean };
	e.name = 'CredentialsProviderError';
	e.tryNextLink = tryNextLink;
	return e;
}

export const ssoErrors = {
	noCache: providerError(
		"The SSO session token associated with profile=<profile> was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
		false,
	),
	expiredWithoutRefresh: providerError(
		"Value not present for 'clientId' in SSO Token. Cannot refresh. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
		false,
	),
	invalidRefresh: providerError("Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.", false),
	invalidAccessToken: providerError('UnauthorizedException: Session token not found or invalid', false),
	unknownProfile: providerError('Profile <profile> was not found.', true),
	notSsoProfile: providerError('Profile <profile> is not configured with SSO credentials.', true),
	deadProxy: providerError('Error: connect ECONNREFUSED 127.0.0.1:9', false),
};

export function serviceError(name: string, httpStatusCode: number): Error {
	const e = new Error(name) as Error & { $metadata: { httpStatusCode: number }; $fault: string };
	e.name = name;
	e.$metadata = { httpStatusCode };
	e.$fault = 'client';
	return e;
}

export function nodeError(code: string): Error {
	const e = new Error(`connect ${code}`) as Error & { code: string };
	e.code = code;
	return e;
}
