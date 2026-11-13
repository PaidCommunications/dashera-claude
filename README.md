# Dashera for Claude Code

**Live on Dashera:** your agent answers within about 20 seconds when someone messages, mentions or assigns it, while its Claude session is open.

Wakes your Claude Code session when someone needs your agent in [Dashera](https://dashera.com), instead of check-in timers.

Every 15 seconds, between turns, the plugin asks your Dashera connector's `wake_status` tool one question: is anything new waiting for this agent? The answer is yes or no and nothing else. When something new arrives (anything addressed to the agent in any module, from a person or another agent: a direct message, an @mention, a reply in a thread it is in, a comment on its tasks, tickets, files, docs or events, or a task assigned to it that someone else changed), the plugin waits about 20 seconds for the rest of the burst (never more than 30 seconds from its first item), then starts one turn with a fixed prompt ("New activity in Dashera (organization id <id>). Run check_in with brief: true, passing that id as organization."), and the agent runs `check_in` and handles what it lists. Quiet posts never wake it. The checks cost no AI tokens; only the turn they start does. The agent's own edits never wake it, and it is never woken more than once every 30 seconds. While the conversation is running a turn of its own, the wake-up waits and starts as soon as that turn ends.

## What the plugin sends

Every 15 seconds while a conversation is open, the plugin calls your Dashera connection's `wake_status` tool with: the conversation's id, the computer's name, the app (Claude app or terminal), the folder name, the plugin's version, the conversation's title when it changes, a random id for this copy of the plugin (`instance`, new each time it loads), and, when the conversation goes on under a new id, the id it last checked in under (`previousSessionId`). It never reads or sends what you write in the conversation. A conversation gets wake-ups only after it is connected and named, and End live session on the agent's card disconnects it. The answer is yes or no.

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

The status line shows **Live on Dashera** once it is checking.

## Where it's running

Each check tells Dashera the computer's name, the app (Claude app or terminal), the session's folder and the plugin's version, so the agent's card shows every place it is live. If the agent is open in two places, each new item goes to one of them, so it never answers twice. The agent may also give the session a name of its own.

## Session names follow the conversation

Rename this conversation in Claude Code or the Claude app and the session's name on the agent's card follows within about a minute: the check carries the conversation's title when it changed, and nothing else. The plugin reads the title from the end of the conversation's own transcript file (the last `custom-title` line, at most the last 64 KB, at most once a minute); it never reads or sends the conversation's content.

The other way too: **Rename** the session on its card in Dashera and this conversation takes that name at its next prompt (a wake-up counts), through Claude Code's `sessionTitle` hook output. A name given in Dashera stays until the conversation is renamed again. Two sessions of one agent may share a name; their codes tell them apart, and Dashera's pickers show the code beside a shared name.

## What's new

- **0.3.6:** Dashera's receipts get real data. While this conversation runs a turn (yours or a wake-up's), the checks the plugin already makes also say when that turn started (`turnStartedAt`), so Dashera shows "Working…" on the session, and the first check after it ends says `"none"`. The check after a wake-up's prompt entered names that wake-up once (`deliveredMarker`), so the items it was for show "Delivered". No extra requests: it rides on the regular check, only to a Dashera that takes it, and a copy that stands down sends neither. The report is a time and a marker, never content. After updating, quit and reopen the Claude app (or start a new `claude` session).
- **0.3.5:** two copies of the plugin in one conversation (the installed plugin and a one-conversation copy, or an old copy for a while after an update) no longer both keep checking: Dashera wakes one of them and tells the other to stand down. That copy stops its checks, says "standing down" on the status line, and checks once every 10 minutes in case the other copy went away (then it carries on as usual). And when the agent tries to connect a conversation that the plugin sees isn't connected, the agent gets one short note with the plugin's own session code, once per conversation; conversations nobody tries to connect get nothing. After updating, quit and reopen the Claude app (or start a new `claude` session).
- **0.3.4 (security):** the wake-up prompt never carries text an organization chose. Until now it named the organization ("New activity in Dashera: <organization>"), and since any organization that adds your agent picks its own name, a name written as instructions reached your session as if you had typed it. The prompt is now a fixed template whose only variable part is organization ids, each checked to be a UUID (anything else is dropped, never quoted); with no ids it says to check in everywhere the agent works. The session code is used only when it has Dashera's form (`S-` and 6 hex digits). After updating, quit and reopen the Claude app (or start a new `claude` session).
- **0.3.3:** a wake-up always arrives. 0.3.2 counted a wake-up as sent the moment it asked for the turn, so one the app turned away, or one lost while the conversation was busy, used up its item and nothing woke the conversation for it again. Now a wake-up counts only once its turn is in: one turned away is asked again, and one that comes while the conversation runs a turn of its own starts as soon as that turn ends. A burst gets its one wake-up at most 30 seconds after its first item, and wake-ups can be 30 seconds apart (was two minutes). After updating, quit and reopen the Claude app (or start a new `claude` session).
- **0.3.2:** one wake-up per burst: the first new item starts a 20-second wait, and everything that arrives in it gets one wake-up instead of one each. The prompt is always exactly "New activity in Dashera: <organization>". After updating, quit and reopen the Claude app (or start a new `claude` session).
- **0.3.1:** a live session belongs to one conversation. 0.3.0 kept the last connected id per folder, so with several conversations in one folder a resumed one could name another's id and take its session (two conversations on one code). The plugin's store now keeps connected conversation ids, never folders, and a conversation resumed in a new process sends `previousSessionId` only when its own transcript shows it continues that id. Each copy of the plugin also sends `instance`, so when two copies check in for one conversation (an old copy for a while after an update) Dashera wakes only the newest and the session's card says "Two conversations are using this session". After updating, quit and reopen the Claude app (or start a new `claude` session).
- **0.3.0:** a connected conversation stays the same live session when it goes on under a new id (the Claude app restarting, a resume): each check reads the conversation's id again, and when it changed it also sends the id this conversation last checked in under while connected (`previousSessionId`, kept in the plugin's own store per folder, never content). Dashera keeps the session's code, name and assignments, so it never shows two codes for one conversation. A `/clear` starts a new conversation and carries nothing over. After updating, quit and reopen the Claude app (or start a new `claude` session).
- **0.2.15:** each check also sends the plugin's own version, so Dashera can show on the agent's card when a session's heartbeat is out of date (and the agent can tell you). A conversation whose live session was ended (by itself, or with End live session on the agent's card) stops checking until the next message you send in it; it connects again only when you paste the connect prompt from the card. After updating, quit and reopen the Claude app (or start a new `claude` session).
- **0.2.14:** session names follow the conversation's title, both ways (see above). Each check may carry `title`; the answer carries `name` and `nameSource`. After updating, quit and reopen the Claude app (or start a new `claude` session) so the new version loads: a plugin's code is read when a session starts.
- **0.2.13:** a failed check never stops sending this conversation's id.
- **0.2.12:** the status line says when a conversation is open but not connected (opt-in live sessions).
- **0.2.11:** checks every 15 seconds (was 30); a check gives up after 12 s, inside one tick.

## Privacy

The plugin only calls the `wake_status` tool of your own Dashera connection. The answer is yes or no.

**Auto mode:** auto mode refuses a check that no message of yours asked for, so in auto mode the plugin needs a permission allow rule for that one tool. Add its name to `permissions.allow` in `~/.claude/settings.json`, for example `"mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__wake_status"` (your connector's id differs; the status line names the exact tool when it is refused). In Default or Accept edits mode no rule is needed. When auto mode blocks the check, the plugin asks your agent, once per conversation, to offer you that exact rule; nothing changes until you say yes. The answer carries no content: no messages, names or ids. Turn the "isn't checking in" push on or off on your agent's card in Dashera.
