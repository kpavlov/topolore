<script lang="ts">
  import { readDropped, readPicked } from "../parsers/files.ts";
  import type { SourceFile } from "../parsers/index.ts";

  /** Returns an error message, "" on success. */
  let { oncompare }: { oncompare: (before: SourceFile[], after: SourceFile[]) => Promise<string> } = $props();

  interface Side {
    title: string;
    text: string;
    files: SourceFile[]; // chosen or dropped; they replace the text box
  }
  const empty = (title: string): Side => ({ title, text: "", files: [] });

  let dialog: HTMLDialogElement;
  let sides = $state<Side[]>([empty("Base (before)"), empty("Target (after)")]);
  let error = $state("");

  export function open(current: SourceFile[]) {
    sides = [empty("Base (before)"), empty("Target (after)")];
    if (current.length === 1) sides[0].text = current[0].text;
    else sides[0].files = current;
    error = "";
    dialog.showModal();
  }

  async function take(side: Side, reading: Promise<SourceFile[]>) {
    try {
      const files = await reading;
      error = "";
      if (files.length === 1) (side.text = files[0].text), (side.files = []);
      else side.files = files;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function compare(e: SubmitEvent) {
    e.preventDefault();
    const [before, after] = sides.map((s) => (s.files.length ? s.files.map((f) => ({ ...f })) : s.text.trim() ? [{ path: "", text: s.text }] : []));
    if (!before.length || !after.length) return void (error = "Give both a before and an after.");
    error = await oncompare(before, after);
    if (!error) dialog.close();
  }
</script>

<dialog bind:this={dialog} aria-label="Compare topologies">
  <form onsubmit={compare}>
    <h2>Compare</h2>
    <p>Paste, choose or drop each side. Nodes are matched by their address or id.</p>
    <div class="sides">
      {#each sides as side}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <section ondrop={(e) => (e.preventDefault(), e.stopPropagation(), e.dataTransfer && take(side, readDropped(e.dataTransfer)))}>
          <h3>{side.title}</h3>
          <div class="row">
            <label class="button">Files<input type="file" multiple hidden onchange={(e) => e.currentTarget.files?.length && take(side, readPicked(e.currentTarget.files))} /></label>
            <label class="button">Folder<input type="file" webkitdirectory multiple hidden onchange={(e) => e.currentTarget.files?.length && take(side, readPicked(e.currentTarget.files))} /></label>
            {#if side.files.length}<button type="button" onclick={() => (side.files = [])}>Clear {side.files.length} files</button>{/if}
          </div>
          {#if side.files.length}
            <ul>{#each side.files as f}<li>{f.path}</li>{/each}</ul>
          {:else}
            <textarea bind:value={side.text} spellcheck="false" aria-label={side.title}></textarea>
          {/if}
        </section>
      {/each}
    </div>
    {#if error}<p class="crit" role="alert">{error}</p>{/if}
    <div class="actions">
      <button type="button" onclick={() => dialog.close()}>Cancel</button>
      <button class="on">Compare</button>
    </div>
  </form>
</dialog>

<style>
  dialog { width: min(1040px, calc(100% - 32px)); }
  .sides { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  section { display: grid; gap: 6px; align-content: start; min-width: 0; }
  h3 { margin: 0; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  textarea, ul { height: min(50vh, 400px); }
  ul { margin: 0; padding: 8px; overflow: auto; list-style: none; font: 12px var(--mono); border: 1px solid var(--line); border-radius: 6px; }
  @media (max-width: 720px) { .sides { grid-template-columns: 1fr; } textarea, ul { height: 22vh; } }
</style>
