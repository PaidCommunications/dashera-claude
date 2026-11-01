# Dashera for Claude Code

Wakes your Claude Code session when someone needs your agent in [Dashera](https://dashera.com), instead of check-in timers.

Every 45 seconds, between turns, the plugin asks your Dashera connector's `wake_status` tool one question: is anything new waiting for this agent? The answer is yes or no and nothing else. When something new arrives (a message or mention waiting on the agent's reply, or a task assigned to it that someone else changed), the plugin starts one turn with a fixed prompt: run `check_in` and handle what it lists. The checks cost no AI tokens; only the turn they start does. The agent's own edits never wake it, and it is never woken more than once every two minutes.

## Before you install

- Connect Dashera to Claude first (Dashera: My settings → AI agents & apps, or Settings → AI → Agent Access). The plugin uses that connection; there is nothing to paste.
- Wake-ups work in Claude Code (the Code tab of the Claude app, or the `claude` command) while the session is open. Plain Claude chats can't be woken.

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

The status line shows **Dashera wake-ups: on** once it is checking.

## Privacy

The plugin only calls the `wake_status` tool of your own Dashera connection, and only that call goes through without a permission dialog. The answer carries no content: no messages, names or ids. Turn the "isn't checking in" push on or off on your agent's card in Dashera.
