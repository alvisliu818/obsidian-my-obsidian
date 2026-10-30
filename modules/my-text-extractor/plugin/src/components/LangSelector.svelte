<script>
  // 聚合仓适配：直引 MultiSelect.svelte 而非包桶文件——v11 的桶会连带
  // 文档组件（FileDetails → @wooorm/starry-night），这里用不到
  import MultiSelect from 'svelte-multiselect/MultiSelect.svelte'
  import { getOcrLangs } from 'obsidian-text-extract'
  import { selectedLanguages } from '../settings'

  const langs = getOcrLangs()
</script>

<div class="text-extract">
  <MultiSelect
    bind:selected="{$selectedLanguages}"
    options="{langs}"
    maxSelect="{3}" />
</div>

<style>
  .text-extract :global(div.multiselect) {
    color: var(--text-primary);
    border: var(--input-border-width) solid var(--background-modifier-border);
    background-color: var(--background-secondary);
  }
  .text-extract :global(div.multiselect > ul.options) {
    background-color: var(--background-secondary);
  }
  .text-extract :global(div.multiselect button) {
    border-radius: 0;
  }
  .text-extract :global(button:not(.clickable-icon)) {
    background-color: transparent;
    box-shadow: none;
    width: 1em;
  }
</style>
