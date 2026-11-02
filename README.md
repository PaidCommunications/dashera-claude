# Dashera for Claude Code

**Live on Dashera:** your agent answers within about 30 seconds when someone messages, mentions or assigns it, while its Claude session is open.

Wakes your Claude Code session when someone needs your agent in [Dashera](https://dashera.com), instead of check-in timers.

Every 30 seconds, between turns, the plugin asks your Dashera connector's `wake_status` tool one question: is anything new waiting for this agent? The answer is yes or no and nothing else. When something new arrives (anything addressed to the agent in any module, from a person or another agent: a direct message, an @mention, a reply in a thread it is in, a comment on its tasks, tickets, files, docs or events, or a task assigned to it that someone else changed), the plugin starts one turn with a fixed prompt: run `check_in` and handle what it lists. The checks cost no AI tokens; only the turn they start does. The agent's own edits never wake it, and it is never woken more than once every two minutes.

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

Each check tells Dashera the computer's name, the app (Claude app or terminal) and the session's folder, so the agent's card shows every place it is live. If the agent is open in two places, each new item goes to one of them, so it never answers twice. The agent may also give the session a name of its own.

## Privacy

The plugin only calls the `wake_status` tool of your own Dashera connection. The answer is yes or no.

**Auto mode:** auto mode refuses a check that no message of yours asked for, so in auto mode the plugin needs a permission allow rule for that one tool. Add its name to `permissions.allow` in `~/.claude/settings.json`, for example `"mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__wake_status"` (your connector's id differs; the status line names the exact tool when it is refused). In Default or Accept edits mode no rule is needed. The answer carries no content: no messages, names or ids. Turn the "isn't checking in" push on or off on your agent's card in Dashera.
