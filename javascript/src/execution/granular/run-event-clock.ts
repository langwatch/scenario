/**
 * Timestamps for one run's events when it reports granular events.
 *
 * The platform keys a stored MESSAGE_SNAPSHOT by its timestamp and ignores
 * one no later than the last it applied, so two snapshots in one millisecond
 * would drop the second. Snapshots therefore get strictly increasing
 * timestamps, and every other event is never stamped earlier than the event
 * before it, so a replay in timestamp order keeps the order the run emitted.
 * The time is taken when the event is made; a retry posts the same event.
 */
export class RunEventClock {
  private last = Number.NEGATIVE_INFINITY;
  private lastSnapshot = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  /** A timestamp no earlier than the previous one. */
  next(): number {
    this.last = Math.max(this.now(), this.last);
    return this.last;
  }

  /** A timestamp later than every snapshot before it, and never regressing. */
  nextSnapshot(): number {
    this.last = Math.max(this.now(), this.last, this.lastSnapshot + 1);
    this.lastSnapshot = this.last;
    return this.last;
  }
}
