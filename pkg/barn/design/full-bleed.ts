/**
 * Mix into any Studio screen that is a full frame in the design.
 *
 * All it does is carry the class the stylesheet next to it is keyed on, for as long as the
 * screen is mounted - see full-bleed.css for what that stylesheet undoes and why it cannot
 * live in the screen's own scoped block.
 *
 * Add/remove rather than set, and by class rather than by inline style, so two Studio routes
 * overlapping during a transition cannot leave <html> in whichever state unmounted last.
 */
import './full-bleed.css';

export const FULL_BLEED_CLASS = 'barn-full-bleed';

export default {
  mounted() {
    document.documentElement.classList.add(FULL_BLEED_CLASS);
  },

  beforeUnmount() {
    document.documentElement.classList.remove(FULL_BLEED_CLASS);
  },
};
