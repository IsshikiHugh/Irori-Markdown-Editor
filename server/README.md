# irori-host

Edit files on this machine from [Irori](https://github.com/IsshikiHugh/Irori-Markdown-Editor)
running on another one. `irori-host` keeps a registry of shared files (each for a limited time,
or until unshared) and serves exactly those over a local port that you forward with ssh.

```sh
npx irori-host share notes.md --for 2h     # or: npm install -g irori-host
npx irori-host serve                        # 127.0.0.1:7420
# on your machine: ssh -L 7420:127.0.0.1:7420 <this host>, then ⇧⌘O in Irori and type 7420;
# the first time, Irori shows a command that trusts it here — run it:
npx irori-host trust irori-p256.… --name laptop
```

No Node? A standalone binary (Linux / macOS):

```sh
curl -fsSL https://raw.githubusercontent.com/IsshikiHugh/Irori-Markdown-Editor/main/server/install.sh | sh
```

Only Irori installs you trusted get in — each signs in with its own key, like ssh's
`authorized_keys` — and web pages and other users on either machine get nothing. Only the files
you share (and the pictures they show) can be read; the only thing a client can add is a new
picture beside a shared document.

- Commands, wire format, what is reachable: [PROTOCOL.md](PROTOCOL.md)
- For coding agents: [AGENTS.md](AGENTS.md) and the skill in [skills/irori-host](skills/irori-host/SKILL.md)
