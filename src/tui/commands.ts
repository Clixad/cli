/**
 * The slash commands the REPL knows about, in one place: the autocomplete menu
 * under the input box, /help and the welcome banner all read from this list, so
 * a new command shows up everywhere at once.
 */

export interface SlashCommand {
  name: string;
  /** Argument hint. A command with args is completed to "/name " rather than run. */
  args?: string;
  desc: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: "help", desc: "list the commands" },
  { name: "model", desc: "switch model" },
  { name: "models", desc: "list models + prices" },
  // Deliberately *no* `args`, for `/model`'s reason: an arg hint makes enter
  // complete the command instead of running it, and the picker is the point.
  // `/effort low` still works when typed in full.
  { name: "effort", desc: "how long the model thinks (more thinking, more credits)" },
  { name: "mode", args: "[name]", desc: "permission mode (or press shift+tab)" },
  { name: "wallet", desc: "balance & ads today" },
  // Not "watch an ad": nothing on the wall is a video. CPX serves sign-up
  // forms, surveys and app trials, and describing the top-up as a video costs
  // the user the one expectation that makes a screenout make sense.
  { name: "earn", desc: "open the offer wall to earn credits" },
  // Deliberately *no* `args`, for /login's reason: an arg hint makes enter
  // complete the command instead of running it, and printing the code is the
  // whole command.
  { name: "refer", desc: "your invite code, and what it has earned" },
  // This one *does* carry an `args` hint, unlike /refer and /login: the code is
  // the whole command, and `/redeem` on its own has nothing to do — so enter
  // completing to "/redeem " is the helpful outcome rather than the surprising
  // one.
  { name: "redeem", args: "<code>", desc: "spend a code you were given" },
  // The only purchase surface in the CLI. It used to be `clixad buy`, a
  // subcommand you had to quit the REPL to reach — and one nobody found, since
  // the REPL is the default entry point and never mentioned it. Deliberately
  // *no* `args` hint, for `/model`'s reason: an arg hint makes enter complete
  // the command instead of running it, and the pack picker is the point.
  { name: "buy", desc: "buy a credit pack (optional — offers are free)" },
  // Reachable from inside the REPL because that is where the 401 is printed.
  // "Run `clixad login` first" is not a runnable instruction at this prompt —
  // anything without a leading slash is a prompt, so it went to the model and
  // came back as the same 401.
  //
  // Deliberately *no* `args`, though `/login <email>` works: an arg hint makes
  // enter complete the command instead of running it, and this is the one
  // command whose whole job is to be the exit from a stuck REPL. The email form
  // is the dev shortcut, documented on `clixad login [email]`, not the path
  // somebody in a 401 loop needs.
  { name: "login", desc: "sign in, or switch account" },
  { name: "compact", desc: "summarise the conversation to free context" },
  { name: "clear", desc: "clear the screen and start a new session" },
  // Deliberately *no* `args` on /resume, for /login's reason: an arg hint makes
  // enter complete the command instead of running it, and the picker is the
  // point. `/resume <id>` still works when typed in full.
  { name: "resume", desc: "pick up an earlier session in this directory" },
  { name: "init", desc: "write a CLIXAD.md for this project" },
  // Deliberately *no* `args` on either, for /login's reason: an arg hint makes
  // enter complete the command instead of running it, and listing is what both
  // are for. `/bg kill <id>` still works when typed in full.
  { name: "bg", desc: "background commands the agent started" },
  { name: "mcp", desc: "connected MCP servers and their tools" },
  { name: "exit", desc: "quit clixad" },
];

/** Label as shown in the menu and in /help, e.g. "/model [id]". */
export function commandLabel(c: SlashCommand): string {
  return `/${c.name}${c.args ? ` ${c.args}` : ""}`;
}

/**
 * The commands to offer for the current input, or [] when the menu should stay
 * closed. It is open while the command word is being typed: "/" lists
 * everything, "/m" narrows to /model + /models, and a space ends it (whatever
 * follows is an argument, not a command).
 */
export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/") || input.includes(" ")) return [];
  const word = input.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(word));
}

/**
 * The /help body, built from the same list the menu uses.
 *
 * `free` is the line about the free models (`freeHelpLine`), and it leads when
 * there is one: /help is where somebody goes to find out what they can do, and
 * "some models cost nothing today" is the answer most of them are looking for
 * without knowing to ask. Absent on a gateway with no free tier or a paused one.
 */
export function helpText(free?: { label: string; desc: string }): string {
  const w = Math.max(...COMMANDS.map((c) => commandLabel(c).length), free ? free.label.length : 0);
  return (
    (free ? `  ${free.label.padEnd(w + 2)}${free.desc}\n\n` : "") +
    COMMANDS.map((c) => `  ${commandLabel(c).padEnd(w + 2)}${c.desc}`).join("\n") +
    "\n\n" +
    [
      "  @path        attach a file to the message (tab completes)",
      "  !command     run a shell command yourself, no model call",
      "  shift+tab    cycle permission mode · esc  stop the current turn",
      "  ctrl+o       expand the newest collapsed tool output · ctrl+c twice  quit",
      "  \\ + enter    continue on a new line",
    ].join("\n")
  );
}
