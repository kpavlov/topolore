/** Kubernetes manifests: selectors, Ingress backends and volume or env references become links. */
import { edgeId, normalize, type Edge, type Group, type Infra, type InfraNode } from "../lib/model.ts";
import { readYaml, type Obj } from "./yaml.ts";
import type { SourceFile } from "./index.ts";

const KIND: Record<string, string> = {
  Deployment: "k8s.deployment", StatefulSet: "k8s.statefulset", DaemonSet: "k8s.daemonset", Service: "k8s.service",
  Ingress: "k8s.ingress", ConfigMap: "k8s.configmap", Secret: "k8s.secret", PersistentVolumeClaim: "k8s.pvc",
};
const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

const id = (namespace: string, kind: string, name: string) => `${namespace}/${kind.toLowerCase()}/${name}`;

function propsOf(o: Obj): Obj {
  const spec = o.spec ?? {};
  const props: Obj = {};
  if (WORKLOADS.has(o.kind)) {
    if (spec.replicas !== undefined) props.replicas = spec.replicas;
    props.images = (spec.template?.spec?.containers ?? []).map((c: Obj) => c.image);
    props.labels = spec.template?.metadata?.labels;
  } else if (o.kind === "Service") {
    props.type = spec.type ?? "ClusterIP";
    props.ports = (spec.ports ?? []).map((p: Obj) => `${p.port}→${p.targetPort ?? p.port}`);
    props.selector = spec.selector;
  } else if (o.kind === "Ingress") props.hosts = (spec.rules ?? []).map((r: Obj) => r.host ?? "*");
  else if (o.kind === "PersistentVolumeClaim") {
    props.storage = spec.resources?.requests?.storage;
    props.storageClass = spec.storageClassName;
  } else {
    // ConfigMap and Secret: key names only, never what is in them.
    props.keys = Object.keys({ ...o.data, ...o.stringData, ...o.binaryData });
    if (o.type) props.type = o.type;
  }
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
}

/** `[kind, name]` of what a pod takes from the cluster. */
function podReferences(pod: Obj): [string, string | undefined][] {
  const volumes = (pod.volumes ?? []).flatMap((v: Obj) => [v, ...(v.projected?.sources ?? [])]);
  const containers: Obj[] = [...(pod.initContainers ?? []), ...(pod.containers ?? [])];
  return [
    ...volumes.flatMap((v: Obj): [string, string | undefined][] => [
      ["ConfigMap", v.configMap?.name],
      ["Secret", v.secret?.secretName ?? v.secret?.name],
      ["PersistentVolumeClaim", v.persistentVolumeClaim?.claimName],
    ]),
    ...containers.flatMap((c): [string, string | undefined][] => [
      ...(c.envFrom ?? []).flatMap((e: Obj): [string, string | undefined][] => [["ConfigMap", e.configMapRef?.name], ["Secret", e.secretRef?.name]]),
      ...(c.env ?? []).flatMap((e: Obj): [string, string | undefined][] => [
        ["ConfigMap", e.valueFrom?.configMapKeyRef?.name],
        ["Secret", e.valueFrom?.secretKeyRef?.name],
      ]),
    ]),
  ];
}

export function parseKubernetes(files: SourceFile[]): { infra: Infra; warnings: string[] } {
  const objects = new Map<string, { o: Obj; namespace: string; at: Partial<InfraNode> }>();
  const warnings: string[] = [];
  let namespaced = false;
  for (const file of files)
    for (const doc of readYaml(file.text)) {
      if (!doc.value) continue;
      const items: Obj[] = Array.isArray(doc.value.items) ? doc.value.items : [doc.value];
      for (const o of items) {
        const name = o?.metadata?.name;
        if (!KIND[o?.kind] || typeof name !== "string") continue;
        const namespace = String(o.metadata.namespace ?? "default");
        namespaced ||= !!o.metadata.namespace;
        const key = id(namespace, o.kind, name);
        if (objects.has(key)) warnings.push(`${file.path || "input"}: ${key} is declared twice; the first one is shown.`);
        else objects.set(key, { o, namespace, at: { sourceFile: file.path || undefined, ...(items.length === 1 ? doc.lines([]) : {}) } });
      }
    }
  if (!objects.size) throw new Error("No Kubernetes workloads, services or their config were found.");

  const groups = new Map<string, Group>();
  const nodes: InfraNode[] = [];
  for (const [key, { o, namespace, at }] of objects) {
    const parent = namespaced ? `namespace:${namespace}` : undefined;
    if (parent) groups.set(parent, { id: parent, label: namespace, kind: "k8s.namespace" });
    nodes.push({ id: key, label: o.metadata.name, kind: KIND[o.kind], parent, props: propsOf(o), ...at });
  }

  const edges = new Map<string, Edge>();
  const link = (from: string, to: string, label?: string) => {
    if (objects.has(to)) edges.set(edgeId(from, to), { id: edgeId(from, to), from, to, label });
  };
  for (const [key, { o, namespace }] of objects) {
    if (o.kind === "Service") {
      const selector = Object.entries((o.spec?.selector ?? {}) as Obj);
      if (!selector.length) continue;
      for (const [other, target] of objects) {
        if (!WORKLOADS.has(target.o.kind) || target.namespace !== namespace) continue;
        const labels = target.o.spec?.template?.metadata?.labels ?? {};
        if (selector.every(([k, v]) => labels[k] === v)) link(key, other);
      }
    } else if (o.kind === "Ingress") {
      // `service.name` in networking.k8s.io/v1, `serviceName` before it.
      const backend = (b: Obj | undefined, label?: string) => {
        const service = b?.service?.name ?? b?.serviceName;
        if (service) link(key, id(namespace, "Service", service), label);
      };
      backend(o.spec?.defaultBackend ?? o.spec?.backend);
      for (const rule of o.spec?.rules ?? [])
        for (const path of rule.http?.paths ?? []) backend(path.backend, `${rule.host ?? ""}${path.path ?? ""}` || undefined);
    } else if (WORKLOADS.has(o.kind))
      for (const [kind, name] of podReferences(o.spec?.template?.spec ?? {})) if (name) link(key, id(namespace, kind, name));
  }

  return { infra: normalize({ groups: [...groups.values()], nodes, edges: [...edges.values()] }), warnings };
}
