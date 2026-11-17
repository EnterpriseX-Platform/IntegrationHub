# engine-go vs the Node engine — known differences

Every node type runs natively in Go. This file lists what is still not
identical to the TypeScript executors, so a deployment can decide what
matters. Anything not listed was compared against the Node engine and
matched (outputs, files written, rows written, log and error messages).

How it was checked: each node type has Go tests, most of them run the
original TypeScript executor on the same input and compare; end-to-end
suites run the same flows through the real server on both engines
(condition/fan-out/for-each flows, 18 http-request cases, database
select/insert/update/code/bulk-insert, file-read CSV/TIS-620, file-write
CSV/JSON, regression checks).

## Not verified against a real server

- **Oracle** (database node): written from the TypeScript and unit-tested,
  never run against an Oracle server. Run your Oracle flows with
  `ENGINE=go` on a test environment before relying on it.
- SMTP STARTTLS / direct TLS (email-action), and the File Explorer link
  writes of sftp-action's download-new-folders mode, were not exercised.

## Files whose bytes differ (content is the same)

- **xlsx written by file-write** (excelize instead of exceljs): same sheets,
  cells, types, styles, widths and frozen header, different bytes and
  `size`. Numbers ≥ 1e21 are written in full; strings longer than 32,767
  characters are truncated.
- **zip files** (file-write, basket-action, email attachments): Go's deflate
  instead of zlib — same entries, names and contents, a few bytes different,
  so `zipSize` / `attachmentBytes` differ.
- **Email MIME** (email-action): boundary, header order and transfer
  encoding differ from nodemailer; mail clients show the same message.

## Error message wording

The prefix the executors add is always the same; the library's own text
inside it can differ:

- JavaScript errors in transform / condition / database `code` / api-output
  mappings come from goja, e.g. `Cannot read property 'x' of undefined`
  instead of V8's `Cannot read properties of undefined (reading 'x')`.
- PostgreSQL errors are rebuilt in Prisma's wording; verified for the common
  codes (missing table, syntax, type, unique, not-null, unreachable server).
- Oracle errors carry go-ora's text (no `Help:` line, no NJS-xxx codes).
- SSH/SFTP errors are mapped to ssh2's common messages; rare ones keep Go's.
- PGP library errors (wrong key, missing passphrase, malformed message) use
  go-crypto's wording.

## Values

- Dates from the database and the basket/session tables behave like the
  JavaScript Date objects Prisma returns: toISOString() in JSON,
  Date.toString() in text and templates (e.g. a CSV cell
  "Thu Jan 01 2026 07:00:00 GMT+0700 (Indochina Time)"), a real Date inside
  a transform. The long zone name comes from a table of common zones; other
  zones show Go's abbreviation. Dates handed to the Node server for a
  fallback node arrive as ISO strings.
- Object key order follows JavaScript everywhere data flows (row columns,
  file headers, JSON, object literals, assignments). Keys added through a
  computed key in a loop keep their insertion order only where the code
  records it.

## Behaviour fixed instead of copied

- sftp-action: where the TypeScript never settles (an error inside an ssh2
  callback, or the SFTP write path that stats a deleted temp file), the Go
  node returns the error or the result instead of hanging the run.

## Not ported (run on the Node server automatically)

- file-read `parseAs: 'raw'` (returns a Buffer).
- A transform / database `code` / api-output mapping that uses a Node-only
  global (`Buffer`, `require`, `process`, …).

Nothing in this list stops a flow: these nodes simply run on the Node server
through the callback, with the original executor.
