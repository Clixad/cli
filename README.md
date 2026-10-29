# clixad

A terminal coding agent that routes model calls through the Clixad metering gateway. No
subscription: the cheapest models are free to use up to a daily allowance, and past that you earn
credits by completing rewarded offers in your browser and spend them on real model API calls.

`/model` marks which models are free and shows roughly how many free turns the allowance still buys
on each. The same allowance goes a lot further on the cheapest one. The status line counts it down,
and once it is gone the model carries on against credits. The REPL names the free models when it
opens and again if your balance runs out. `/help` leads with them too, and a new account starts on
one.

While you type a task, the status line shows roughly what it will cost and whether your credits
cover it, for example `task ≈ 560–3.1k · free` or `task ≈ 7.5k–47k · not enough, /model`. It is an
estimate from the size of the conversation and how tasks usually run; what is charged is what the
model actually used.

The same account also works in the browser, at <https://app.clixad.io/chat>: sign in with the
GitHub account you use here. A model, a reasoning setting, your name and instructions set there or on
its account page hold here too (from 0.0.1-beta.31), and `/model` and `/effort` here hold there.

`/effort` sets how long the model thinks before it answers, saved separately for each model.
Thinking is billed as output tokens like the answer, so a higher setting costs more credits per turn
and a lower one costs less. `auto` leaves the model at its own default, and a model with nothing to
adjust says so. The cost preview is not shown while a setting above the model's default is active,
because it is measured at the defaults.

**Early beta.** Commands, interfaces and credit mechanics may change between beta versions. Run the
most recent published build with:

```bash
npx clixad
```

or install it globally:

```bash
npm install -g clixad
```

Requires Node.js >= 20.

## What it does

It reads, searches and edits files and runs shell commands in the directory you start it in, asking
before it changes anything. `shift+tab` cycles through the permission modes. Beyond that:

- **Auto mode** asks you nothing while it works. Commands it knows are harmless run straight away,
  and a short list of destructive ones (`sudo`, deleting your home directory, piping a download into
  a shell, reading your SSH keys) is refused outright. Anything else is checked first by one short
  call to the model you are using, billed like any other call, and if that check cannot run you are
  asked instead. It is offered on every model except the two smallest, GPT-5 Nano and Gemini 2.5
  Flash-Lite.

- **Reads the web:** searches for current documentation and error messages, and fetches a page,
  JSON endpoint or PDF to read it.
- **Runs things in the background:** dev servers, watchers, tailed logs. They keep running across
  turns; `/bg` lists them and stops them, and nothing survives the session.
- **Looks at images:** point it at a screenshot with `@shot.png` and it sees the picture, not the
  filename.
- **Delegates wide searches** to a sub-agent, so the forty files it opened to find the three that
  mattered stay out of the conversation you are paying for.
- **Keeps a task list** on multi-step work, and **asks you** when guessing wrong would waste real
  work.
- **Uses MCP servers** you configure in `.mcp.json` or `~/.clixad/mcp.json`; `/mcp` shows their
  status. Every tool a server offers is put to you before it runs.

Type `/help` for the commands, `@` to attach a file, and `!` to run a shell command yourself.

## Build from source

The source is at <https://github.com/clixad/cli>. It is the CLI only: the gateway it talks to,
which meters model calls and keeps your balance, is a separate service and is not part of it.

```bash
git clone https://github.com/clixad/cli.git
cd cli
npm ci
npm run build       # bundles the CLI into dist/
node dist/clixad.mjs --version
npm test
npm run typecheck
```

`npm start` runs the CLI from source without building it.

## Issues and pull requests

Bug reports and feature requests are welcome, as
[GitHub issues](https://github.com/clixad/cli/issues) or on
[Discord](https://discord.gg/bD6FYdJfcy).

We don't accept pull requests. Clixad is developed in a private repository, and
github.com/clixad/cli is an automatic one-way copy of the CLI's part of it, so a pull request has
nowhere to be merged and is closed automatically. If you have a fix in mind, describe it in an
issue.

Please report security problems privately, through "Report a vulnerability" on the repository's
Security tab, rather than in a public issue.

## Status

Pre-release, published under the `beta` dist-tag. `npx clixad` resolves to the latest published
version. Account creation is decided by the gateway, so a fresh install may land on a waitlist until
signups are open.

## License

Copyright 2026 Florian Rappold. Licensed under the [Apache License 2.0](LICENSE); see also
[NOTICE](NOTICE).

The license covers the CLI's source code. Using the Clixad service through it is subject to the
[terms](https://clixad.io/terms.html), and the license does not cover the Clixad name or logo.
