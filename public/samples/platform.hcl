# A fictional global retail platform: Cloudflare at the edge, two AWS regions on EKS,
# an event backbone on MSK, analytics on GCP and a ring of SaaS providers.
title = "Nimbus Retail · global platform"

node "shoppers" { kind = "customers"  label = "Shoppers" }
node "mobile" { kind = "client.mobile"  label = "Mobile apps" }
node "partners" { kind = "partner"  label = "Partner integrations" }

group "edge" { label = "Cloudflare edge"
  node "cdn" { kind = "cloudflare"  label = "CDN + WAF"  calls = ["edge-worker"] }
  node "edge-worker" { kind = "cloudflare-workers"  label = "edge router" }
}

group "use1" { label = "AWS us-east-1 (primary)"  kind = "aws"
  node "dns" { kind = "aws.route53"  label = "Route 53" }
  node "partner-api" { kind = "aws.api-gateway"  label = "partner API" }
  node "kms" { kind = "aws.kms"  label = "KMS" }
  node "assets" { kind = "aws.s3"  label = "media assets" }
  node "lake" { kind = "aws.s3"  label = "data lake" }

  group "use1-vpc" { label = "VPC 10.10.0.0/16"  kind = "aws.vpc"
    node "use1-alb" { kind = "aws.alb"  label = "ALB" }

    group "use1-eks" { label = "EKS shop-prod"  kind = "aws.eks"
      node "use1-ingress" { kind = "k8s.ingress"  label = "envoy gateway" }
      node "use1-nodepool" { kind = "aws.autoscaling-group"  label = "EKS worker pool"  instances = 6  instance_type = "m6i.large"  autoscaling_group = "shop-prod-workers"  min_size = 3  max_size = 12  calls = ["web"] }

      group "use1-web" { label = "namespace: storefront"  kind = "k8s.namespace"
        node "web" { kind = "k8s.deployment"  label = "web (SSR)"  replicas = 12 }
        node "bff" { kind = "k8s.deployment"  label = "mobile BFF"  replicas = 6 }
      }

      group "use1-commerce" { label = "namespace: commerce"  kind = "k8s.namespace"
        node "catalog" { kind = "k8s.deployment"  label = "catalog"  replicas = 8 }
        node "search" { kind = "k8s.deployment"  label = "search"  replicas = 6 }
        node "cart" { kind = "k8s.deployment"  label = "cart"  replicas = 8 }
        node "checkout" { kind = "k8s.deployment"  label = "checkout"  replicas = 6 }
        node "payments" { kind = "k8s.deployment"  label = "payments"  replicas = 4 }
        node "orders" { kind = "k8s.deployment"  label = "orders"  replicas = 6 }
        node "inventory" { kind = "k8s.deployment"  label = "inventory"  replicas = 4 }
        node "pricing" { kind = "k8s.deployment"  label = "pricing"  replicas = 4 }
        node "recs" { kind = "k8s.deployment"  label = "recommendations"  replicas = 3 }
      }

      group "use1-ops" { label = "namespace: observability"  kind = "k8s.namespace"
        node "otel" { kind = "k8s.daemonset"  label = "otel collector" }
        node "prometheus" { kind = "k8s.statefulset"  label = "Prometheus" }
        node "grafana" { kind = "helm.release"  label = "Grafana" }
      }
    }

    group "use1-data" { label = "private subnets"
      node "orders-db" { kind = "aws.aurora"  label = "orders (Aurora PG)"  engine = "postgres 17" }
      node "catalog-db" { kind = "aws.rds"  label = "catalog db"  engine = "postgres 17" }
      node "carts" { kind = "aws.dynamodb"  label = "carts (global table)" }
      node "sessions" { kind = "aws.elasticache"  label = "sessions (Redis)" }
      node "search-index" { kind = "aws.opensearch"  label = "product index" }
      node "kafka" { kind = "aws.msk"  label = "event backbone (MSK)" }
    }
  }

  group "use1-async" { label = "fulfilment (serverless)"
    node "fulfil-queue" { kind = "aws.sqs"  label = "fulfilment queue" }
    node "fulfil-flow" { kind = "aws.step-functions"  label = "fulfilment flow" }
    node "label-fn" { kind = "aws.lambda"  label = "shipping labels" }
    node "notify-fn" { kind = "aws.lambda"  label = "notifications" }
    node "email" { kind = "aws.ses"  label = "SES" }
  }
}

group "euw1" { label = "AWS eu-west-1 (active)"  kind = "aws"
  group "euw1-vpc" { label = "VPC 10.20.0.0/16"  kind = "aws.vpc"
    node "euw1-alb" { kind = "aws.alb"  label = "ALB" }
    group "euw1-eks" { label = "EKS shop-eu"  kind = "aws.eks"
      node "euw1-web" { kind = "k8s.deployment"  label = "web (SSR)"  replicas = 8 }
      node "euw1-catalog" { kind = "k8s.deployment"  label = "catalog"  replicas = 4 }
      node "euw1-cart" { kind = "k8s.deployment"  label = "cart"  replicas = 4 }
    }
    node "euw1-replica" { kind = "aws.aurora"  label = "orders replica" }
    node "euw1-cache" { kind = "aws.elasticache"  label = "sessions (Redis)" }
  }
}

group "gcp" { label = "GCP analytics"  kind = "gcp"
  node "ingest" { kind = "gcp.pubsub"  label = "event ingest" }
  node "stream" { kind = "gcp.run"  label = "stream enrich" }
  node "warehouse" { kind = "gcp.bigquery"  label = "warehouse" }
  node "features" { kind = "gcp.vertex"  label = "feature store + models" }
}

group "saas" { label = "SaaS providers"
  node "stripe" { kind = "saas.stripe"  label = "Stripe" }
  node "auth0" { kind = "saas.auth0"  label = "Auth0" }
  node "twilio" { kind = "saas.twilio"  label = "Twilio SMS" }
  node "carrier" { kind = "saas.carrier"  label = "carrier APIs" }
  node "datadog" { kind = "saas.datadog"  label = "Datadog" }
  node "sentry" { kind = "saas.sentry"  label = "Sentry" }
  node "openai" { kind = "saas.openai"  label = "OpenAI" }
  node "slack" { kind = "saas.slack"  label = "Slack" }
}

# Edge and entry
edge "shoppers" "cdn" { protocol = "https"  rps = 4200 }
edge "mobile" "cdn" { protocol = "https"  rps = 1800 }
edge "partners" "partner-api" { protocol = "https"  rps = 120 }
edge "edge-worker" "dns" { protocol = "https"  rps = 2600 }
edge "edge-worker" "euw1-alb" { protocol = "https"  rps = 1400 }
edge "cdn" "assets" { protocol = "https"  rps = 900 }
edge "dns" "use1-alb" { protocol = "https"  rps = 2600 }
edge "use1-alb" "use1-ingress" { protocol = "http"  rps = 2600 }
edge "partner-api" "orders" { protocol = "https"  rps = 120 }
edge "use1-ingress" "web" { protocol = "http"  rps = 1700 }
edge "use1-ingress" "bff" { protocol = "grpc"  rps = 900 }

# Storefront to commerce
edge "web" "auth0" { protocol = "oidc"  rps = 60  latency_ms = 180 }
edge "web" "catalog" { protocol = "grpc"  rps = 1200 }
edge "web" "search" { protocol = "grpc"  rps = 700 }
edge "web" "cart" { protocol = "grpc"  rps = 400 }
edge "web" "recs" { protocol = "grpc"  rps = 300 }
edge "web" "sessions" { protocol = "redis"  rps = 1700 }
edge "bff" "catalog" { protocol = "grpc"  rps = 500 }
edge "bff" "cart" { protocol = "grpc"  rps = 250 }
edge "bff" "checkout" { protocol = "grpc"  rps = 60 }
edge "cart" "carts" { protocol = "dynamodb"  rps = 650 }
edge "cart" "pricing" { protocol = "grpc"  rps = 650 }
edge "checkout" "cart" { protocol = "grpc"  rps = 90 }
edge "checkout" "payments" { protocol = "grpc"  rps = 90 }
edge "checkout" "inventory" { protocol = "grpc"  rps = 90 }
edge "checkout" "orders" { protocol = "grpc"  rps = 90 }
edge "payments" "stripe" { protocol = "https"  rps = 90  latency_ms = 420 }
edge "payments" "kms" { protocol = "https"  rps = 90 }
edge "catalog" "catalog-db" { protocol = "postgres"  rps = 1400 }
edge "search" "search-index" { protocol = "https"  rps = 700 }
edge "orders" "orders-db" { protocol = "postgres"  rps = 300 }
edge "recs" "features" { protocol = "grpc"  rps = 300  speed = "slow" }
edge "recs" "openai" { protocol = "https"  rps = 20  latency_ms = 900 }

# Events
edge "orders" "kafka" { protocol = "kafka"  rps = 300 }
edge "inventory" "kafka" { protocol = "kafka"  rps = 200 }
edge "catalog" "kafka" { protocol = "kafka"  rps = 80 }
edge "kafka" "search" { protocol = "kafka"  rps = 80 }
edge "kafka" "fulfil-queue" { protocol = "kafka"  rps = 90 }
edge "kafka" "lake" { protocol = "s3"  rps = 600 }
edge "kafka" "ingest" { protocol = "https"  rps = 600 }
edge "fulfil-queue" "fulfil-flow" { protocol = "sqs"  rps = 90 }
edge "fulfil-flow" "label-fn" { protocol = "invoke"  rps = 90 }
edge "fulfil-flow" "notify-fn" { protocol = "invoke"  rps = 180 }
edge "label-fn" "carrier" { protocol = "https"  rps = 90  latency_ms = 650 }
edge "notify-fn" "email" { protocol = "smtp"  rps = 120 }
edge "notify-fn" "twilio" { protocol = "https"  rps = 60 }

# Analytics
edge "ingest" "stream" { protocol = "pubsub"  rps = 600 }
edge "stream" "warehouse" { protocol = "bigquery"  rps = 600 }
edge "warehouse" "features" { protocol = "bigquery"  rps = 40 }

# Second region
edge "euw1-alb" "euw1-web" { protocol = "http"  rps = 1400 }
edge "euw1-web" "euw1-catalog" { protocol = "grpc"  rps = 900 }
edge "euw1-web" "euw1-cart" { protocol = "grpc"  rps = 300 }
edge "euw1-web" "euw1-cache" { protocol = "redis"  rps = 1400 }
edge "euw1-cart" "carts" { protocol = "dynamodb"  rps = 300 }
edge "euw1-cart" "checkout" { protocol = "grpc"  rps = 40 }
edge "orders-db" "euw1-replica" { protocol = "replication"  rps = 300 }

# Observability
edge "otel" "datadog" { protocol = "otlp"  rps = 2000 }
edge "otel" "prometheus" { protocol = "remote-write"  rps = 1500  speed = "fast" }
edge "grafana" "prometheus" { protocol = "promql"  rps = 20 }
edge "web" "sentry" { protocol = "https"  rps = 5 }
edge "datadog" "slack" { protocol = "webhook"  rps = 1 }
