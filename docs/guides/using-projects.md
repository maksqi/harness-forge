# Using projects

A **project** is a named folder on the server. A chat can belong to one project; in such a chat the model can read,
search and edit the files of that folder and run shell commands in it, after your approval or under the rules you set.
This is the agent workspace of harness-forge (v1.3, ADR-031 … ADR-033); v1.4 adds rewinding the agent's file changes,
a changes panel with per-file revert, shell rules and a working folder that carries over between shell commands
(ADR-036 … ADR-038); v1.5 adds plan mode, `@` file mentions and sub-agents ([agent features](agent-features.md)); v1.6
reads the project's own agents, commands and skills from `.harness/` and `.claude/`, can save approved plans into the
project and append `/remember` notes to its `AGENTS.md` ([customizing the agent](customizing-agents.md)).

> **Read this first.** The workspace tools work on real files with the rights of the server process, and the shell runs
> any command you approve as the server's operating-system user. There is no sandbox inside harness-forge: run it in
> its Docker container (or as a dedicated user) when you point it at folders that matter, keep backups (git) of your
> projects, and read every shell command before you press **Run**. Rewind and revert restore only the agent's file
> edits, not what shell commands did.

Reference: [ARCHITECTURE.md 6.13](../ARCHITECTURE.md#613-agent-workspace-projects-workspace-tools-and-the-shell-adr-031-adr-032-adr-033)
(how it works) and [10.9](../ARCHITECTURE.md#109-workspace-security-phase-7-adr-031--adr-033) (security),
[UI.md 7.19 – 7.20, 9.10](../UI.md#720-projects-in-the-chat-projectswitcher-newchatprojectpicker-chatprojectchip-w79--w710)
(the screens), [PLUGINS.md 1](../PLUGINS.md#builtin-plugins) (the `core-workspace` tools); v1.4:
[ARCHITECTURE.md 6.16](../ARCHITECTURE.md#616-checkpoints-and-rewind-adr-036) (checkpoints and rewind),
[6.17](../ARCHITECTURE.md#617-changes-panel-data-and-the-git-runner-adr-037) (the changes panel and git),
[UI.md 7.21 – 7.23](../UI.md#721-changes-panel-chatworkspace-changestoggle-changespanel-w88-phase-8) (the panel,
rewind and shell rules).

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

**Git in a bind mount** (v1.4): git refuses a repository that belongs to another user ("dubious ownership"). When a
mounted project is owned by a host uid other than 1000, the **Git** view of the changes panel says "Git refused to read
this repository" (the **This chat** view and rewind still work). Either give the folder to uid 1000 (`sudo chown -R
1000:1000 ./workspaces/<project>`), or, if you accept that git trusts that folder, add it to the git configuration of
the container user yourself:

```sh
docker compose exec app git config --global --add safe.directory /workspaces/<project>
```

harness-forge never overrides this check for you. (`--global` writes `~/.gitconfig` of the `node` user inside the
container; it is lost when the container is recreated unless its home folder is on a volume.)

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

## 5. Permission modes: Ask, Accept edits, Plan, Auto

The permission menu in the composer (Alt+P, `/mode`, or v1.5's Shift+Tab, which cycles Ask → Accept edits → Plan)
decides which tool calls wait for your approval:

| Mode | Runs without asking | Asks |
|---|---|---|
| **Ask** (default) | reading, listing and searching files; shell commands your shell rules allow (7) | every write, every edit, every other shell command, other tools that change things |
| **Accept edits** (project chats, `/mode edits` or `/mode accept-edits`) | reading and searching, writes and edits of ordinary project files; shell commands your shell rules allow | other shell commands; writes to hidden or secret-looking paths (`.git/…`, `.github/…`, `.env`, `*.pem`, `.npmrc`, …); other tools that would ask in Ask |
| **Plan** (v1.5, project chats, `/mode plan`) | reading, listing and searching; the agent's todo list; read-only sub-agents | writes, edits and the shell are not offered at all; the plan card (approve with Accept edits or Ask, or keep planning; [agent features](agent-features.md#2-plan-mode-look-first-then-change)); other tools that would ask in Ask |
| **Auto** | everything except tools marked always-ask | writes to hidden or secret-looking paths, other always-ask tools |

- Reading a secret-looking file (`.env`, private keys, `.npmrc`, …) asks in Ask and Accept edits.
- The edit approval card shows the change as a diff; check **Accept all edits in this chat** to switch the chat to
  Accept edits while you allow it.
- The shell card shows the command, the folder and the timeout. It has no "Always allow" for the whole shell tool
  (the server refuses one); instead it can add a **shell rule** for that kind of command (7). **Auto runs shell
  commands without asking** — use it only when you trust the model and the content it reads completely (a file or web
  page can carry instructions that a model follows).

## 6. The shell

- Commands run with `bash -c` (else `sh -c`), each call in a new process: there is no stdin (interactive programs
  fail), background processes are stopped when the command ends, and environment variables (`export X=1`) do not carry
  over to the next call.
- **The working folder sticks** (v1.4): the first command of a chat starts in the project folder; each later command
  starts in the folder where the previous one ended, so `cd packages/web` in one call means the next call runs there.
  The terminal output shows the folder before `$` and "Now in …" when it changed. A command that ends outside the
  project folder (or in a folder that was deleted since) sends the next call back to the project folder, with a note.
  The folder follows the conversation: after you switch to another version of a message, it is the folder of the last
  shell call on that version. A `cwd` given in a call wins for that call. A command that is stopped or killed (Stop,
  the timeout, a signal) or that replaces the shell (`exec …`) cannot report where it ended, so it leaves the working
  folder as it was.
- The environment is minimal (`HOME`, `PATH`, `LANG`, …): no `HF_*` variables and no provider keys. A command can
  still read any file the server user can read, including the data directory.
- Stop (or Esc) kills the whole process group; the default timeout is 120 s, at most 590 s per call; output keeps the
  first 4 KiB and the last 16 KiB of each stream.
- **Kill switch**: `HF_WORKSPACE_SHELL=0` removes the shell tool for every chat (the file tools keep working). No
  setting in the app can turn it back on.
- Not available on Windows servers.

## 7. Shell rules: commands that run without asking

A **shell rule** lets matching shell commands run without the approval card, in the Ask and Accept edits modes (Auto
runs every command anyway). A rule is the start of a command, compared word by word: `pnpm test` allows
`pnpm test --run parser` but not `pnpm testx` or `pnpm -C web test`.

- **Add one from the approval card**: check **Always allow commands starting with** on the shell card. The card
  suggests the rule (one rule per part of a combined command, e.g. `pnpm test` and `git status` for
  `pnpm test && git status`); a single rule can be edited before you press **Run**. Pick **This project** or **All
  projects**. The rule is saved first, then the command runs.
- **Manage them**: Settings → Projects → a project's **⋯** → **Allowed commands…** for the project's rules, and
  **Allowed in every project** below the project list for global rules. Rules cannot be edited: remove one and add a
  new one. A project can have up to 200 rules, and so can the global list. Deleting a project deletes its rules.
- **Combined commands** (`&&`, `||`, `;`, `|`, several lines) run without asking only when **every** part matches a
  rule. `cd` into a folder of the project needs no rule, but the folder must already exist when the command is
  checked: `mkdir -p out && cd out` asks while `out` does not exist yet (the `cd` is checked before anything runs).
- **Always asks**, whatever the rules: anything with `$` (variables, `$(…)`), backticks, redirections (`>`, `<`, `>>`,
  here-docs; only `>/dev/null`, `>>/dev/null`, `2>/dev/null` and copies to 0, 1 or 2 such as `2>&1` are allowed;
  `&>/dev/null` asks, because `sh` runs it as a background command), `( )` or `{ }`, a trailing `&`, an empty part
  (`ls ;`, `&& ls`), unquoted `*`, `?` or `[`, words starting with `~` or `#`, a backslash inside double quotes or at
  the end of a line, shell keywords (`if`, `for`, …), a `NAME=value` prefix, `cd` without a folder, `pushd` / `popd`,
  and commands with more than 32 parts. The approval card says so instead of offering a rule.
- **Refused rules**: commands that run other commands (`sh`, `bash`, `env`, `xargs`, `sudo`, `nohup`, `timeout`,
  `ssh`, …) and shell builtins that change the shell or evaluate their arguments (`export`, `set`, `printf`, `test`,
  …) can never be rules, and interpreters or package runners alone (`node`, `python`, `npx`, also `node -e` or
  `python3 -m` without the module) need more words (`node scripts/build.js`, `python3 -m pytest`).
- A shell call that a rule allowed shows a shield icon in its row and "Allowed by rule: …" in its output.

> **Think before you add a rule.** A rule for a script runner such as `pnpm test`, `npm run build` or `make` runs
> whatever code the project (and the agent, which can edit it) puts behind that script. Combined with Accept edits, such
> a rule is about as strong as Auto for the shell. Arguments still matter too: an allowed command can write files
> through its own options (`git diff --output=…`, `find … -delete`). Rules apply only to the builtin `shell` tool; tools
> of other plugins that run commands always ask.

## 8. The changes panel

In a project chat the **changes** button in the header (or **Alt+C**, or "Show changes" in the command palette) opens
the changes panel: a pane on the right on screens at least 1024 px wide (drag its edge, or use the arrow keys on it, to
resize it; the width and whether it is open are remembered), a sheet from the right on narrower screens (it opens only
when you ask for it).

- **This chat** lists the files the agent changed in this chat with `write_file` and `edit_file`, as they differ now
  from how they were before the chat touched them (status A / M / D, `+a −d`). Open a row for its diff. A warning icon
  means the file also changed outside this chat after the agent's last edit. Changes made by shell commands or by tools
  of other plugins are not listed here (the panel tells you how many ran). This view needs no git.
- **Git** shows `git status` of the project (including untracked files) with a diff against the last commit, when the
  project folder is inside a git repository. It reads the repository only: no staging, no commits, and git hooks,
  filters and other programs from the repository configuration never run.
- **Revert file** (the arrow on a row) puts one file back: in This chat to how it was before the chat changed it, in
  Git to the last commit (an untracked or new file is deleted, a renamed one gets its old name back). The current
  version is saved first, so the toast offers **Undo**. Conflicted files, symbolic links, submodules, files handled by
  a Git filter (such as Git LFS) and files git ignores cannot be reverted here. If the file changed after the panel
  showed it, the revert is refused ("… changed since its diff was loaded. Check it again.") and the list is refreshed.
  A file whose earlier version is no longer stored has no revert button in This chat.
- Revert, rewind and undo wait until no chat of the project is replying ("Wait for the responses in this project to
  finish …").

## 9. Rewind files

**Rewind files to here** (the clock-arrow icon under one of your messages in a project chat; it shows once the agent
changed a file with `write_file` or `edit_file` after that message) puts the files the agent changed **after that
message** back the way they were when you sent it. It covers every version of the conversation
since then (also replies you regenerated or edited away); edits made by other chats are never undone. The conversation
itself stays as it is.

1. The dialog lists every file it will restore or delete (a file the agent created after the message is deleted).
2. A file that changed outside this chat since the agent's last edit is a conflict: it is skipped unless you check
   **Also restore files changed outside this chat**.
3. **Shell changes aren't tracked**: the dialog lists the shell commands that ran after the message; whatever they did
   to files stays. Changes made by tools of other plugins stay too.
4. **Restore files** restores them; the toast offers **Undo**. **Restore files and edit** restores them and opens the
   message for editing, so you can send a new version from that point.

How it works: before every agent edit, and before every revert, rewind or undo, the previous content of the file is
saved in the data directory (`checkpoints/`, at most 8 MiB per file). Checkpoints are kept for 30 days and at most
512 MiB per project (the oldest go first; a file whose earlier version is gone shows "Can't restore"). They are deleted
with their chat or project, and they are never part of a backup. Edits made before v1.4 have no checkpoints.

## 10. Security notes

- A valid session can approve its own shell calls: anyone who can log in (or steal your session) can run commands as
  the server user. Set `HF_PASSWORD`, keep the server behind TLS when it is reachable from other machines, and use
  `HF_WORKSPACE_SHELL=0` when you do not need the shell.
- Adding a project needs your password (fresh auth); the roots and the kill switch come only from the environment.
- The file tools refuse paths outside the project folder (also through symbolic links) and never write inside `.git`;
  they are a guard against model mistakes, not against code that already runs on the server.
- Prefer Accept edits over Auto for editing work. Rewind and the changes panel (v1.4) undo the agent's file edits, but
  not what shell commands or other plugins' tools did: commit your project before long agent runs anyway.
- Shell rules are kept per server, never in a backup or export (a restored backup cannot grant shell rights). Adding
  one needs no password, because a logged-in session can already approve its own shell commands.
- The changes panel runs git only to read the repository, with hooks, `core.fsmonitor`, external diff tools, pagers
  and filter drivers switched off and never above the workspace root, so opening a cloned repository does not run its
  configured programs.

## 11. Rotate the master key

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

## 12. Unused files

Files that no chat uses anymore (attachments and generated images of deleted chats or versions) stay in the data
directory until a cleanup: Settings → Data → **Storage cleanup** shows what can be removed and removes it after you
confirm. v1.4 adds **Automatic cleanup** there (off by default, every day or every week; the first run comes at least
24 hours after the server starts, and files from the last 24 hours are always kept). The section shows when the next
run is due and how the last one went. A manual cleanup pushes the next automatic run back by one interval; a run is
skipped (and retried an interval later) when the plugin data is too large to scan completely; a server that restarts
more often than once a day never reaches its first run, so use the manual cleanup there. Automatic deletions cannot be
undone. Checkpoints (9) are separate: the cleanup never touches them.
