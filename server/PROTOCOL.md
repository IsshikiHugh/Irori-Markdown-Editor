# Remote files (protocol 2)

Irori can edit a file that lives on another machine. That machine runs `irori-host`, a
command-line tool with two halves that only meet in one file, the share registry:

- **the command line** decides which files are shared and for how long (`share`, `ls`, `set`,
  `unshare`). It works whether or not a server is running.
- **the server** (`irori-host serve`) does the handshake, pushes the list of shared files to
  clients, and reads/writes exactly those files. It never shares anything by itself.

The client is `src/platform/remote.ts` (the file operations) and `src/app/remote-panel.ts`
(connecting and picking). Any server that answers the routes below works.

## Command line

```sh
node server/irori-host.mjs serve [--port 7420]      # listen on 127.0.0.1:<port>
node server/irori-host.mjs share <file>... [--for 2h | --keep] [--name <name>]
node server/irori-host.mjs ls [--json]
node server/irori-host.mjs set <id|file> [--for 30m | --keep] [--name <name>]
node server/irori-host.mjs unshare <id|file>... | --all
```

- A share lasts `--for` a duration (`90s`, `30m`, `2h`, `7d`; default 12h) or, with `--keep`,
  until it is unshared. `set` restarts the clock from now. Expired shares disappear by themselves.
- The registry is `~/.irori-host/shares.json` (`IRORI_HOST_HOME` moves it). The server rereads it
  on every request and pushes the new list as soon as it changes.
- The server listens on 127.0.0.1 only. Reach it from another machine by forwarding the port
  (e.g. `ssh -L 7420:127.0.0.1:7420 box`): encryption and login are ssh's job.

## In Irori

⇧⌘O, or 打开远程文件… in the drawer, opens the remote panel: type the port (the usual case: a
forwarded local port) or a full URL, and the files the server shares are listed, live. Picking
one opens it:

- in this window, if it is an untouched blank page;
- in a new window otherwise — a window is local or remote for its whole life;
- in a remote window, ⌘O lists the same server's shares and opens the pick in place.

A remote window's title and drawer name the server. Editing, autosave, the save dot and the
external-change check are the same as for a local file. Save As is not available (only files
shared on the server's side can be written). If the server stops answering, the window stays
remote: saves fail visibly and nothing is ever written to the local disk instead.

## Wire format

JSON over HTTP on the server's port. File routes take the file as `?path=<absolute path on the
server>` — the `path` from the list. Errors are `{ "error": "<message>" }` with a 4xx/5xx status;
the client shows the message. Replies are CORS-open (the client page is served from another
origin).

| Route | Reply |
| --- | --- |
| `GET /hello` | `{ "protocol": 2, "host": "<hostname>" }` — the handshake |
| `GET /events` | Server-sent events: `event: shares` with the list (below), sent on connect, every 5 s and whenever the registry changes |
| `GET /shares` | the list, once |
| `GET /read?path=` | `{ "text": "..." }` |
| `PUT /write?path=` | body: UTF-8 text → `{ "ok": true }`. Atomic (temp file + rename), answered after the data is on disk |
| `GET /stat?path=` | `{ "mtimeMs", "size", "dir" }`, or `null` when absent |
| `GET /list?path=` | `[ { "name", "dir" }, ... ]` |
| `POST /mkdirp?path=` | `{ "ok": true }` |
| `POST /create?path=` | body: bytes → `{ "ok": true }` written, `{ "ok": false }` name taken (never replaces) |
| `GET /asset?path=` | the file's bytes with its content type |

The list: `{ "now": <server clock, ms>, "shares": [ { "name", "path", "size", "mtimeMs",
"missing", "addedAt", "expiresAt" } ] }`. `expiresAt` is `null` for a kept share; time left is
`expiresAt - now`, on the server's clock.

What is reachable: `read` and `write` only for a shared file itself. `stat`, `list`, `mkdirp`,
`create` and `asset` also for anything in a shared file's folder and below — that is what pasting
a picture (saved beside the document) and showing it needs. Everything else is 403.
