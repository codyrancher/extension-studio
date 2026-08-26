<script>
// Rancher's own Extensions page, with a way into the Studio on it.
//
// The Studio used to have an entry in the top-level menu, beside Cluster Management. It does
// not need one: the thing it makes is an extension, and the page a person goes to when they
// are thinking about extensions is this one. So the way in belongs here, next to the list of
// what is already installed.
//
// Rancher's page is rendered rather than reimplemented. Copying it would mean carrying a fork
// of a page that keeps changing - its catalog list, its install flow, its plugin panel - and
// silently drifting from whatever the dashboard this is loaded into actually ships. Importing
// the component means this is that page, whatever version it is, with one thing added above it.
//
// The route is registered under Rancher's own name (`c-cluster-uiplugins`) in index.ts, so
// every existing link to Extensions - the menu, a bookmark, a redirect after installing - lands
// here without knowing anything changed.
import { SButton, SIcon } from '../components/ui';
import { STUDIO_ROUTE } from '../editor-product';
import UIPlugins from '@shell/pages/c/_cluster/uiplugins/index.vue';

export default {
  name: 'RancherExtensionsWithStudio',

  components: { SButton, SIcon, UIPlugins },

  computed: {
    studio() {
      return { name: STUDIO_ROUTE };
    },
  },

  methods: {
    open() {
      this.$router.push(this.studio);
    },
  },
};
</script>

<template>
  <div class="barn-extensions">
    <!--
      Above the page rather than inside it: what is below is Rancher's, and anything this
      writes into it would be a claim on markup that is not ours to hold.
    -->
    <div class="barn-extensions__studio" data-testid="barn-studio-launch">
      <SIcon name="sparkle" :size="16" />
      <div class="barn-extensions__text">
        <span class="barn-extensions__title">Extension Studio</span>
        <span class="barn-extensions__note">
          Describe an extension and the assistant writes it, runs it against this Rancher, and
          shows you the result before anything is installed.
        </span>
      </div>
      <SButton
        variant="primary"
        size="sm"
        icon="arrowRight"
        data-testid="barn-studio-launch-button"
        @click="open"
      >
        Open the Studio
      </SButton>
    </div>

    <UIPlugins />
  </div>
</template>

<style lang="scss" scoped>
.barn-extensions {
  display:        flex;
  flex-direction: column;
  min-height:     0;

  &__studio {
    display:       flex;
    align-items:   center;
    gap:           12px;
    margin-bottom: 16px;
    padding:       12px 16px;
    border:        1px solid var(--studio-border, var(--border));
    border-radius: var(--studio-radius, 4px);
    background:    var(--studio-surface-subtle, var(--body-bg));
  }

  &__text {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    flex:           1;
    min-width:      0;
  }

  &__title {
    font-weight: 600;
    font-size:   13px;
    color:       var(--studio-text, var(--body-text));
  }

  &__note {
    font-size: 12px;
    color:     var(--studio-text-secondary, var(--muted));
  }
}
</style>
