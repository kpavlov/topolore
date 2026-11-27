// Copies the logos this viewer uses out of @iconify-json/logos (CC0/MIT per icon) into src/lib/icons.json,
// so the app bundles ~150 icons instead of all 2,300.
import { readFileSync, writeFileSync } from "node:fs";

const { icons, width = 256, height = 256 } = JSON.parse(readFileSync("node_modules/@iconify-json/logos/icons.json", "utf8"));
const wanted = Object.keys(icons).filter((name) =>
  /^(aws(-.*)?|google-cloud.*|microsoft-azure|azure-icon|kubernetes|helm|docker-icon|argo-icon|envoy-icon|istio|prometheus|grafana|nginx|traefik-proxy-icon|postgresql|mysql-icon|redis|kafka-icon|rabbitmq-icon|mongodb-icon|elasticsearch|clickhouse-icon|cassandra|memcached|nats-icon|snowflake-icon|cloudflare-icon|cloudflare-workers-icon|vercel-icon|netlify-icon|digital-ocean-icon|oracle|fly-icon|heroku-icon|github-icon|gitlab-icon|slack-icon|stripe|sentry-icon|datadog-icon|terraform-icon|pulumi-icon|vault-icon|consul|openai-icon|anthropic-icon|claude-icon)$/.test(name),
);
const out = {};
for (const name of wanted) {
  const icon = icons[name];
  out[name] = { body: icon.body, width: icon.width ?? width, height: icon.height ?? height };
}
writeFileSync("src/lib/icons.json", JSON.stringify(out));
console.log(`${wanted.length} icons -> src/lib/icons.json`);
