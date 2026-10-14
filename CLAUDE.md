# CLAUDE.md

Development rules for this repository. This file is public.

## Project

Obsidian community plugin (desktop only) that stores attachments on AWS S3 / S3-compatible storage.
TypeScript + esbuild. Tests with Vitest. Lint with ESLint (`eslint-plugin-obsidianmd`).

## Commands

- `npm run build` — typecheck and bundle to `main.js`
- `npm run lint` / `npm run typecheck` / `npm test`

## Security rules (must follow)

- Never write real environment values to tracked files: AWS account IDs, profile names, SSO session names or start URLs, bucket names, ARNs, organization names, internal hostnames or proxy URLs. Use placeholders such as `<profile>`, `<bucket>`, `123456789012`.
- Never log or persist secrets: secret access keys, session tokens, SSO access/refresh tokens.
- Do not support long-term IAM user access keys for AWS.
- A file or connection classified as private must never be converted to public by the plugin.
- Never store pre-signed URLs in Markdown.
- Do not use `innerHTML` / `outerHTML` / `insertAdjacentHTML`; build DOM with Obsidian's `createEl` APIs.
- CI must not use real AWS credentials.

## Commit messages

Describe the code change only. Do not mention test environments, verification results, or work history.
