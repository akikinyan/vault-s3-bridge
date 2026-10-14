# Vault S3 Bridge

> Status: early development. Not ready for use.

An Obsidian plugin for managing attachments on AWS S3 and S3-compatible storage.

- Authenticates to AWS with IAM Role temporary credentials (IAM Identity Center / SSO). Long-term IAM user access keys are not supported.
- Separates **public** storage (shareable URLs) from **private** storage (authenticated preview inside Obsidian).
- Files registered as private cannot be converted to public through the plugin.

Desktop only.

## Private references

Images in a private bucket are referenced with the plugin's own scheme and shown inside Obsidian after authenticating with your AWS profile:

```markdown
![System diagram](s3-bridge://work/diagrams/system.png)
![System diagram|300](s3-bridge://work/diagrams/system.png)
```

- `work` is the alias of a private storage connection. An alias always points to the same bucket: alias, bucket and endpoint cannot be changed after the connection is created.
- Use the command **Insert reference to a private file** to create references; it encodes the object key correctly.
- No pre-signed URL is ever written to the note. Images are downloaded on demand and kept in memory only.
- Supported formats: PNG, JPEG, GIF, WebP. SVG is not shown yet.
- The AWS profile is chosen per device and is not synchronised with the vault.
- Without the plugin, the reference stays in the note as text and Obsidian shows a broken image. Obsidian cannot load the `s3-bridge:` scheme, so nothing is sent over the network.

### Limits of the protection

Buckets registered as private are recorded so that the plugin never uses them for public connections, even after the connection is deleted or settings are synchronised from another device. These records live in the plugin's settings file; anyone who can edit that file can remove them. Enforce access with IAM and bucket policies (for example, never grant the public upload role access to private buckets).

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
npm run smoke:preview          # fetch test images through the preview service
npm run check:local-values     # make sure no real environment values are tracked
```

## License

[MIT](LICENSE)
