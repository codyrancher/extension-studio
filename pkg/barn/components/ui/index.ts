/**
 * The Extension Studio design system.
 *
 * Ten primitives, five of which are the component sets on the Figma file's Components page
 * (Button, State Badge, Labeled Input, Tab, Banner) and five of which are shapes the screens
 * repeat often enough to be components whether or not the file says so (chip, card, row,
 * panel, toolbar) - plus the icon set, the section label, the dialog shell and the empty state.
 *
 * Importing from here rather than by path means a screen names what it uses, and the token
 * stylesheet is pulled in exactly once as a side effect of that import.
 */
import '../../design/tokens';

export { default as SBadge } from './SBadge.vue';
export { default as SBanner } from './SBanner.vue';
export { default as SButton } from './SButton.vue';
export { default as SCard } from './SCard.vue';
export { default as SChip } from './SChip.vue';
export { default as SEmpty } from './SEmpty.vue';
export { default as SField } from './SField.vue';
export { default as SIcon } from './SIcon.vue';
export { default as SLabel } from './SLabel.vue';
export { default as SMenu } from './SMenu.vue';
export { default as SModal } from './SModal.vue';
export { default as SPanel } from './SPanel.vue';
export { default as SRow } from './SRow.vue';
export { default as STabs } from './STabs.vue';
export { default as SToolbar } from './SToolbar.vue';
