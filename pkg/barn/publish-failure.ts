/**
 * The last failed publish, kept where a page reload cannot lose it.
 *
 * Screen 08 is a route rather than a panel of the editor, so it needs the error and the build
 * log to still be there after a navigation - and a build log is far too long to travel in a
 * query string. sessionStorage rather than localStorage because a failure is about this
 * sitting, not about this browser: a week-old build error resurfacing in a new tab would be
 * noise, and closing the tab is a reasonable way to say you are done with it.
 */
const KEY = 'barn.publish.failure';

export interface PublishFailure {
  extension: string;
  message:   string;
  log:       string;
  /** Milliseconds since the epoch, stamped when the failure was recorded. */
  at:        number;
}

export function recordFailure(extension: string, message: string, log: string): void {
  try {
    const failure: PublishFailure = {
      extension, message, log, at: Date.now(),
    };

    window.sessionStorage.setItem(KEY, JSON.stringify(failure));
  } catch { /* storage can be unavailable; the screen falls back to saying so */ }
}

export function readFailure(extension: string): PublishFailure | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const failure = raw ? JSON.parse(raw) as PublishFailure : null;

    // A failure belonging to a different extension is not this screen's failure.
    return failure && failure.extension === extension ? failure : null;
  } catch {
    return null;
  }
}

export function clearFailure(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch { /* see recordFailure */ }
}
