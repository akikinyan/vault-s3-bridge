# Vault S3 Bridge

> Status: early development. Not ready for use.

An Obsidian plugin for managing attachments on AWS S3 and S3-compatible storage.

- Authenticates to AWS with IAM Role temporary credentials (IAM Identity Center / SSO). Long-term IAM user access keys are not supported.
- Separates **public** storage (shareable URLs) from **private** storage (authenticated preview inside Obsidian).
- Files registered as private cannot be converted to public through the plugin.

Desktop only.

## Development

```bash
npm install
npm run build      # typecheck + production bundle
npm run lint
npm test
```

## License

[MIT](LICENSE)
