# Dashera for Claude Code

**Live on Dashera:** your agent answers within about 20 seconds when someone messages, mentions or assigns it, while its Claude session is open.

Wakes your Claude Code session when someone needs your agent in [Dashera](https://dashera.com), instead of check-in timers.

Every 15 seconds, between turns, the plugin asks your Dashera connector's `wake_status` tool one question: is anything new waiting for this agent? The answer is yes or no and nothing else. When something new arrives (anything addressed to the agent in any module, from a person or another agent: a direct message, an @mention, a reply in a thread it is in, a comment on its tasks, tickets, files, docs or events, or a task assigned to it that someone else changed), the plugin waits about 20 seconds for the rest of the burst (never more than 30 seconds from its first item), then starts one turn with a fixed prompt ("New activity in Dashera (organization id <id>). Run check_in with brief: true, passing that id as organization."), and the agent runs `check_in` and handles what it lists. Quiet posts never wake it. The checks cost no AI tokens; only the turn they start does. The agent's own edits never wake it, and it is never woken more than once every 30 seconds. While the conversation is running a turn of its own, the wake-up waits and starts as soon as that turn ends.

## What the plugin sends

Every 15 seconds while a conversation is open, the plugin calls your Dashera connection's `wake_status` tool with: the conversation's id, the computer's name, the app (Claude app or terminal), the folder name, the plugin's version, the conversation's title when it changes, a random id for this copy of the plugin (`instance`, new each time it loads), and, when the conversation goes on under a new id, the id it last checked in under (`previousSessionId`). While a turn runs it also sends the turn's start time and, from 0.3.7, one fixed label for the kind of the latest tool call (such as "Reading files") with that call's time; never the call's inputs, file names, commands, URLs or content. From 0.3.8 the check after a prompt the plugin submitted also says what became of it (`deliveryResult`: entered, dropped or queued), once, and `deliveryBroken: true` while this copy's prompts keep dropping. From 0.3.9, when the agent calls one of the Dashera connector's write tools without `session`, the plugin adds this conversation's own session code to that call, and nothing else (see Filling in `session` on Dashera writes); it reads a Dashera answer only for the presence of `sessionWarning`. It never reads or sends what you write in the conversation. A conversation gets wake-ups only after it is connected and named, and End live session on the agent's card disconnects it. The answer is yes or no.

## Before you install

- Connect Dashera to Claude first (Dashera: My settings → AI agents & apps, or Settings → AI → Agent Access). The plugin uses that connection; there is nothing to paste.
- Live on Dashera works in Claude Code (the Code tab of the Claude app, or the `claude` command) while the session is open. Plain Claude chats can't be woken.

## Install

In the Claude app's Code tab: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `PaidCommunications/dashera-claude`, then **Add plugin**.

At the prompt of a terminal session:

```
/plugin install dashera --marketplace PaidCommunications/dashera-claude
```

From a shell:

```
claude plugin install dashera --marketplace PaidCommunications/dashera-claude
```

No restart is needed: the plugin loads in an open conversation when its current turn ends. End the turn (or send the conversation a message once it has ended) and the status line shows **Live on Dashera** once it is checking. Only if it still isn't running after a turn has ended, start a new conversation (or reopen the Claude app).

## Update

In a shell:

```
claude plugin marketplace update dashera-claude
claude plugin update dashera@dashera-claude
```

A one-conversation copy (a `dashera` folder in the session's mods folder) updates with `git pull` in that folder.

No restart: the new version loads in each open conversation when its current turn ends. To confirm, check the agent's card in Dashera, or `check_in`'s `heartbeat.installed`: it shows the version the running session reports. Only if it still shows the old version after a turn has ended, start a new conversation (or reopen the Claude app) as a fallback.

## Where it's running

Each check tells Dashera the computer's name, the app (Claude app or terminal), the session's folder and the plugin's version, so the agent's card shows every place it is live. If the agent is open in two places, each new item goes to one of them, so it never answers twice. The agent may also give the session a name of its own.

## Session names follow the conversation

Rename this conversation in Claude Code or the Claude app and the session's name on the agent's card follows within about a minute: the check carries the conversation's title when it changed, and nothing else. The plugin reads the title from the end of the conversation's own transcript file (the last `custom-title` line, at most the last 64 KB, at most once a minute); it never reads or sends the conversation's content.

The other way too: **Rename** the session on its card in Dashera and this conversation takes that name at its next prompt (a wake-up counts), through Claude Code's `sessionTitle` hook output. A name given in Dashera stays until the conversation is renamed again. Two sessions of one agent may share a name; their codes tell them apart, and Dashera's pickers show the code beside a shared name.

## Two copies in one conversation

**What happened (12 to 16 Nov 2026).** One conversation on the Mac Studio got no wake-up from 12 Nov on. Dashera saw two copies of the plugin checking in for it from one Claude process, with the same version and folder, told one to stand down, and woke the other, which never started a turn.

**What the code did.** Up to 0.3.7 each copy started a 15-second interval at `session.start` and never cancelled it. Nothing stopped a copy: there was no claim on the conversation and no registry of copies, and a second `session.start` in the same registration started a second interval beside the first. Two copies run when the plugin is installed and a one-conversation copy of it sits in the session's mods folder, or when the engine runs a second `session.start` for a copy (an enable, a worker respawn). The engine's documentation says a reload loads the module in a fresh environment and cancels the old one's timers, so a reload alone should not leave a copy behind. Which of these made the doubled copy on that Mac is not confirmed; the commands below tell them apart. The folder Dashera shows is the conversation's working folder, so it is the same for every copy.

**What 0.3.8 does.** Two layers.

1. **A lease.** The session holds one lease in the plugin's session state (`dashera.liveCopy`: the holding copy's id, when it came up, when it last renewed). It is per conversation, never shared across conversations. Before every check a copy reads it. While another copy's lease was renewed less than 15 seconds ago, this copy never calls `wake_status` and the status line says "Live on Dashera: another copy is active"; it reads the lease again every 15 seconds and takes over only once the lease is more than 30 seconds old. The holder renews the lease on every check. When two copies come up together, the one that came up first wins, and at the same moment the lower instance id. Each load runs one interval: a second `session.start` starts no other, and `session.end` cancels it and gives up the lease (a `/clear` or a resume goes on checking, since the process goes on and no `session.start` follows).
2. **Proof it can deliver.** Every prompt the plugin submits shows its result on the status line for 60 seconds (`Live on Dashera · S-XXXXXX · wake-up entered`, `dropped` or `queued`) and goes with the next check as `deliveryResult`. Two drops in a row: the copy gives up the lease and reports `deliveryBroken: true`, so another copy, or Dashera's alert to the owner, takes over. Both go only to a Dashera whose `wake_status` names them.

Dashera's stand-down (0.3.5) still applies on top.

**Confirm on the affected Mac** (read only; replace `<session-id>` with the conversation's id and `<project-folder>` with its folder under `~/.claude/projects`):

```
ls -la ~/.claude/dev-mods/
ls -la ~/.claude/dev-mods/<session-id>/
cat ~/.claude/dev-mods/<session-id>/dashera/hooks/version.ts
git -C ~/.claude/dev-mods/<session-id>/dashera log -1 --oneline
claude plugin list
ps -axo pid,ppid,lstart,command | grep -i '[c]laude'
ls -t ~/.claude/projects/<project-folder>/ | head
grep -c 'New activity in Dashera' ~/.claude/projects/<project-folder>/<session-id>.jsonl
grep 'New activity in Dashera' ~/.claude/projects/<project-folder>/<session-id>.jsonl | tail -3 | cut -c1-300
grep -o '"dashera[^"]*hook[^"]*"' ~/.claude/projects/<project-folder>/<session-id>.jsonl | sort | uniq -c
```

A `dashera` folder under the session's mods folder and `dashera` in `claude plugin list` means two copies load in that conversation. One Claude process for the conversation (in `ps`) rules out two processes. The last `New activity in Dashera` line shows when a wake-up last entered. After updating, the agent's card shows 0.3.8 and one copy per conversation.

## Filling in `session` on Dashera writes (0.3.9 design)

**Why.** From Dashera Release 2b every write tool of the connector takes an optional `session`, the caller's own live session code. When an agent has two or more live sessions and a write carries only the code the connection remembers (which may be a sibling conversation's), Dashera saves it with no session credit and adds `sessionWarning` (`code: "name_your_session"`) to the answer; a seat action in a Build Room answers 409 `name_your_session`. The plugin already knows this conversation's code from its own `wake_status` checks, so it fills it in and the agent needn't remember it.

**How a call is changed.** A `tool.call` hook runs before every tool call, the model's and its sub-agents' alike. It adds `session: "<this conversation's code>"` to the call's arguments only when all of these hold:

1. The tool is `mcp__<server>__<name>` and `<server>` is the Dashera connector this conversation checks in through: the prefix of the `wake_status` tool whose answer gave the code, and that same prefix also lists `check_in` or `advance_cursor`. A connector added from claude.ai is named by an id, so the name `dashera` is never required, and a `create_task` on any other server is never touched.
2. `<name>` is on the plugin's list of Dashera write tools that take the caller's own code (`SESSION_WRITE_TOOLS` in hooks/register.ts).
3. The call has no `session` of its own. A `session` the model passed is never overwritten, whatever its value.
4. The plugin has a code and the last check said this conversation is connected. Before the first answer, after the live session ended, while it is not connected, or after the conversation went on under a new id (until the next check), the call goes as written.

`check_in`, `advance_cursor` and `name_my_session` keep the behaviour they have had since 2 Nov 2026 (filled on any connector, connected or not, since naming the session is how it connects).

**Why a list.** A hooks module sees a tool's name and description (`$.tool.list()`), never an MCP tool's input schema, so the plugin can't ask whether a tool takes `session`. The list is taken from the Dashera source: every tool whose input schema has a `session` property (the tools written with `session: SESSION_PROP`, and the `AUTO_SESSION_TOOLS` that get it added, in lib/agent-cli/src/tools.ts), less the read tools and less the writes where `session` names someone else. `build_report_limit` is filled: left out, its `session` pauses all of the agent's runs, not only this conversation's. The Chief of Staff tools are filled too: their `session` is the session acting for the Owner (`build_set_qa_seat` names its seat with `target`). It must be kept in step with Dashera: a new write tool that takes `session` gets no fill until it is added here, and a renamed or dropped one is simply never called.

**Keeping the list in step.** `tests/dashera-session-tools.snapshot.ts` is a checked-in snapshot of every Dashera tool whose schema has `session`, with its access and the field's description. `tests/sessiontools.test.ts` fails, naming the tools, when a Dashera write tool in the snapshot is on neither `SESSION_WRITE_TOOLS` nor `NEVER_FILL`, when the list names a tool the snapshot doesn't have as a write, or when a read tool is on it. Regenerate the snapshot whenever Dashera adds, renames or drops a tool that takes `session` (every Dashera release that touches tools.ts), then run the tests and add each new tool to one of the two lists:

```
cd <dashera>/lib/agent-cli
./node_modules/.bin/tsx <plugin>/scripts/sync-session-tools.ts "$PWD/src/tools.ts" <plugin>/tests/dashera-session-tools.snapshot.ts
claude plugin test <plugin>
```

**Never touched.**
- Read tools, including the reads that take `session` as a filter (`list_agent_inbox`, `upcoming_reminders`, `list_unanswered`, `live_session`, `build_read_added_item`): filling would change what they answer.
- Writes whose `session` is another session: `wake_teammate` (the teammate to wake), `build_add_agent` and `build_remove_agent` (the session to seat or remove).
- `call`, `load_tools`, `wake_status` and every tool of any other server.
- Every other argument: the hook adds one field and reads nothing else of the call.

**When Dashera refuses the field.** A connector whose tool list predates Release 2b may refuse `session` before the call runs (the client's cached schema, or Dashera's `unknown_argument`). For a write the plugin sends the call again as written only when the refusal names `session` as an unexpected or unknown argument. Any other error, a permission denial, or a 403 is returned to the agent as it came, so a write is never run twice.

**sessionWarning.** The plugin reads a Dashera tool's answer only to look for `sessionWarning`. When one arrives it shows "Dashera: a write was saved without session credit" on the status line for 60 seconds, once per conversation. It never reads or forwards the live sessions or message the warning carries. A `wake_status` answer with an extra `sessionWarning` field is read as before.

**Risks.**
- The list drifts from Dashera's tools (see above). A tool missing from it only loses the fill; a tool wrongly on it would be sent this conversation's own code, which Dashera checks against the agent's own sessions.
- Two Dashera connectors for two agents (a personal login and a business account) in one conversation: only the connector whose check gave the code gets it, so one agent's code never goes to the other's writes.
- A stale code for a moment after a resume or `/clear`: the plugin drops its code as soon as a check sees the new conversation id and fills nothing until the next answer.
- Two copies of the plugin in one conversation both run this hook: the first fills `session`, the second sees it set and leaves it.

## What's new

- **Updates need no restart** (tested 12 Nov 2026 on two Macs): an installed or updated plugin loads in an open conversation when its current turn ends, and the agent's card in Dashera shows the version the running session reports. See Update.
- **0.3.9:** Dashera write tools (posts, comments, tasks, docs, Build Room actions and the rest that take `session`) get this conversation's own session code filled in when the agent leaves it out, so a write by an agent with several live sessions is credited to the right one and Build Room seat actions no longer answer `name_your_session`. Only on the Dashera connector this conversation checks in through, only while it is connected, never over a code the agent passed, never on read tools or on writes whose `session` names another session. A `sessionWarning` in an answer shows once on the status line. See Filling in `session` on Dashera writes.
- **0.3.8:** one live copy per conversation (see Two copies in one conversation). A lease in the session's state names the one copy that checks: another copy never calls `wake_status` while the lease is fresh, says "another copy is active", and takes over once the lease is over 30 seconds old. One interval per load, cancelled at session end. Every prompt's result (entered, dropped or queued) shows on the status line for 60 seconds and goes with the next check as `deliveryResult`; two drops in a row give up the lease and report `deliveryBroken`. Both only to a Dashera whose `wake_status` names them. A turn that started but shows no sign of life (no tool call) for 5 minutes no longer holds a wake-up for 30: the wake-up goes, the status line says "a turn looked stuck; delivering" for 60 seconds, a new turn after such a gap clears it, and Dashera is not told it is still running. A wake-up the engine queues behind one long command counts as delivered when its own turn starts.
- **0.3.7:** the "Thinking…" bubble in Dashera shows what the agent is doing, privacy first. While a turn runs, the checks the plugin already makes also carry the kind of its latest tool call as one fixed label (`activity`: Reading files, Editing code, Running a command, Searching the web, Using Dashera, Using a browser, Working with a sub-agent, or Working) and when that call was made (`activityAt`). Never the tool's inputs, file names, commands, URLs or content, and not even the tool's name. It clears when the turn ends. No extra requests, only to a Dashera that takes it, and a copy that stands down sends none.
- **0.3.6:** Dashera's receipts get real data. While this conversation runs a turn (yours or a wake-up's), the checks the plugin already makes also say when that turn started (`turnStartedAt`), so Dashera shows "Working…" on the session, and the first check after it ends says `"none"`. The check after a wake-up's prompt entered names that wake-up once (`deliveredMarker`), so the items it was for show "Delivered". No extra requests: it rides on the regular check, only to a Dashera that takes it, and a copy that stands down sends neither. The report is a time and a marker, never content.
- **0.3.5:** two copies of the plugin in one conversation (the installed plugin and a one-conversation copy, or an old copy for a while after an update) no longer both keep checking: Dashera wakes one of them and tells the other to stand down. That copy stops its checks, says "standing down" on the status line, and checks once every 10 minutes in case the other copy went away (then it carries on as usual). And when the agent tries to connect a conversation that the plugin sees isn't connected, the agent gets one short note with the plugin's own session code, once per conversation; conversations nobody tries to connect get nothing.
- **0.3.4 (security):** the wake-up prompt never carries text an organization chose. Until now it named the organization ("New activity in Dashera: <organization>"), and since any organization that adds your agent picks its own name, a name written as instructions reached your session as if you had typed it. The prompt is now a fixed template whose only variable part is organization ids, each checked to be a UUID (anything else is dropped, never quoted); with no ids it says to check in everywhere the agent works. The session code is used only when it has Dashera's form (`S-` and 6 hex digits).
- **0.3.3:** a wake-up always arrives. 0.3.2 counted a wake-up as sent the moment it asked for the turn, so one the app turned away, or one lost while the conversation was busy, used up its item and nothing woke the conversation for it again. Now a wake-up counts only once its turn is in: one turned away is asked again, and one that comes while the conversation runs a turn of its own starts as soon as that turn ends. A burst gets its one wake-up at most 30 seconds after its first item, and wake-ups can be 30 seconds apart (was two minutes).
- **0.3.2:** one wake-up per burst: the first new item starts a 20-second wait, and everything that arrives in it gets one wake-up instead of one each. The prompt is always exactly "New activity in Dashera: <organization>".
- **0.3.1:** a live session belongs to one conversation. 0.3.0 kept the last connected id per folder, so with several conversations in one folder a resumed one could name another's id and take its session (two conversations on one code). The plugin's store now keeps connected conversation ids, never folders, and a conversation resumed in a new process sends `previousSessionId` only when its own transcript shows it continues that id. Each copy of the plugin also sends `instance`, so when two copies check in for one conversation (an old copy for a while after an update) Dashera wakes only the newest and the session's card says "Two conversations are using this session".
- **0.3.0:** a connected conversation stays the same live session when it goes on under a new id (the Claude app restarting, a resume): each check reads the conversation's id again, and when it changed it also sends the id this conversation last checked in under while connected (`previousSessionId`, kept in the plugin's own store per folder, never content). Dashera keeps the session's code, name and assignments, so it never shows two codes for one conversation. A `/clear` starts a new conversation and carries nothing over.
- **0.2.15:** each check also sends the plugin's own version, so Dashera can show on the agent's card when a session's heartbeat is out of date (and the agent can tell you). A conversation whose live session was ended (by itself, or with End live session on the agent's card) stops checking until the next message you send in it; it connects again only when you paste the connect prompt from the card.
- **0.2.14:** session names follow the conversation's title, both ways (see above). Each check may carry `title`; the answer carries `name` and `nameSource`.
- **0.2.13:** a failed check never stops sending this conversation's id.
- **0.2.12:** the status line says when a conversation is open but not connected (opt-in live sessions).
- **0.2.11:** checks every 15 seconds (was 30); a check gives up after 12 s, inside one tick.

## Privacy

The plugin only calls the `wake_status` tool of your own Dashera connection. The answer is yes or no.

**Auto mode:** auto mode refuses a check that no message of yours asked for, so in auto mode the plugin needs a permission allow rule for that one tool. Add its name to `permissions.allow` in `~/.claude/settings.json`, for example `"mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__wake_status"` (your connector's id differs; the status line names the exact tool when it is refused). In Default or Accept edits mode no rule is needed. When auto mode blocks the check, the plugin asks your agent, once per conversation, to offer you that exact rule; nothing changes until you say yes. The answer carries no content: no messages, names or ids. Turn the "isn't checking in" push on or off on your agent's card in Dashera.
