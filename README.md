# Vault S3 Bridge

> Status: early development. Not ready for use.

An Obsidian plugin for managing attachments on AWS S3 and S3-compatible storage.

- Authenticates to AWS with IAM Role temporary credentials (IAM Identity Center / SSO). Long-term IAM user access keys are not supported.
- Separates **public** storage (shareable URLs) from **private** storage (authenticated preview inside Obsidian).
- Uploads the images embedded in a note and replaces the links, or copies the new Markdown.
- Files registered as private cannot be converted to public through the plugin.

Desktop only. Tested on macOS.

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

## Uploading images

Open a note in editing mode (Live Preview or Source mode) and run one of these commands:

- **Show what would be uploaded from the current note**: lists the images and the planned keys without sending anything.
- **Upload images in the current note**: shows the same list, then uploads.

The connection used is the **Default connection** from the settings; otherwise you choose one (a single connection is used without asking).

The confirmation screen shows, for each image, its status, the object key, the size before and after conversion and the Markdown that will be written. Images that are not uploaded are listed with the reason. Then choose:

- **Upload and replace links in the note**: the embeds are replaced in place. Text you typed but has not been saved yet is kept, and the change can be undone with Undo. If the note was changed, closed or deleted during the upload, the links are not replaced and the Markdown is copied instead.
- **Upload and copy the Markdown**: the note is not changed. The copied Markdown is based on the note as it was when the upload was prepared.

Generated links:

| In the note | Private connection | Public connection |
|---|---|---|
| `![[a.png]]` | `![a](s3-bridge://<alias>/<key>)` | `![](https://<public-base-url>/<key>)` |
| `![[a.png\|300]]` | `![a\|300](s3-bridge://<alias>/<key>)` | `![\|300](https://<public-base-url>/<key>)` |
| `![Diagram](a.png)` | `![Diagram](s3-bridge://<alias>/<key>)` | `![Diagram](https://<public-base-url>/<key>)` |

Inside tables, `|` is escaped as `\|`.

**Not uploaded** (the reason is shown): external URLs and existing `s3-bridge://` references, embeds in comments, code or front matter, links to a heading or block, links with a title, files that are not found or not a supported image, files over the size or pixel limits, and notes in an excluded folder. When the plugin cannot read a part of the note safely, it stops instead of guessing.

The same image is uploaded once per run, and an image uploaded before (within the upload history) is reused after its checksum is confirmed on the storage.

### Object keys

Each connection has a **Key template for uploads**. Variables:

| Variable | Value |
|---|---|
| `{year}` `{mon}` `{day}` | Date of the upload |
| `{filename}` | File name without extension |
| `{ext}` | Extension of the format that is sent |
| `{notename}` | Name of the note |
| `{foldername}` | Name of the note's folder (last part of the path; `_` at the vault root) |
| `{hash}` | First 16 hex characters of the SHA-256 of the bytes that are sent |

Defaults:

- Private: `attachments/{year}/{mon}/{notename}/{filename}.{ext}`
- Public: `attachments/{year}/{mon}/{hash}.{ext}`

A public URL reveals the key, so the settings warn when a public template uses `{notename}`, `{foldername}` or `{filename}`. Templates that cannot produce a valid key (empty segments, `.` or `..`, a leading `/`, more than 1024 bytes) are rejected. If a key is already used by different content, the image is uploaded once under a key with a short suffix.

### Formats and metadata

| Image | Public connection | Private connection (default) | Private with **Remove metadata for private uploads too** |
|---|---|---|---|
| PNG, JPEG, WebP | Re-encoded to the same format to remove metadata | Sent as is | As public |
| GIF (still) | Re-encoded as PNG | Sent as is | As public |
| Animated GIF, PNG or WebP | Not uploaded | Sent as is | Not uploaded |

- Metadata such as Exif, GPS, XMP and text chunks is removed by re-encoding. The ICC color profile that the encoder writes is kept; it describes colors, not the image's origin.
- If metadata cannot be removed, the image is not uploaded. The original bytes are never sent as a fallback.
- **Convert to WebP when smaller**: when an image is re-encoded, a WebP version is also made and the smaller one is sent.
- Images over 40 megapixels, and images whose size cannot be read from the header, are not uploaded.
- **Maximum file size for uploads** applies to each image; images beyond **Maximum total per run** are left for the next run.
- Content-Type is set from the bytes that are sent. The plugin sets no ACL and no Cache-Control.

### Unfinished uploads

Before each image is sent, the plugin writes a record to its folder (`pending-<device-id>.json`). If Obsidian quits, the upload is stopped or the result is unknown, the record stays and is listed under **Unfinished uploads** in the settings:

- **Resume** checks each file on the storage first and sends it again only if it is missing and the source file is unchanged. Resuming never changes the links in your notes; copy the Markdown afterwards from the same list (per note).
- **Discard** removes a record. The object may remain on the storage, and the plugin can no longer prevent a second copy of it.
- Records from another device are shown separately and are never resumed automatically. You can take them over on this device or discard them.

### Syncing the vault with Git or another tool

The plugin writes these files to `.obsidian/plugins/vault-s3-bridge/`:

| File | Content | Share between devices |
|---|---|---|
| `data.json` | Settings, upload history, private records | Yes |
| `private-files.json` | Checksums of content sent to private storage | Yes (records from all devices are merged) |
| `pending-*.json` | Unfinished uploads of one device | No: add `pending-*.json` to `.gitignore` |
| `*.tmp-*` | Temporary file, normally removed right away; may remain after a crash | No: add `*.tmp-*` to `.gitignore` |

## Publishing public files

Keep S3 Block Public Access enabled and serve the bucket through a CDN such as Amazon CloudFront with origin access control. Set the connection's **Public base URL** to the https URL that serves the bucket (for example `https://cdn.example.com/`); public uploads are not possible without it. The link is this URL followed by the object key.

## Required permissions

Supported storage: S3 general purpose buckets with SSE-S3 or SSE-KMS. Directory buckets are not supported. An S3-compatible endpoint must support conditional writes (`If-None-Match`) and SHA-256 checksums.

| Purpose | Permission |
|---|---|
| Upload | `s3:PutObject` |
| Check existence and checksum (reuse and resume) | `s3:GetObject` |
| Buckets encrypted with SSE-KMS | `kms:GenerateDataKey` and `kms:Decrypt` (also allowed by the key policy) |
| Tell a missing object apart from a denied one (optional) | `s3:ListBucket` |
| Private previews | `s3:GetObject` |
| Connection test (bucket reachability and Block Public Access) | `s3:ListBucket`, `s3:GetBucketPublicAccessBlock` |
| Connection test, optional write test (under `.vault-s3-bridge/connection-test/`) | `s3:PutObject`, `s3:DeleteObject`, `s3:GetBucketVersioning` |

Without `kms:Decrypt`, an upload can succeed while the later checksum checks fail. The plugin then stops and keeps the record instead of uploading another copy.

Example policy for the role used by a connection (replace the placeholders):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::<bucket>/attachments/*"
    },
    {
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:<region>:123456789012:key/<key-id>"
    }
  ]
}
```

Leave out the KMS statement for buckets that use SSE-S3.

## Limits of the protection

Buckets registered as private are recorded so that the plugin never uses them for public connections, even after the connection is deleted or settings are synchronised from another device. Content sent to private storage is recorded by checksum (in `data.json` and `private-files.json`), and the plugin refuses to upload the same content to public storage.

- Only identical bytes are recognised. An image that was re-saved, edited or converted elsewhere looks the same but is not detected.
- Not tracked: history removed before a connection became private, records of other devices that have not been synchronised yet, and files placed in private buckets by other means.
- Sending content to private storage does not remove a copy sent to public storage earlier. The confirmation screen warns about it.
- Two devices uploading at the same time before their records are synchronised can still send the same content to public storage.
- Anyone who can edit the plugin's files can remove the records. Enforce access with IAM and bucket policies (for example, never grant the public upload role access to private buckets).
- Settings are saved through Obsidian, which does not write files atomically. A record saved by this device survives a crash of Obsidian, but not a power loss or an OS crash. Records synchronised from another device but not yet read on this device can be overwritten; they come back from that device at the next synchronisation.
- If Obsidian's image encoder changes between an interrupted upload and its resume, the image may not be rebuilt exactly. The record is then kept as needing attention for you to keep or discard.

## What the plugin accesses

- **Files**: the AWS shared config files (`~/.aws/config`, `~/.aws/credentials`) and the IAM Identity Center token cache (`~/.aws/sso/cache`), read through the AWS SDK. Inside the vault: images embedded in the note you upload from, the note itself (changed only when you choose to replace links), and the plugin's own files listed above. Nothing else outside the vault.
- **Clipboard**: written when you copy references, Markdown or the command shown by the connection test.
- **Network**: AWS endpoints (IAM Identity Center, STS and S3, with the S3 operations in the permissions table above) and, for connections that set one, the custom S3-compatible endpoint you configure. Requests optionally go through the proxy you configure.
- **Secrets**: none are written to disk or logged. Temporary credentials for image previews are kept in memory per connection and dropped shortly before they expire; the connection test and uploads resolve them on each run without keeping them.

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
