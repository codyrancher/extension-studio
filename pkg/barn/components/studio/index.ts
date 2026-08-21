/**
 * The Studio screens' composite pieces.
 *
 * Where `components/ui` holds the design system's primitives - the things the Figma file has a
 * component set for - this holds the assemblies: a panel, a turn, a screen's worth of one idea.
 * A screen should be readable as a handful of these rather than as several hundred lines of
 * divs, and anything here that only one screen ever uses is a sign it belongs in that screen.
 */
export { default as ActivityTurn } from './ActivityTurn.vue';
export { default as AssistantPanel } from './AssistantPanel.vue';
export { default as PreviewPanel } from './PreviewPanel.vue';
export { default as WorkingChanges } from './WorkingChanges.vue';
