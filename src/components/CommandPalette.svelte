<script lang="ts">
  import { searchNodes } from "../graph/search.ts";
  import type { Infra, InfraNode } from "../lib/model.ts";

  let { infra, onpick }: { infra: Infra; onpick: (id: string) => void } = $props();

  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let query = $state("");
  let index = $state(0);
  let results = $state.raw<InfraNode[]>([]);

  const search = () => ((results = searchNodes(infra, query)), (index = 0));

  export function toggle() {
    if (dialog.open) return dialog.close();
    query = "";
    search();
    dialog.showModal();
    input.focus();
  }

  function choose(id: string) {
    dialog.close();
    onpick(id);
  }

  function keydown(e: KeyboardEvent) {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step && results.length) {
      e.preventDefault();
      index = (index + step + results.length) % results.length;
      dialog.querySelector(`#result-${index}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && results[index]) {
      e.preventDefault();
      choose(results[index].id);
    }
  }
</script>

<dialog bind:this={dialog} aria-label="Search nodes">
  <input bind:this={input} bind:value={query} oninput={search} onkeydown={keydown} role="combobox" aria-expanded="true"
    aria-controls="results" aria-activedescendant={results.length ? `result-${index}` : undefined} aria-label="Search nodes"
    placeholder="Name, type, category, status or file" autocomplete="off" />
  <ul id="results" role="listbox">
    {#each results as n, i (n.id)}
      <li role="option" id="result-{i}" aria-selected={i === index}>
        <button tabindex="-1" class:active={i === index} onclick={() => choose(n.id)} onpointermove={() => (index = i)}>
          <b>{n.label}</b><code>{n.kind}</code>
          <small>{n.state && n.state !== "ok" ? n.state : ""} {n.sourceFile ?? ""}</small>
        </button>
      </li>
    {:else}
      <li class="none">No matching nodes</li>
    {/each}
  </ul>
</dialog>

<style>
  dialog { width: min(560px, calc(100% - 32px)); padding: 10px; margin-top: 12vh; }
  input { width: 100% !important; }
  ul { list-style: none; margin: 8px 0 0; padding: 0; max-height: 50vh; overflow: auto; }
  li button { width: 100%; display: flex; gap: 10px; align-items: baseline; border: none; text-align: left; }
  li button.active { background: color-mix(in srgb, var(--accent) 18%, transparent); }
  small { margin-left: auto; color: var(--muted); font-family: var(--mono); }
  .none { padding: 8px; color: var(--muted); }
</style>
