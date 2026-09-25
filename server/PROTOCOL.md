# Remote files (protocol 4)

Irori can edit a file that lives on another machine. That machine runs `irori-host`, a
command-line tool with two halves that only meet in one file, the share registry:

- **the command line** decides which files are shared and for how long (`share`, `ls`, `set`,
  `unshare`), and which Irori installs may connect (`trust`, `clients`, `untrust`). It works
  whether or not a server is running.
- **the server** (`irori-host serve`) does the handshake, pushes the list of shared files to
  clients, and reads/writes exactly those files. The only thing it registers by itself is a
  picture pasted into a shared document (see *What is reachable*).

The client is `src/platform/remote.ts` (the file operations) and `src/app/remote-panel.ts`
(connecting and picking). Any server that answers the routes below works.

Agents managing shares on the host: see [AGENTS.md](AGENTS.md) and the
[irori-host skill](skills/irori-host/SKILL.md).

## Installing

```sh
npx irori-host help                   # Node >= 18, nothing to install
npm install -g irori-host             # or keep it on PATH
curl -fsSL https://raw.githubusercontent.com/IsshikiHugh/Irori-Markdown-Editor/main/server/install.sh | sh    # standalone binary, no Node (Linux / macOS)
```

The binaries (`irori-host-<linux|darwin>-<x64|arm64>.gz`, `irori-host-linux-<x64|arm64>-musl.gz`
for Alpine and other musl systems, `irori-host-windows-x64.exe`) and their `SHA256SUMS` are
attached to every Irori release; `install.sh` picks the right one and checks it against the sums.
`scripts/build-host.sh` builds them locally with Bun (x64 ones for CPUs without AVX2 too). Both npm
and the binaries are published by the release workflow at the app's version. In this repository,
`node server/irori-host.mjs` is the same tool.

## Command line

```sh
irori-host serve [--port 7420]      # listen on 127.0.0.1:<port>
irori-host share <file>... [--for 2h | --keep] [--name <name>]
irori-host ls [--json]
irori-host set <id|file> [--for 30m | --keep] [--name <name>] [--refresh]
irori-host unshare <id|file>... | --all
irori-host trust <key> [--name <name>]
irori-host clients [--json]
irori-host untrust <id|name|key>... | --all
```

- A share lasts `--for` a duration (`90s`, `30m`, `2h`, `7d`; default 12h) or, with `--keep`,
  until it is unshared. `set` restarts the clock from now. Expired shares disappear by themselves.
- Sharing a document also registers the pictures it shows (`![](…)` and `<img src>` that are
  files on this machine), so Irori can display them. `share` again, or any `set` (`--refresh`
  alone does only this), registers pictures the document has started to show since.
- The registry is `~/.irori-host/shares.json` (`IRORI_HOST_HOME` moves it), readable by this
  user only. The server rereads it on every request and pushes the new list as soon as it
  changes.
- Only trusted Irori installs get in (see *Signing in*). `trust` takes the key Irori's remote
  panel shows; trusting it again renames it; `untrust` signs it out at once. The list is
  `~/.irori-host/clients.json`, private to this user.
- The server listens on 127.0.0.1 only. Reach it from another machine by forwarding the port
  (e.g. `ssh -L 7420:127.0.0.1:7420 box`): encryption is ssh's job.

## In Irori

⇧⌘O, or 打开远程文件… in the drawer, opens the remote panel: type the port (the usual case: a
forwarded local port) or a full URL, and the files the server shares are listed, live. The
first time, a server does not trust this Irori yet: the panel shows the command that trusts it
(`irori-host trust irori-p256.…`, with a copy button) and keeps trying, so the list appears as
soon as someone — or an agent — has run it on the server. 复制本机密钥 at the bottom copies the
key ahead of time. Picking a file opens it:

- in this window, if it is an untouched blank page;
- in a new window otherwise — a window is local or remote for its whole life;
- in a remote window, ⌘O lists the same server's shares and opens the pick in place.

A remote window's title and drawer name the server. Editing, autosave, the save dot and the
external-change check are the same as for a local file. Save As is not available (only files
shared on the server's side can be written). If the server stops answering, the window stays
remote: saves fail visibly and nothing is ever written to the local disk instead.

## Wire format

JSON over HTTP on the server's port. Every route but `/hello` and `/auth` takes the session as
`?s=<session>` (a query parameter, not a header: a picture's `<img src>` and an `EventSource`
cannot send headers). File routes take the file as `&path=<absolute path on the server>` — the
`path` from the list. Errors are `{ "error": "<message>" }` with a 4xx/5xx status; the client
shows the message. A 401 also says `"auth"`: `required` (no or no longer valid session),
`expired` (the challenge), `bad-signature`, `untrusted`.

| Route | Reply |
| --- | --- |
| `GET /hello` | `{ "protocol": 4, "host": "<hostname>", "challenge": "<one-time, 1 minute>" }` — the handshake |
| `POST /auth` | body `{ "key", "challenge", "signature" }` → `{ "session", "name" }` (see *Signing in*) |
| `GET /events` | Server-sent events: `event: shares` with the list (below), sent on connect, every 5 s and whenever the registry changes |
| `GET /shares` | the list, once |
| `GET /read?path=` | `{ "text": "..." }` |
| `PUT /write?path=` | body: UTF-8 text → `{ "ok": true }`. Atomic (temp file + rename, the file keeps its permissions), answered after the data is on disk |
| `GET /stat?path=` | `{ "mtimeMs", "size", "dir" }`, or `null` when absent |
| `POST /mkdirp?path=` | `{ "ok": true }` |
| `POST /create?path=` | body: bytes → `{ "ok": true }` written, `{ "ok": false }` name taken (never replaces) |
| `GET /asset?path=` | the picture's bytes with its content type |

The list: `{ "now": <server clock, ms>, "shares": [ { "name", "path", "size", "mtimeMs",
"missing", "addedAt", "expiresAt" } ] }`. `expiresAt` is `null` for a kept share; time left is
`expiresAt - now`, on the server's clock.

A request body is at most 64 MB (413 beyond that). Protocol 3 had no sign-in; protocol 2 also
had `GET /list` and reached a shared file's whole folder. Client and server refuse each other's
older protocols: update both.

## Signing in

Each Irori makes an ECDSA P-256 key pair the first time it needs one (WebCrypto) and keeps it in
its settings file (private to the user). Its public key is written
`irori-p256.<base64url of the uncompressed point, 65 bytes>`; the server keeps the ones it
trusts, like ssh's `authorized_keys`.

1. `GET /hello` → a one-time `challenge`, good for a minute.
2. The client signs the bytes `irori-host sign-in\n<challenge>` (SHA-256, the signature as
   IEEE P1363 `r‖s` in base64url — what WebCrypto produces) and posts it with its public key to
   `/auth`.
3. The signature must verify and the key must be trusted. The reply's `session` is
   `<client id>.<HMAC-SHA256 of the id under ~/.irori-host/secret>`: the server stores no
   sessions, so they survive a restart; each request checks that the id is still trusted, so
   `untrust` ends them at once.

The client signs in again by itself when a request comes back 401.

## What is reachable

Only what the registry holds can be read; everything else is 403 — including whether it exists.

| Route | Reaches |
| --- | --- |
| `read`, `write` | a shared file itself |
| `stat` | a shared file, or a picture registered with one |
| `asset` | a picture registered with a shared file |
| `mkdirp`, `create` | a new folder / picture below a shared file's folder (below) |

- **Registered pictures** are the ones the document showed when it was shared (or at its last
  `set`), and the ones created through `create` since. Pictures are `.png .jpg .jpeg .gif .webp
  .avif .bmp .svg`.
- **`create`** only makes a picture, only where none exists (never a replacement, never through
  a symlink planted at the name), below a shared file's folder, and never in a folder whose name
  starts with `.`. With symlinks resolved, the deepest existing folder must still be inside. The
  new picture is registered with that share, so the window can show it. That is how pasting
  works: Irori's image-folder setting decides where below the document it goes.
- Paths are compared in canonical form (symlinks resolved, the case on disk), so no symlink or
  other spelling of a path reaches anything else.

## Who is answered

The server listens on 127.0.0.1 only, and answers only trusted Irori installs (above). Before
that, a request must also come from Irori at all:

- The `Host` header must name this machine (`127.0.0.1`, `localhost` or `[::1]`, any port — a
  forwarded port may have another number). Anything else is DNS rebinding: 403.
- A request whose `Origin` a browser set must come from Irori: `tauri://localhost` (macOS,
  Linux), `http(s)://tauri.localhost` (Windows), or a page served from this machine (the dev
  server, the tests). Any other page gets 403, preflights included, so no web page open in a
  browser — on the host or on the machine the port is forwarded to — can use the server.
  Replies allow exactly the caller's origin.
- A request without `Origin` is not a page's script reading the reply (a picture being shown,
  a command-line tool) and is served.
- Every reply carries `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`: an
  SVG opened directly runs no script on the server's origin.

So another user or program on either machine that connects to the port directly gets only the
handshake: without a trusted private key it can neither sign in nor use a session.
