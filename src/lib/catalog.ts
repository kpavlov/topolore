import icons from "./icons.json" with { type: "json" };

export type Shape = "box" | "cylinder" | "hex" | "sphere" | "slab" | "queue";
export type Category = "compute" | "data" | "network" | "messaging" | "security" | "external" | "edge";

export interface Look {
  icon?: string;
  badge?: string;
  shape: Shape;
  category: Category;
  provider: string;
}

const ICONS = icons as Record<string, { body: string; width: number; height: number }>;

const EXTERNAL_ICONS: Record<string, string> = {
  people: '<circle cx="12" cy="8" r="3"/><path d="M5 19v-1a7 7 0 0 1 14 0v1M4 10a2.5 2.5 0 0 0 0 5M20 10a2.5 2.5 0 0 1 0 5"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/>',
  mobile: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 5h4M11 19h2"/>',
  browser: '<rect x="2" y="4" width="20" height="15" rx="2"/><path d="M2 8h20M5 6h.01M8 6h.01M9 22h6M12 19v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9z"/>',
  integration: '<path d="M9 8 7 6a3 3 0 0 0-4 4l4 4a3 3 0 0 0 4 0l1-1M15 16l2 2a3 3 0 0 0 4-4l-4-4a3 3 0 0 0-4 0l-1 1M8 16l8-8"/>',
};

const EXTERNAL_KIND: Record<string, string> = {
  user: "person", person: "person", users: "people", people: "people", customer: "people", customers: "people", shopper: "people", shoppers: "people",
  mobile: "mobile", phone: "mobile", device: "mobile", browser: "browser", client: "browser",
  internet: "globe", external: "globe", partner: "integration", partners: "integration", integration: "integration", "api-client": "integration",
};

/** Services by what they are: decides the 3D shape and the tint. */
const CATEGORY: [RegExp, Category, Shape][] = [
  [/rds|aurora|sql|postgres|mysql|mongo|cosmos|dynamo|documentdb|keyspaces|neptune|redshift|bigquery|spanner|firestore|cassandra|clickhouse|snowflake|timestream|elasticsearch|open-search|database|db$/, "data", "cylinder"],
  [/s3|gcs|storage|glacier|blob|bucket|backup|efs|ebs|pvc|volume/, "data", "slab"],
  [/redis|elasticache|elastic-cache|memcache|cache/, "data", "cylinder"],
  [/sqs|sns|kafka|msk|pubsub|eventbridge|kinesis|rabbit|nats|mq|servicebus|eventhub|queue|topic|step-functions/, "messaging", "queue"],
  [/elb|alb|nlb|lb$|load-?balancer|ingress|gateway|api-gateway|cloudfront|cdn|route53|dns|front-?door|waf|shield|nginx|traefik|envoy|istio|cloudflare|vpc-endpoint|^vpc$|subnet|nat-gateway|internet-gateway|route-table/, "network", "hex"],
  [/iam|kms|secret|vault|cognito|certificate|identity|zitadel|auth0|okta|security-group|firewall/, "security", "slab"],
  [/internet|user|client|browser|mobile/, "edge", "sphere"],
];

/** Short service names for providers whose catalogue has only a brand logo. */
const BADGE: Record<string, string> = {
  deployment: "deploy", statefulset: "sts", daemonset: "ds", service: "svc", ingress: "ing", pod: "pod", job: "job",
  cronjob: "cron", configmap: "cm", secret: "secret", pvc: "pvc", hpa: "hpa", namespace: "ns", node: "node",
  gke: "GKE", sql: "SQL", cloudsql: "SQL", pubsub: "Pub/Sub", gcs: "GCS", bigquery: "BQ", spanner: "Spanner",
  memorystore: "Redis", firestore: "Fire", vertex: "Vertex", lb: "LB", "load-balancer": "LB", cdn: "CDN",
  aks: "AKS", cosmos: "Cosmos", storage: "Blob", functions: "Func", "app-service": "App", servicebus: "Bus",
  eventhub: "Events", postgres: "PG", "front-door": "Door", keyvault: "Vault", apim: "APIM", vm: "VM",
};

const PROVIDER_LOGO: Record<string, string> = {
  aws: "aws", gcp: "google-cloud", azure: "azure-icon", k8s: "kubernetes", kubernetes: "kubernetes",
  cloudflare: "cloudflare-icon", vercel: "vercel-icon", netlify: "netlify-icon", do: "digital-ocean-icon",
  oracle: "oracle", fly: "fly-icon", heroku: "heroku-icon",
};

/** `aws.rds`, `gcp.sql`, `k8s.deployment`, `db.postgresql`, `saas.stripe`, `internet` … */
export function lookOf(kind: string): Look {
  const [provider, ...rest] = kind.toLowerCase().split(".");
  const service = rest.join(".") || provider;
  const external = (!rest.length || ["client", "external", "user", "customer", "device"].includes(provider)) && EXTERNAL_KIND[service];
  if (external) return { shape: /^(customers?|shoppers?)$/.test(service) || external === "mobile" ? "slab" : "sphere", category: "edge", provider, icon: `external-${external}` };
  const [, category, shape] = CATEGORY.find(([re]) => re.test(service)) ??
    (provider === "saas" ? [, "external", "box"] : [, "compute", "box"]);
  const look: Look = { shape, category, provider };

  const own = [`${provider}-${service}`, service, `${service}-icon`, service.replace(/sql$/, "") + "sql"].find((name) => ICONS[name]);
  if (provider === "aws") look.icon = ICONS[`aws-${service}`] ? `aws-${service}` : ALIASES[service] ?? "aws";
  else if (provider === "gcp") look.icon = ICONS[`google-cloud-${service}`] ? `google-cloud-${service}` : "google-cloud";
  else if (provider === "helm") look.icon = "helm";
  else if (own && provider !== "k8s") look.icon = own;
  else look.icon = PROVIDER_LOGO[provider];
  if (look.icon === PROVIDER_LOGO[provider] || look.icon === "aws") look.badge = BADGE[service] ?? (service === provider ? undefined : service.slice(0, 6));
  if (!look.icon && shape !== "sphere") look.badge = service.slice(0, 6);
  return look;
}

const ALIASES: Record<string, string> = {
  alb: "aws-elb", nlb: "aws-elb", lb: "aws-elb", elasticache: "aws-elasticache", redis: "aws-elasticache",
  "api-gateway": "aws-api-gateway", apigateway: "aws-api-gateway", secrets: "aws-secrets-manager",
  opensearch: "aws-open-search", logs: "aws-cloudwatch", stepfunctions: "aws-step-functions",
};

export function iconSvg(name: string): string | undefined {
  const external = EXTERNAL_ICONS[name.replace(/^external-/, "")];
  if (name.startsWith("external-") && external)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 24 24" fill="none" stroke="#334155" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${external}</svg>`;
  const icon = ICONS[name];
  return icon && `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 ${icon.width} ${icon.height}">${icon.body}</svg>`;
}

export function iconDataUrl(name: string | undefined): string | undefined {
  const svg = name && iconSvg(name);
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : undefined;
}

const TERRAFORM: [RegExp, string][] = [
  [/^aws_db_instance$/, "aws.rds"], [/^aws_rds_cluster/, "aws.aurora"], [/^aws_lambda_function$/, "aws.lambda"],
  [/^aws_s3_bucket$/, "aws.s3"], [/^aws_instance$/, "aws.ec2"], [/^aws_(a|e)?lb$/, "aws.elb"],
  [/^aws_sqs_queue$/, "aws.sqs"], [/^aws_sns_topic$/, "aws.sns"], [/^aws_dynamodb_table$/, "aws.dynamodb"],
  [/^aws_eks_cluster$/, "aws.eks"], [/^aws_ecs_service$/, "aws.ecs"], [/^aws_elasticache_/, "aws.elasticache"],
  [/^aws_api_?gateway/, "aws.api-gateway"], [/^aws_cloudfront_distribution$/, "aws.cloudfront"],
  [/^aws_iam_role$/, "aws.iam"], [/^aws_kms_key$/, "aws.kms"], [/^aws_secretsmanager_secret$/, "aws.secrets-manager"],
  [/^aws_route53_/, "aws.route53"], [/^aws_cloudwatch_/, "aws.cloudwatch"], [/^aws_msk_/, "aws.msk"],
  [/^aws_kinesis_/, "aws.kinesis"], [/^aws_cognito_/, "aws.cognito"], [/^aws_sfn_/, "aws.step-functions"],
  [/^google_cloud_?run/, "gcp.run"], [/^google_sql_/, "gcp.sql"], [/^google_container_cluster$/, "gcp.gke"],
  [/^google_pubsub_/, "gcp.pubsub"], [/^google_storage_bucket$/, "gcp.gcs"], [/^google_bigquery_/, "gcp.bigquery"],
  [/^google_cloudfunctions/, "gcp.functions"], [/^google_redis_/, "gcp.memorystore"], [/^google_compute_instance$/, "gcp.vm"],
  [/^azurerm_kubernetes_cluster$/, "azure.aks"], [/^azurerm_cosmosdb_/, "azure.cosmos"], [/^azurerm_storage_/, "azure.storage"],
  [/^azurerm_.*function_app$/, "azure.functions"], [/^azurerm_postgresql_/, "azure.postgres"], [/^azurerm_servicebus_/, "azure.servicebus"],
  [/^azurerm_.*(web_app|app_service)/, "azure.app-service"], [/^azurerm_.*virtual_machine$/, "azure.vm"], [/^azurerm_key_vault/, "azure.keyvault"],
  [/^kubernetes_(deployment|stateful_set|daemon_set|service|ingress|cron_job|job|config_map|secret|namespace)(_v\d)?$/, "k8s.$1"],
  [/^helm_release$/, "helm.release"],
];

/** Maps a Terraform resource type to a kind; unknown types keep their provider. */
export function terraformKind(type: string): string {
  for (const [re, kind] of TERRAFORM) {
    const match = re.exec(type);
    if (match) return kind.replace("$1", (match[1] ?? "").replace(/_/g, ""));
  }
  const [provider, ...rest] = type.split("_");
  const prefix = { google: "gcp", azurerm: "azure", kubernetes: "k8s" }[provider] ?? provider;
  return `${prefix}.${rest.join("-")}`;
}
