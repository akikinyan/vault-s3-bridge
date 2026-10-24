# Vault S3 Bridge

> Status: early development. Not ready for use.

An Obsidian plugin for managing attachments on AWS S3 and S3-compatible storage.

- Authenticates to AWS with IAM Role temporary credentials (IAM Identity Center / SSO). Long-term IAM user access keys are not supported.
- Separates **public** storage (shareable URLs) from **private** storage (authenticated preview inside Obsidian).
- Uploads the files a note embeds or links to (images, PDFs, Office files and more) and replaces the links, or copies the new Markdown.
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
- No pre-signed URL is ever written to the note. Files are downloaded on demand and kept in memory only.
- The AWS profile is chosen per device and is not synchronised with the vault.
- Without the plugin, the reference stays in the note as text and Obsidian shows a broken image. Obsidian cannot load the `s3-bridge:` scheme, so nothing is sent over the network.

What is shown depends on the extension of the key, decided before anything is downloaded:

| Extension | Shown as |
|---|---|
| `png` `jpg` `jpeg` `gif` `webp` | Image |
| `svg` | Image (scripts in it do not run) |
| `pdf` | Pages drawn as pictures, as they scroll into view. Links, forms, attachments and scripts in the PDF do nothing |
| `txt` `text` `log` `csv` `tsv` `json` | Plain text, read as UTF-8 (only the beginning of a long file) |
| Anything else (Office, ZIP, audio, video, …) | A card with the name, type and size; only the object's metadata is read |
| No extension | Chosen from the object's Content-Type |

- SVG and text are shown only when their content matches the extension; otherwise a card is shown. Password-protected and damaged PDFs are also shown as a card.
- The size limits are in the settings (**Preview**).
- A link such as `[Report](s3-bridge://work/docs/report.pdf)` opens the same preview in a window inside Obsidian, in Reading view, Live Preview and Source mode, whether opened by a click (with or without a modifier key), the keyboard or the context menu, also in pop-out windows. It is never passed to a browser or another application. This holds only while the plugin is enabled: otherwise Obsidian handles the link as it does any unknown scheme.

Limits of the preview:

- The plugin and its libraries never write downloaded content to disk. Electron and the operating system may still do so on their own (for example, memory swapped out to disk).
- PDF pages are drawn within a fixed memory budget; pages out of view are released first, and a page that does not fit is not shown. The budget is set by calculation, not measured on every machine.

## Uploading attachments

Open a note in editing mode (Live Preview or Source mode) and run one of these commands:

- **Show what would be uploaded from the current note**: lists the files and the planned keys without sending anything.
- **Upload attachments in the current note**: shows the same list, then uploads.

Both embeds (`![[a.png]]`, `![t](doc.pdf)`) and links (`[[doc.pdf]]`, `[t](doc.pdf)`) to files in the vault are uploaded. Links to notes and Canvas files are left alone.

The connection used is the **Default connection** from the settings; otherwise you choose one (a single connection is used without asking).

The confirmation screen shows, for each file, its status, format and Content-Type, the object key, the size before and after conversion and the Markdown that will be written. Files that are not uploaded are listed with the reason. Then choose:

- **Upload and replace links in the note**: the embeds and links are replaced in place. Text you typed but has not been saved yet is kept, and the change can be undone with Undo. If the note was changed, closed or deleted during the upload, the links are not replaced and the Markdown is copied instead.
- **Upload and copy the Markdown**: the note is not changed. The copied Markdown is based on the note as it was when the upload was prepared.

Generated links:

| In the note | Private connection | Public connection |
|---|---|---|
| `![[a.png]]` | `![a](s3-bridge://<alias>/<key>)` | `![](https://<public-base-url>/<key>)` |
| `![[a.png\|300]]` | `![a\|300](s3-bridge://<alias>/<key>)` | `![\|300](https://<public-base-url>/<key>)` |
| `![Diagram](a.png)` | `![Diagram](s3-bridge://<alias>/<key>)` | `![Diagram](https://<public-base-url>/<key>)` |
| `![[doc.pdf]]` | `![doc.pdf](s3-bridge://<alias>/<key>)` (previewed) | `[doc.pdf](https://<public-base-url>/<key>)` (a link) |
| `[[doc.pdf]]` | `[doc.pdf](s3-bridge://<alias>/<key>)` | `[doc.pdf](https://<public-base-url>/<key>)` |
| `[[doc.pdf\|Report]]`, `[Report](doc.pdf)` | `[Report](s3-bridge://<alias>/<key>)` | `[Report](https://<public-base-url>/<key>)` |

A link stays a link and an image embed stays an embed. Inside tables, `|` is escaped as `\|`. Reference-style definitions (`[id]: doc.pdf`) are listed but not rewritten.

**Not uploaded** (the reason is shown): external URLs and existing `s3-bridge://` references, embeds in comments, code or front matter, links to a heading or block, links with a title, files that are not found or cannot be read, images that cannot be decoded, files over the size or pixel limits, archived files, and notes in an excluded folder. When the plugin cannot read a part of the note safely, it stops instead of guessing: for example, a comment containing inline code with `%%` in it. It also stops when the embeds and links it found differ from Obsidian's own index of the note, even where an earlier version would have uploaded the images.

The same file is uploaded once per run, and a file uploaded before (within the upload history) is reused after its checksum is confirmed on the storage.

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

A public URL reveals the key, so the settings warn when a public template uses `{notename}`, `{foldername}` or `{filename}`. Templates that cannot produce a valid key (empty segments, `.` or `..`, a leading `/`, more than 1024 bytes) are rejected. If a key is already used by different content, the file is uploaded once under a key with a short suffix.

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
- **Maximum image size for uploads** applies to each image; images beyond **Maximum total per run** are left for the next run.
- Content-Type is set from the bytes that are sent. The plugin sets no ACL and no Cache-Control.

Files that are not images are sent as they are, never converted, with a fixed Content-Type chosen from their content (`text/plain; charset=utf-8` for text). **Maximum size of other files for uploads** applies to each of them; a file is read whole into memory for a single request. A large upload is not cut off by the request timeout while data is flowing; stop it from the progress notice.

What may go to public storage:

| Format | Public connection |
|---|---|
| Images | As above (metadata removed) |
| Text (`txt` `log` `csv` `tsv` `json` …) | Uploaded as `text/plain; charset=utf-8` |
| PDF, Word, Excel, PowerPoint, ZIP, audio, video | Only the files you tick on the confirmation screen. Their metadata is not removed, and they may contain scripts or macros |
| SVG, HTML, XML, JavaScript, CSS and similar; text whose content is HTML, SVG or XML; anything whose format cannot be told apart | Never |

- An object already on the storage is reused for a public link only if its Content-Type is exactly the one the plugin would send and it has no Content-Disposition. Otherwise the file is uploaded under another key.
- Not checked: scripts, macros or other active parts inside an allowed format (a PDF's JavaScript, an Office macro). Not guaranteed: what a CDN does to the headers when it serves the file.
- Private storage accepts every format; previews show them as described under **Private references**.

### Unfinished uploads

Before each file is sent, the plugin writes a record to its folder (`pending-<device-id>.json`). If Obsidian quits, the upload is stopped or the result is unknown, the record stays and is listed under **Unfinished uploads** in the settings:

- **Resume** checks each file on the storage first and sends it again only if it is missing and the source file is unchanged. Resuming never changes the links in your notes; copy the Markdown afterwards from the same list (per note).
- **Discard** removes a record. The object may remain on the storage, and the plugin can no longer prevent a second copy of it.
- Records from another device are shown separately and are never resumed automatically. You can take them over on this device or discard them.
- Records are written in a newer format than earlier versions of the plugin read. Going back to an earlier version is not supported: it shows the records as damaged. Do not reset or discard them there; install this version again, and it reads them as they were.

### Syncing the vault with Git or another tool

The plugin writes these files to `.obsidian/plugins/vault-s3-bridge/`:

| File | Content | Share between devices |
|---|---|---|
| `data.json` | Settings, upload history, private records | Yes |
| `private-files.json` | Checksums of content sent to private storage | Yes (records from all devices are merged) |
| `pending-*.json` | Unfinished uploads of one device | No: add `pending-*.json` to `.gitignore` |
| `*.tmp-*` | Temporary file, normally removed right away; may remain after a crash | No: add `*.tmp-*` to `.gitignore` |

### Archiving uploaded originals

**Archive uploaded originals** moves source files that are already on the storage into `_s3-archive` in the vault, keeping their paths. Nothing is deleted, and **Move archived files back** (a command, also under **Archived files** in the settings) returns them. A file is offered only if it is within the upload size limits, no text in the vault names it, the upload history has its current content, the storage still holds that content (checked by checksum), and no other file in the vault has the same name.

A file counts as named when its file name appears anywhere in a text file of the vault, after decoding `%`, JSON, HTML and Markdown escapes. Matching is deliberately broad: a false match only keeps a file where it is.

- `s3-bridge://` references are not counted. Their key usually ends with the same file name, but they point to the storage, not to the vault file.
- The visible text of a link the upload wrote is counted. For files that are not images, and for links, this text is the file name with its extension, so those originals stay named and are not offered until you change the text. Image embeds use the name without its extension and are not affected.
- Public links (`https://…`) are counted like any other text, so an original sent to public storage under its own name is not offered.
- Not found: references in formats of other plugins, from outside the vault, and changes on other devices that are not synced yet.
- Decodings are tried in one order (escapes, then `%`, then Unicode normalisation). A name hidden by the reverse order, such as JSON or HTML escapes inside `%`-encoding, is not found.
- The vault is watched from the start of the search until the last file is moved, and the command stops if anything changes. A change made by another tool (such as a sync client) after a move has started cannot be prevented.
- Archiving does not free space: the files stay in the vault, and sync tools keep copying them. Delete the archive folder, or exclude it from sync, once you no longer need the originals.

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
| Connection test, optional write test (under `.vault-s3-bridge/connection-test/`) | `s3:PutObject`, `s3:DeleteObject`, `s3:GetBucketVersioning` (and `s3:DeleteObjectVersion` on buckets with versioning) |

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

- **Files**: the AWS shared config files (`~/.aws/config`, `~/.aws/credentials`) and the IAM Identity Center token cache (`~/.aws/sso/cache`), read through the AWS SDK. Inside the vault: the files that the note you upload from embeds or links to, the note itself (changed only when you choose to replace links), and the plugin's own files listed above. **Archive uploaded originals** reads every text file in the vault (dot folders included, the configuration folder excluded) to look for names, and moves only the files you choose into `_s3-archive`. Nothing else outside the vault.
- **Clipboard**: written when you copy references, Markdown or the command shown by the connection test.
- **Network**: AWS endpoints (IAM Identity Center, STS and S3, with the S3 operations in the permissions table above) and, for connections that set one, the custom S3-compatible endpoint you configure. Requests optionally go through the proxy you configure.
- **Secrets**: none are written to disk or logged. Temporary credentials for previews are kept in memory per connection and dropped shortly before they expire; the connection test and uploads resolve them on each run without keeping them.

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
npm run smoke:upload           # conditional writes and checksums against a real bucket, then cleanup
npm run check:local-values     # make sure no real environment values are tracked
```

## License

[MIT](LICENSE)
