<script lang="ts">
  import { encodeInfra } from "../lib/share.ts";
  import { sharePayload, URL_LIMIT, writeSnapshot, type Camera } from "../lib/snapshot.ts";
  import { redact, summarize } from "../security/secretScrubber.ts";
  import type { Infra } from "../lib/model.ts";
  import type { SourceFile } from "../parsers/index.ts";
  import { download } from "../export/download.ts";

  let { camera }: { camera: () => Camera } = $props();

  let dialog: HTMLDialogElement;
  // What is shared is fixed when the dialog opens, so a running simulation does not rewrite the link under the user.
  let content = $state.raw<{ infra: Infra; sources: SourceFile[] } | null>(null);
  let hide = $state(true);
  let layoutOnly = $state(false);
  let link = $state("");
  let done = $state("");

  export function open(infra: Infra, sources: SourceFile[]) {
    content = { infra: $state.snapshot(infra), sources };
    hide = true;
    layoutOnly = false;
    done = "";
    dialog.showModal();
  }

  let outgoing = $derived(content && sharePayload(content.infra, content.sources, { redact: hide, layoutOnly }));

  async function build(text: string, redacting: boolean): Promise<string> {
    const url = new URL(location.href);
    url.searchParams.delete("src");
    url.searchParams.delete("sample");
    url.searchParams.delete("infra");
    // A stream address can carry its own credentials.
    const stream = url.searchParams.get("stream") ?? url.searchParams.get("events");
    if (redacting && stream && (redact(stream).findings.length || /[?&](token|key|auth|sig)[^=&]*=/i.test(stream)))
      url.searchParams.delete("stream"), url.searchParams.delete("events");
    url.hash = `infra=${await encodeInfra(text)}`;
    return url.href;
  }

  $effect(() => {
    const text = outgoing?.text;
    const redacting = hide;
    link = "";
    if (text === undefined) return;
    let stale = false;
    build(text, redacting).then((href) => stale || (link = href));
    return () => (stale = true);
  });

  async function copy() {
    if (!link) return;
    history.replaceState(null, "", link);
    try {
      await navigator.clipboard.writeText(link);
      done = "Link copied";
    } catch {
      done = "Link is in the address bar";
    }
  }

  async function compactLink() {
    layoutOnly = true;
    link = await build(sharePayload(content!.infra, content!.sources, { redact: hide, layoutOnly: true }).text, hide);
    await copy();
  }

  function snapshot() {
    const file = writeSnapshot(content!.infra, content!.sources, camera(), hide);
    download(new Blob([file.text], { type: "application/json" }), "topology.topolore.json");
    done = "Snapshot downloaded";
  }
</script>

<dialog bind:this={dialog} aria-label="Share">
  <h2>Share</h2>
  <p>The link carries the infrastructure itself, in the part of the address that is never sent to a server.</p>
  {#if outgoing}
    {#if outgoing.findings.length}
      <div class="secrets" role="alert">
        <b>Found {outgoing.findings.length} potential secret{outgoing.findings.length > 1 ? "s" : ""}: {summarize(outgoing.findings)}</b>
        {#if !hide}<span>They will be readable by anyone who has the link or the file.</span>{/if}
      </div>
    {:else}
      <p>No secrets were detected. Detection works by patterns, so check anything sensitive yourself.</p>
    {/if}
    <label><input type="checkbox" bind:checked={hide} /> Redact secrets (<code>***REDACTED***</code>) in the shared URL and file</label>
    <label><input type="checkbox" bind:checked={layoutOnly} /> Strip raw source from the URL (layout and metadata only)</label>
    <div class="meter">
      <meter min="0" max={URL_LIMIT} high={URL_LIMIT * 0.8} value={Math.min(link.length, URL_LIMIT)}></meter>
      <span>{link ? `${link.length.toLocaleString()} / ${URL_LIMIT.toLocaleString()} chars` : "Measuring…"}{link && link.length <= URL_LIMIT ? " — safe for Slack and browsers" : ""}</span>
    </div>
    {#if link.length > URL_LIMIT}
      <p class="large"><b>Large topology:</b> the URL may be truncated by Slack, X or older browsers.</p>
      <div class="offers">
        <button onclick={compactLink} disabled={layoutOnly}>Share compact URL (layout and metadata only)</button>
        <button onclick={snapshot}>Download .topolore.json</button>
      </div>
    {/if}
  {/if}
  <div class="actions">
    <span role="status">{done}</span>
    <button onclick={() => dialog.close()}>Close</button>
    <button onclick={snapshot} title="A file with the sources, topology and camera; drop it on Topolore to open it">Download .topolore.json</button>
    <button class="on" onclick={copy} disabled={!link}>Copy link</button>
  </div>
</dialog>

<style>
  dialog[open] { display: grid; gap: 10px; width: min(620px, calc(100% - 32px)); }
  label { font-size: 13px; }
  .secrets { display: grid; gap: 4px; padding: 8px 10px; border: 1px solid var(--warn); border-radius: 6px; font-size: 13px; }
  .meter { display: flex; align-items: center; gap: 10px; font: 12px var(--mono); color: var(--muted); }
  meter { width: 160px; }
  p.large { color: var(--warn); }
  .offers { display: flex; flex-wrap: wrap; gap: 6px; }
  .actions { flex-wrap: wrap; align-items: center; }
  .actions span { margin-right: auto; font-size: 12px; color: var(--ok); }
</style>
