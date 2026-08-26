// Keep a scrolling pane at the bottom while its content is still arriving.
//
// Scrolling to the bottom once, after the render, is the obvious thing and it is not enough:
// what these panes hold keeps growing after that tick. A turn's pictures decode, its chips wrap
// onto a second line, a change set's bubble reflows when its prompt arrives - each of which
// makes the content taller than it was when `scrollTop = scrollHeight` ran, and each of which
// leaves the view a little short of the end. That is the "mostly to the bottom, then things pop
// in" the Assistant tab does.
//
// So this watches the content instead of the event that produced it. While the pane is pinned,
// anything that changes its height puts it back at the bottom; the moment somebody scrolls away
// from the bottom themselves, it unpins and stays where they put it. Reaching the bottom again
// re-pins, which is what every chat window does and what people expect without being told.

/** How far from the bottom still counts as being at it. A rounding allowance, not a policy. */
const NEAR = 24;

export interface StickToBottom {
  /** Put it at the bottom now and pin it there, whatever the user had done before. */
  pin(): void;
  /** Stop watching. Safe to call twice. */
  stop(): void;
}

/**
 * Pin `el` to its own bottom while its content grows.
 *
 * Returns a handle rather than nothing, because the two moments that matter are different: a
 * component mounting wants to watch from now on, and a component that has just loaded a fresh
 * list wants to go to the bottom whether or not somebody had scrolled up in the last one.
 */
export function stickToBottom(el: HTMLElement | null | undefined): StickToBottom {
  if (!el) {
    return { pin: () => {}, stop: () => {} };
  }

  let pinned = true;
  let observer: ResizeObserver | null = null;

  const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR;

  /**
   * Go to the bottom, and again once the frame has been laid out.
   *
   * Setting `scrollTop` on a pane that is not being displayed does nothing at all - its
   * scrollHeight is zero, so there is no bottom to go to - and that is the ordinary case here:
   * both of these panes are kept mounted behind a `v-show` while another tab is on screen, so
   * the load that fills them finishes while they are invisible. The retry is what catches the
   * moment they become real, and the frame after it is what catches a height that was still
   * settling when the first one ran.
   */
  const toBottom = () => {
    if (el.clientHeight > 0) {
      el.scrollTop = el.scrollHeight;
    }

    requestAnimationFrame(() => {
      if (pinned && el.clientHeight > 0) {
        el.scrollTop = el.scrollHeight;
      }
    });
  };

  /**
   * When somebody last touched the scrollbar themselves.
   *
   * This is the difference between "the reader scrolled up" and "the list re-rendered". Both
   * fire `scroll`, and reading them the same way is what made this fail on the one path that
   * mattered: opening the Changes tab reloads the rail, the re-render resets scrollTop to 0,
   * the browser fires a scroll event, and the pane concluded the reader had scrolled to the
   * top and unpinned itself for good. So only a scroll that follows an actual gesture is
   * allowed to unpin.
   */
  let gestureAt = 0;
  const GESTURE_WINDOW = 400;

  const onGesture = () => {
    gestureAt = Date.now();
  };

  const onScroll = () => {
    if (atBottom()) {
      // Arriving at the bottom always re-pins, however it was arrived at.
      pinned = true;

      return;
    }

    if (Date.now() - gestureAt < GESTURE_WINDOW) {
      pinned = false;
    }
  };

  const onGrow = () => {
    if (pinned) {
      toBottom();
    }
  };

  el.addEventListener('scroll', onScroll, { passive: true });

  for (const gesture of ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown']) {
    el.addEventListener(gesture, onGesture, { passive: true });
  }

  // The moment the pane becomes visible.
  //
  // Both of these panes are mounted behind a `v-show`, so the first time anybody opens the tab
  // is a transition from no height to full height with no scroll, no resize of the content and
  // no load - nothing else here would notice it.
  let seen: IntersectionObserver | null = null;

  if (typeof IntersectionObserver !== 'undefined') {
    seen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && pinned) {
        toBottom();
      }
    });
    seen.observe(el);
  }

  // The content, not the pane: the pane's own size rarely changes, and what moves the bottom
  // out of reach is the thing inside it getting taller. The pane itself is watched too, because
  // going from hidden to shown is a size change and is the moment this most needs to act.
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(onGrow);
    observer.observe(el);

    for (const child of Array.from(el.children)) {
      observer.observe(child);
    }
  }

  // Children that did not exist when this was wired up.
  //
  // A pane is watched from `mounted`, and what it will hold arrives later - from a pod, over an
  // exec that takes a second. A ResizeObserver only reports elements it was given, so without
  // this it would watch an empty pane forever and never hear the twenty change sets that turned
  // up in it.
  if (typeof MutationObserver !== 'undefined') {
    const added = new MutationObserver(() => {
      if (observer) {
        for (const child of Array.from(el.children)) {
          observer.observe(child);
        }
      }

      onGrow();
    });

    added.observe(el, { childList: true });

    const stopAdded = () => added.disconnect();

    // Folded into the handle's own teardown below.
    (el as unknown as { __barnStopAdded?: () => void }).__barnStopAdded = stopAdded;
  }

  return {
    pin() {
      pinned = true;
      toBottom();

      // And again over the next second and a half.
      //
      // One scroll is not enough and neither is one frame: opening the tab reloads the list,
      // Vue patches the DOM in place, and the pane's height keeps moving while that settles -
      // a card's chips wrap, a bubble reflows, a picture decodes. Measured on the real rail,
      // the last of those landed about fifteen seconds in and left the view a few hundred
      // pixels short. These retries cost nothing and are over before anybody has read a line.
      for (const delay of [0, 120, 350, 800, 1500]) {
        setTimeout(() => {
          if (!pinned) {
            return;
          }

          if (observer) {
            for (const child of Array.from(el.children)) {
              observer.observe(child);
            }
          }

          toBottom();
        }, delay);
      }
    },

    stop() {
      el.removeEventListener('scroll', onScroll);

      for (const gesture of ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown']) {
        el.removeEventListener(gesture, onGesture);
      }

      seen?.disconnect();
      seen = null;
      observer?.disconnect();
      observer = null;

      const holder = el as unknown as { __barnStopAdded?: () => void };

      holder.__barnStopAdded?.();
      delete holder.__barnStopAdded;
    },
  };
}
