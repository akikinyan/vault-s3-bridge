# Vault S3 Bridge

> Status: early development. Not ready for use.

An Obsidian plugin for managing attachments on AWS S3 and S3-compatible storage.

- Authenticates to AWS with IAM Role temporary credentials (IAM Identity Center / SSO). Long-term IAM user access keys are not supported.
- Separates **public** storage (shareable URLs) from **private** storage (authenticated preview inside Obsidian).
- Files registered as private cannot be converted to public through the plugin.

Desktop only.

## What the plugin accesses

- **Files**: the AWS shared config files (`~/.aws/config`, `~/.aws/credentials`) and the IAM Identity Center token cache (`~/.aws/sso/cache`), read through the AWS SDK. Nothing else outside the vault.
- **Network**: AWS endpoints only (IAM Identity Center, STS and S3), optionally through the proxy you configure.
- **Secrets**: none are stored by the plugin. Credentials are resolved on demand and are not cached or logged.

## Supported authentication (current)

| Credential source | Supported |
|---|---|
| IAM Identity Center (SSO) profile | Yes |
| Long-term access keys (static keys, environment variables) | No (rejected) |
| Role assumption (`role_arn`, `source_profile`, `credential_source`) | Not yet |
| `credential_process`, web identity | No |

Sign in with `aws sso login --profile <profile>` before using the plugin.

## Development

```bash
npm install
npm run build      # typecheck + production bundle
npm run lint
npm test
```

Maintainers can run local-only checks against a real AWS account (never in CI):

```bash
npm run smoke:aws              # connection diagnostics using local/dev.json
npm run check:local-values     # make sure no real environment values are tracked
```

## License

[MIT](LICENSE)
