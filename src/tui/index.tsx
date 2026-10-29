/** Entry point for the Ink TUI. Imported dynamically so `ink`/`react` only load
 *  for the interactive REPL, keeping one-shot commands fast. */
import React from "react"; // needed for the classic JSX transform (see app.tsx)
import { render } from "ink";
import { shells } from "../shells.ts";
import { App, type AppProps } from "./app.tsx";

export async function startTui(props: AppProps): Promise<void> {
  const { waitUntilExit } = render(<App {...props} />, { patchConsole: false });
  try {
    await waitUntilExit();
  } finally {
    // Nothing the agent started may outlive the REPL, and here it is not only
    // about orphans: a background child with piped stdio holds the event loop
    // open, so `/exit` with a dev server running would return the prompt and
    // then never actually exit. The `process.on("exit")` hook in `shells.ts`
    // cannot help with that — it fires when Node has already decided to go.
    shells.killAll();
  }
}
