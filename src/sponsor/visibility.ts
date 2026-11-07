/**
 * How long something stayed on screen without a break.
 *
 * A booked line's impression counts only once the line was on screen for ten
 * seconds in one stretch (the gateway decides; this measures), and a week is
 * forecast on how long each place stayed on screen with a line in it. Both
 * are the same question asked of different things, so this answers it for
 * any key: a line's drawn id, or a place.
 *
 * **The frame is the only witness.** The renderer reports, after every commit
 * that changed what is drawn, the keys that are on screen now (`observe`). A
 * key that was on screen and is not any more ended a stretch at that moment;
 * a key that is still there is still on screen, however long ago the last
 * commit was, so a stretch is measured to `now` while it lasts. Nothing here
 * reads a clock of its own: every moment arrives as an argument, so a test can
 * walk it through time exactly.
 *
 * What this cannot see is whether anybody looked. The terminal may be behind
 * another window; a terminal that would say so (focus reporting) sends escape
 * sequences into the same input the editor reads, and that is not a risk worth
 * taking for a measurement. "On screen" therefore means drawn into the frame
 * of a terminal the tool is running in, and the advertising terms say exactly
 * that.
 */

/** One key's stretches on screen, the open one included. */
interface Track {
  /** When the stretch on screen now began, or null while it is off screen. */
  since: number | null;
  /** Every stretch that has ended, as [start, end). */
  done: Array<[number, number]>;
}

export class VisibilityClock {
  private tracks = new Map<string, Track>();

  /** The keys on screen as of `now`. Every key not in `onScreen` is off screen from `now`. */
  observe(onScreen: Iterable<string>, now: number): void {
    const visible = new Set(onScreen);
    for (const [key, track] of this.tracks) {
      if (track.since !== null && !visible.has(key)) {
        track.done.push([track.since, now]);
        track.since = null;
      }
    }
    for (const key of visible) {
      const track = this.tracks.get(key) ?? { since: null, done: [] };
      if (track.since === null) track.since = now;
      this.tracks.set(key, track);
    }
  }

  /**
   * The longest unbroken stretch `key` was on screen up to `now`, counting
   * only time from `from` on (a place is measured from the moment a booked
   * line could first have been drawn in it). Zero for a key never seen.
   */
  longest(key: string, now: number, from = Number.NEGATIVE_INFINITY): number {
    const track = this.tracks.get(key);
    if (!track) return 0;
    const stretches = track.since === null ? track.done : [...track.done, [track.since, now] as [number, number]];
    let best = 0;
    for (const [start, end] of stretches) best = Math.max(best, Math.min(end, now) - Math.max(start, from));
    return Math.max(0, best);
  }

  /** Forget everything: a new turn measures from nothing. */
  reset(): void {
    this.tracks.clear();
  }
}

/** The key a place is measured under, kept apart from every line's own id. */
export function placeKey(format: string): string {
  return `place:${format}`;
}
