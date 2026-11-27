<script lang="ts">
  import { detectFormat, type SourceFile } from "../parsers/index.ts";
  import type { Infra } from "../lib/model.ts";

  interface Props {
    /** Both return an error message, "" on success. */
    onapply: (files: SourceFile[]) => Promise<string>;
    onpick: (list: FileList) => Promise<string>;
  }
  let { onapply, onpick }: Props = $props();

  let dialog: HTMLDialogElement;
  let files = $state<SourceFile[]>([]);
  let current = $state(0);
  let error = $state("");

  export function open(sources: SourceFile[], infra: Infra) {
    files = sources.length ? sources.map((s) => ({ ...s })) : [{ path: "edited.json", text: JSON.stringify(infra, null, 2) }];
    current = 0;
    error = "";
    dialog.showModal();
  }

  /** An edit may change the format, say HCL replaced by compose; then the old file name would mislead. */
  function named({ path, text }: SourceFile): SourceFile {
    try {
      if (detectFormat("", text) === detectFormat(path, text)) return { path, text };
    } catch {}
    return { path: "edited", text };
  }

  async function apply(e: SubmitEvent) {
    e.preventDefault();
    error = await onapply(files.length === 1 ? [named(files[0])] : files.map((f) => ({ ...f })));
    if (!error) dialog.close();
  }

  async function pick(input: HTMLInputElement) {
    if (!input.files?.length) return;
    error = await onpick(input.files);
    input.value = "";
    if (!error) dialog.close();
  }
</script>

<dialog bind:this={dialog} aria-label="Edit infrastructure">
  <form onsubmit={apply}>
    <h2>Edit infrastructure</h2>
    <p>HCL, Terraform, <code>terraform show -json</code>, docker compose, Kubernetes or JSON. It is read in the browser and never uploaded.</p>
    <div class="row">
      <label class="button">Load files<input type="file" multiple hidden onchange={(e) => pick(e.currentTarget)} /></label>
      <label class="button">Load folder<input type="file" webkitdirectory multiple hidden onchange={(e) => pick(e.currentTarget)} /></label>
      {#if files.length > 1}
        <select bind:value={current} aria-label="File to edit">
          {#each files as f, i}<option value={i}>{f.path}</option>{/each}
        </select>
      {/if}
    </div>
    {#if files[current]}
      <textarea bind:value={files[current].text} spellcheck="false" aria-label="Source" placeholder={'node "api" { kind = "aws.lambda"  calls = ["db"] }\nnode "db" { kind = "aws.rds" }'}></textarea>
    {/if}
    {#if error}<p class="crit" role="alert">{error}</p>{/if}
    <div class="actions">
      <button type="button" onclick={() => dialog.close()}>Cancel</button>
      <button class="on">Show</button>
    </div>
  </form>
</dialog>

<style>
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  select { min-width: 0; max-width: 100%; }
</style>
