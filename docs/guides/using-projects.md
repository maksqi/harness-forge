# Using projects

A **project** is a named folder on the server. A chat can belong to one project; in such a chat the model can read,
search and edit the files of that folder and, after you approve each command, run shell commands in it. This is the
agent workspace of harness-forge v1.3 (ADR-031 … ADR-033).

> **Read this first.** The workspace tools work on real files with the rights of the server process, and the shell runs
> any command you approve as the server's operating-system user. There is no sandbox inside harness-forge: run it in
> its Docker container (or as a dedicated user) when you point it at folders that matter, keep backups (git) of your
> projects, and read every shell command before you press **Run**.

Reference: [ARCHITECTURE.md 6.13](../ARCHITECTURE.md#613-agent-workspace-projects-workspace-tools-and-the-shell-adr-031-adr-032-adr-033)
(how it works) and [10.9](../ARCHITECTURE.md#109-workspace-security-phase-7-adr-031--adr-033) (security),
[UI.md 7.19 – 7.20, 9.10](../UI.md#720-projects-in-the-chat-projectswitcher-newchatprojectpicker-chatprojectchip-w79--w710)
(the screens), [PLUGINS.md 1](../PLUGINS.md#builtin-plugins) (the `core-workspace` tools).

## 1. Allow folders on the server

Projects can only be created inside the **workspace roots**, the folders named by `HF_WORKSPACE_ROOTS`:

- **Default** (the variable unset): `<data directory>/workspaces`, created with mode 0700 at the first start
  (`./data/workspaces` in development, `/data/workspaces` in Docker). Create project folders there, or use **New
  folder** in the Add project dialog.
- **Your own folders**: a comma-separated list of absolute paths, for example in `.env`:

  ```sh
  HF_WORKSPACE_ROOTS=/home/me/code,/srv/projects
  ```

  Each root must exist and be a folder. The server refuses to start (exit code 1, the log names the root and the
  reason) on a relative path, a filesystem root (`/`), a root that does not exist, is not a folder or cannot be
  accessed, the data directory itself or a folder inside the data directory (other than
  `<data directory>/workspaces`). A root may *contain* the data directory (normal in development).
- A **project folder** may not be the data directory, contain it or sit inside it. To use harness-forge on its own
  repository, set `HF_DATA_DIR` to a folder outside the repository first.

Restart the server after changing the variable. Projects whose folder can no longer be used (it was deleted, moved,
replaced by a symbolic link, or is no longer inside a root) show "Folder not found" in Settings → Projects (its tooltip
gives the reason); their chats keep working, without the workspace tools.

## 2. Docker

The image ships `bash` and `git` for the shell tool and runs as the unprivileged `node` user (uid 1000); the compose
file limits the container to 512 processes (`pids_limit`). Without extra configuration projects live in
`/data/workspaces`, inside the data volume. To work on folders of the host, mount them and name the mount point (the
commented lines in `docker-compose.yml`):

```yaml
services:
  app:
    environment:
      HF_WORKSPACE_ROOTS: /workspaces
    volumes:
      - data:/data
      - ./workspaces:/workspaces
```

The mounted folder must be writable by uid 1000 (`sudo chown -R 1000:1000 ./workspaces`, or create it as that user).
Commands of the shell tool see only the container's files and the mounted folders.

## 3. Add a project

1. **Settings → Projects → Add project** (or **Add project…** in the project switcher at the top of the sidebar).
2. Browse to the folder: the browser starts at the workspace roots; open subfolders with a click, go up with **Parent
   folder**. Hidden folders, `node_modules`, symbolic links and the data directory are not listed; folders that already
   are projects are marked "Project" and cannot be picked. A workspace root itself cannot be a project: pick a folder
   inside it, or open the parent folder and use **New folder** to start empty.
3. Check the name (it defaults to the folder name) and press **Add project**. With a password set, harness-forge asks
   for it first (adding a project gives chats access to a folder).

Each project can have its own instructions (**Edit instructions…** in its row menu). An `AGENTS.md` (or, without one,
a `CLAUDE.md`) in the project folder is added to the instructions of every chat in the project, before the project's
own instructions; a line made only of `@other-file.md` includes that file (a relative `.md` path inside the folder,
one level deep, at most 64 such lines per file). The whole text is read again for every reply and cut at 32 KiB.

Deleting a project never touches its folder: its chats stay and move to "No project". A project cannot be deleted
while one of its chats is replying, and a running chat cannot be moved to another project.

## 4. Chat in a project

- The **project switcher** (top of the sidebar) filters the chat list: All chats, No project, or one project. Its
  project is also the default project of a new chat.
- On a new chat, the pill under the greeting picks the project; an existing chat shows its project next to the title
  and can be moved with **Move to project** (in the chat menu or the sidebar row menu).
- In a project chat the model can use `read_file`, `list_directory`, `find_files`, `search_files`, `write_file`,
  `edit_file` and `shell`. Edits show as a diff inside the tool row (`+12 −3`), shell commands as terminal output with
  the exit code. Chats in a project may take up to `projectMaxSteps` steps per reply (Settings → General → "Max steps
  in project chats", default 100; other chats use "Max steps per response", default 20; both accept 1 to 200).
- The folder is checked at the start of every reply: if it was moved or deleted, the reply says so ("The project
  folder … is not available") and runs without workspace tools.

## 5. Permission modes: Ask, Accept edits, Auto

The permission menu in the composer (Alt+P, or `/mode`) decides which tool calls wait for your approval:

| Mode | Runs without asking | Asks |
|---|---|---|
| **Ask** (default) | reading, listing and searching files | every write, every edit, every shell command, other tools that change things |
| **Accept edits** (project chats, `/mode edits` or `/mode accept-edits`) | reading and searching, writes and edits of ordinary project files | shell commands; writes to hidden or secret-looking paths (`.git/…`, `.github/…`, `.env`, `*.pem`, `.npmrc`, …); other tools that would ask in Ask |
| **Auto** | everything except tools marked always-ask | writes to hidden or secret-looking paths, other always-ask tools |

- Reading a secret-looking file (`.env`, private keys, `.npmrc`, …) asks in Ask and Accept edits.
- The edit approval card shows the change as a diff; check **Accept all edits in this chat** to switch the chat to
  Accept edits while you allow it.
- The shell card shows the command, the folder and the timeout, and has no "Always allow": every command is approved
  on its own. **Auto runs shell commands without asking** — use it only when you trust the model and the content it
  reads completely (a file or web page can carry instructions that a model follows).

## 6. The shell

- Commands run with `bash -c` (else `sh -c`) in the project folder, each call in a new process: `cd` does not stick,
  there is no stdin (interactive programs fail), and background processes are stopped when the command ends.
- The environment is minimal (`HOME`, `PATH`, `LANG`, …): no `HF_*` variables and no provider keys. A command can
  still read any file the server user can read, including the data directory.
- Stop (or Esc) kills the whole process group; the default timeout is 120 s, at most 590 s per call; output keeps the
  first 4 KiB and the last 16 KiB of each stream.
- **Kill switch**: `HF_WORKSPACE_SHELL=0` removes the shell tool for every chat (the file tools keep working). No
  setting in the app can turn it back on.
- Not available on Windows servers.

## 7. Security notes

- A valid session can approve its own shell calls: anyone who can log in (or steal your session) can run commands as
  the server user. Set `HF_PASSWORD`, keep the server behind TLS when it is reachable from other machines, and use
  `HF_WORKSPACE_SHELL=0` when you do not need the shell.
- Adding a project needs your password (fresh auth); the roots and the kill switch come only from the environment.
- The file tools refuse paths outside the project folder (also through symbolic links) and never write inside `.git`;
  they are a guard against model mistakes, not against code that already runs on the server.
- Prefer Accept edits over Auto for editing work, and commit your project before long agent runs: there is no undo in
  v1.3 (checkpoints are in the backlog).

## 8. Rotate the master key

API keys and other secrets are encrypted with the server's master key. Rotating it encrypts them again with a new key,
for example after a backup of the data directory leaked. A rotation signs every other browser out, changes every share
link (copy the new links from Settings → Data → Shared links), stops running replies and expires pending approvals.
**Back up the data directory first: v1.2 cannot read the secrets after a rotation.**

**Key file** (the default: `data/secret.key`, no `HF_MASTER_KEY`): Settings → Data → **Rotate key…**, type `ROTATE`,
confirm your password. Done; nothing to restart.

**`HF_MASTER_KEY`** (the key comes from the environment): rotate offline with the server stopped.

```sh
# 1. a new key (keep it as safe as the old one)
NEW=$(openssl rand -base64 32)
# 2. stop the server, then
HF_MASTER_KEY="<old key>" HF_NEW_MASTER_KEY="$NEW" pnpm key:rotate
# 3. replace HF_MASTER_KEY with the new key (in .env or your service manager) and start the server
```

With Docker Compose (the key in the `.env` next to `docker-compose.yml`):

```sh
NEW=$(openssl rand -base64 32)
docker compose stop app
docker compose run --rm --no-deps -e HF_NEW_MASTER_KEY="$NEW" app node apps/server/dist/main.mjs rotate-key
# now set HF_MASTER_KEY=<the new key> in .env, then
docker compose up -d
```

With plain Docker:

```sh
docker stop harness-forge
docker run --rm -v harness-forge-data:/data -e HF_MASTER_KEY="$OLD" -e HF_NEW_MASTER_KEY="$NEW" \
  harness-forge node apps/server/dist/main.mjs rotate-key
# start the container again with -e HF_MASTER_KEY="$NEW"
```

### The `rotate-key` CLI

Usage: `node apps/server/dist/main.mjs rotate-key [--force]` (`pnpm key:rotate [--force]` in a source checkout). It
reads `.env` and the environment like the server, so it finds the same data directory.

- **Env mode** (`HF_MASTER_KEY` set): `HF_NEW_MASTER_KEY` must hold the new key (base64 of 32 bytes, different from the
  old one). The CLI never generates or prints a key here; afterwards replace `HF_MASTER_KEY` with the new key and unset
  `HF_NEW_MASTER_KEY`.
- **File mode** (no `HF_MASTER_KEY`): the CLI generates the new key and writes it to `secret.key` itself, like **Rotate
  key…** in the app (useful when the server cannot start). `HF_NEW_MASTER_KEY` is ignored with a warning.
- It refuses to run while a server may use the data directory: something answers `GET /api/health` on `HF_HOST:HF_PORT`
  within 1 s (`0.0.0.0` is probed as `127.0.0.1`, `::` as `::1`; `HF_PORT=0` skips the probe), or `server.lock` names a
  running process on this machine. A lock written on another host, or one that cannot be read, is refused unless you
  pass `--force` after making sure that server is stopped; `--force` never overrides a running process on this
  machine. In Docker every container has its own host name, so a lock left by a container that was killed (not
  stopped) looks foreign: check that the server container is stopped, then add `--force`.
- It checks the current key against the stored key check first and changes nothing when it does not match.
- Every line goes to stderr, prefixed `harness-forge rotate-key:`; the last one is the summary ("rotated the master key
  to version N: …") or the reason it stopped (`refused: …`, `failed: …`).

| Exit code | Meaning |
|---|---|
| 0 | the key was rotated |
| 1 | failed: nothing to rotate, a missing or invalid `HF_NEW_MASTER_KEY`, a key that does not match the stored secrets, an error during the rotation (the transaction leaves the old key in place) |
| 2 | refused: a server answers on the configured port or `server.lock` names a running server (or a foreign / unreadable lock without `--force`) |

Settings → Data → Encryption key shows the key's source, version and last rotation; the alert "The master key doesn't
match the stored secrets." after a restart means the server was started with the wrong key: restore the previous one
(`HF_MASTER_KEY` or `data/secret.key`), or enter the API keys again.
