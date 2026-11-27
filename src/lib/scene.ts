import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { iconDataUrl, lookOf, type Look } from "./catalog.ts";
import type { Layout } from "./layout.ts";
import { flowSpeed, type Edge, type Group, type Infra, type InfraNode } from "./model.ts";

export type View = "iso" | "top" | "3d";
export type Pick = { type: "node" | "edge" | "group"; id: string } | null;

const LEVEL = 12; // height between stacked plates
const PLATE = 3;
const SPEED = { slow: 14, medium: 45, fast: 120 }; // world units per second along a pipe

interface Palette {
  bg: string; ink: string; muted: string; line: string; accent: string; flow: string; flowHeavy: string;
  category: Record<Look["category"], string>;
  ok: string; warn: string; crit: string; fire: string; idle: string; plates: string[];
}

interface NodeView {
  node: InfraNode;
  look: Look;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  decal?: THREE.Object3D;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  label: CSS2DObject;
  top: THREE.Vector3;
  base: THREE.Vector3;
  baseColor: THREE.Color;
  flames: THREE.Sprite[];
}

interface EdgeView {
  edge: Edge;
  curve: THREE.QuadraticBezierCurve3;
  length: number;
  tube: THREE.Mesh<THREE.TubeGeometry, THREE.MeshStandardMaterial>;
  hit: THREE.Mesh;
  arrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshStandardMaterial>;
  marker: CSS2DObject;
}

const readPalette = (): Palette => {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim() || "#888";
  return {
    bg: v("--scene"), ink: v("--ink"), muted: v("--muted"), line: v("--line"), accent: v("--accent"), flow: v("--flow"),
    flowHeavy: v("--flow-heavy"),
    category: {
      compute: v("--cat-compute"), data: v("--cat-data"), network: v("--cat-network"), messaging: v("--cat-messaging"),
      security: v("--cat-security"), external: v("--cat-external"), edge: v("--cat-edge"),
    },
    ok: v("--ok"), warn: v("--warn"), crit: v("--crit"), fire: v("--fire"), idle: v("--idle"),
    plates: [v("--plate-0"), v("--plate-1"), v("--plate-2"), v("--plate-3")],
  };
};

const SHAPES: Record<Look["shape"], () => { geometry: THREE.BufferGeometry; height: number }> = {
  box: () => ({ geometry: new THREE.BoxGeometry(34, 24, 34), height: 24 }),
  cylinder: () => ({ geometry: new THREE.CylinderGeometry(18, 18, 26, 40), height: 26 }),
  hex: () => ({ geometry: new THREE.CylinderGeometry(21, 21, 14, 6), height: 14 }),
  sphere: () => ({ geometry: new THREE.SphereGeometry(16, 32, 20), height: 32 }),
  slab: () => ({ geometry: new THREE.BoxGeometry(38, 8, 32), height: 8 }),
  queue: () => ({ geometry: new THREE.BoxGeometry(44, 12, 24), height: 12 }),
};

const textureCache = new Map<string, THREE.CanvasTexture>();

/** Logo plus a short service badge, drawn once per kind. */
function decalTexture(look: Look, ink: string): THREE.CanvasTexture {
  const key = `${look.icon}|${look.badge}|${ink}`;
  const cached = textureCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const drawBadge = (big: boolean) => {
    if (!look.badge) return;
    ctx.font = `700 ${big ? 64 : 50}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = Math.min(240, ctx.measureText(look.badge).width + 30);
    const y = big ? 128 : 214;
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.roundRect(128 - w / 2, y - 34, w, 68, 14);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(look.badge, 128, y + 2, 220);
    texture.needsUpdate = true;
  };
  const url = iconDataUrl(look.icon);
  if (url || look.badge) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(8, 8, 240, 240, 40);
    ctx.fill();
  }
  if (url) {
    const img = new Image();
    img.onload = () => {
      const size = look.badge ? 150 : 196;
      ctx.drawImage(img, 128 - size / 2, look.badge ? 14 : 30, size, size);
      drawBadge(false);
      texture.needsUpdate = true;
    };
    img.src = url;
  } else drawBadge(true);
  textureCache.set(key, texture);
  return texture;
}

/** Light bands on a pipe; scrolled along it so the colour seems to flow (SimCity water pipes). */
let bandImage: HTMLCanvasElement | undefined;
const bands = () => {
  if (!bandImage) {
    bandImage = document.createElement("canvas");
    bandImage.width = 64;
    bandImage.height = 4;
    const ctx = bandImage.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 64, 0);
    g.addColorStop(0, "#5e5e5e");
    g.addColorStop(0.5, "#ffffff");
    g.addColorStop(1, "#5e5e5e");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 4);
  }
  const texture = new THREE.CanvasTexture(bandImage);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

let flameTexture: THREE.CanvasTexture | undefined;
const flame = () => {
  if (flameTexture) return flameTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.8)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return (flameTexture = new THREE.CanvasTexture(canvas));
};

export class InfraScene {
  private renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private content = new THREE.Group();
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
  private persp = new THREE.PerspectiveCamera(38, 1, 1, 20000);
  private camera: THREE.Camera = this.ortho;
  private controls: OrbitControls;
  private spin = false;
  private sun = new THREE.DirectionalLight(0xffffff, 2.4);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.5);
  private grid?: THREE.GridHelper;
  private nodes = new Map<string, NodeView>();
  private edges = new Map<string, EdgeView>();
  private groups = new Map<string, THREE.Mesh>();
  private pickables: THREE.Object3D[] = [];
  private palette = readPalette();
  private infra?: Infra;
  private layout?: Layout;
  private view: View = "iso";
  private selected: Pick = null;
  private highlight: Set<string> | null = null;
  private hovered: Pick = null;
  private tween?: { from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; zoom?: [number, number]; t: number };
  private clock = new THREE.Clock();
  private frame = 0;
  private resize: ResizeObserver;
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private raycaster = new THREE.Raycaster();
  private down?: { x: number; y: number };

  onSelect: (pick: Pick) => void = () => {};
  onHover: (pick: Pick, x: number, y: number) => void = () => {};

  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels";
    host.append(this.renderer.domElement, this.labels.domElement);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.content);

    this.controls = this.makeControls();
    const el = this.renderer.domElement;
    el.addEventListener("pointermove", this.pointerMove);
    el.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", this.pointerUp);
    el.addEventListener("pointerleave", () => this.setHover(null, 0, 0));
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.loop();
  }

  /** Builds everything from scratch; keeps the camera unless `frame` is true. */
  build(infra: Infra, layout: Layout, frame = false) {
    this.infra = infra;
    this.layout = layout;
    this.palette = readPalette();
    this.clear();
    const p = this.palette;
    this.scene.background = new THREE.Color(p.bg);

    const span = Math.max(400, layout.size * 1.6);
    this.grid = new THREE.GridHelper(span, Math.round(span / 40), p.line, p.line);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.35;
    this.grid.position.y = -0.5;
    this.content.add(this.grid);
    this.sun.position.set(-span * 0.35, span * 0.8, span * 0.25);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -span / 2;
    sc.right = sc.top = span / 2;
    sc.near = 1;
    sc.far = span * 3;
    sc.updateProjectionMatrix();

    for (const g of infra.groups) this.addGroup(g, layout);
    for (const n of infra.nodes) this.addNode(n, layout);
    for (const e of infra.edges) this.addEdge(e);


    for (const v of this.nodes.values()) this.paintNode(v);
    for (const v of this.edges.values()) this.paintEdge(v);
    if (this.selected && !this.exists(this.selected)) this.selected = null;
    this.applySelection();
    if (frame) this.setView(this.view, false);
  }

  /** Re-reads the theme colours and rebuilds. */
  restyle() {
    textureCache.clear();
    if (this.infra && this.layout) this.build(this.infra, this.layout);
  }

  updateNode(node: InfraNode) {
    const v = this.nodes.get(node.id);
    if (!v) return;
    v.node = node;
    this.paintNode(v);
  }

  updateEdge(edge: Edge) {
    const v = this.edges.get(edge.id);
    if (!v) return;
    v.edge = edge;
    this.paintEdge(v);
  }

  /** Dims everything but these nodes and the links between them, while nothing is selected; null clears it. */
  setHighlight(ids: Set<string> | null) {
    this.highlight = ids;
    this.applySelection();
  }

  select(pick: Pick, focus = false) {
    this.selected = pick;
    this.applySelection();
    if (focus && pick) this.focus(pick);
  }

  setView(view: View, animate = true) {
    this.view = view;
    const wantPersp = view === "3d";
    if (wantPersp !== (this.camera === this.persp)) {
      const pos = this.camera.position.clone();
      this.camera = wantPersp ? this.persp : this.ortho;
      this.camera.position.copy(pos);
      const target = this.controls.target.clone();
      this.controls.dispose();
      this.controls = this.makeControls();
      this.controls.target.copy(target);
    }
    const dir = view === "top" ? new THREE.Vector3(0, 1, 0.0001) : view === "iso" ? new THREE.Vector3(1, 1, 1) : new THREE.Vector3(0.9, 0.75, 1.25);
    const box = this.bounds();
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(100, box.getSize(new THREE.Vector3()).length() / 2);
    // Depth range from the scene's size: fixed planes clipped every large map out of view.
    this.ortho.near = -radius * 10;
    this.ortho.far = radius * 10;
    this.persp.far = radius * 12;
    this.ortho.updateProjectionMatrix();
    this.persp.updateProjectionMatrix();
    if (wantPersp) {
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 0.8;
      return this.moveCamera(center, dir.normalize().multiplyScalar(distance), 1, animate);
    }
    // Orthographic: look from far away, then zoom until the scene's projected bounds fill the view.
    const offset = dir.normalize().multiplyScalar(radius * 4);
    const probe = this.ortho.clone();
    probe.position.copy(center).add(offset);
    probe.lookAt(center);
    probe.updateMatrixWorld();
    const view2d = new THREE.Box2();
    for (let i = 0; i < 8; i++) {
      const corner = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      const p = corner.applyMatrix4(probe.matrixWorldInverse);
      view2d.expandByPoint(new THREE.Vector2(p.x, p.y));
    }
    const size = view2d.getSize(new THREE.Vector2());
    const zoom = 0.88 * Math.min((this.ortho.right - this.ortho.left) / size.x, (this.ortho.top - this.ortho.bottom) / size.y);
    this.moveCamera(center, offset, zoom, animate);
  }

  /** Pixels one world unit covers at the target, to decide how much label text fits. */
  private pixelsPerUnit() {
    const h = this.host.clientHeight || 1;
    if (this.camera === this.ortho) return (this.ortho.zoom * h) / (this.ortho.top - this.ortho.bottom);
    const d = this.persp.position.distanceTo(this.controls.target);
    return h / (2 * d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)));
  }

  private bounds() {
    this.content.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const v of this.nodes.values()) box.expandByObject(v.body);
    for (const g of this.groups.values()) box.expandByObject(g);
    if (box.isEmpty()) box.set(new THREE.Vector3(-200, 0, -200), new THREE.Vector3(200, 40, 200));
    box.max.y += 40; // arcs and labels above the tallest node
    return box;
  }

  /** Turns the view slowly around its centre; kept across view switches, which rebuild the controls. */
  setAutoRotate(on: boolean) {
    this.spin = on;
    this.controls.autoRotate = on;
  }

  zoomBy(factor: number) {
    if (this.camera === this.ortho) {
      this.ortho.zoom = THREE.MathUtils.clamp(this.ortho.zoom * factor, 0.03, 20);
      this.ortho.updateProjectionMatrix();
    } else {
      const offset = this.persp.position.clone().sub(this.controls.target).divideScalar(factor);
      this.persp.position.copy(this.controls.target).add(offset);
    }
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  // ---------------------------------------------------------------- building

  private addGroup(group: Group, layout: Layout) {
    const at = layout.groups.get(group.id);
    if (!at) return;
    const p = this.palette;
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(at.w, PLATE, at.d),
      new THREE.MeshStandardMaterial({ color: p.plates[Math.min(at.level, 3)], roughness: 0.92, metalness: 0 }),
    );
    plate.position.set(at.x, at.level * LEVEL + PLATE / 2, at.z);
    plate.receiveShadow = true;
    plate.userData = { type: "group", id: group.id };
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(plate.geometry), new THREE.LineBasicMaterial({ color: p.line }));
    plate.add(outline);
    this.content.add(plate);
    this.groups.set(group.id, plate);

    const look = lookOf(group.kind ?? "");
    const el = document.createElement("div");
    el.className = "group-label";
    const icon = iconDataUrl(look.icon);
    el.innerHTML = `${icon && group.kind ? `<img src="${icon}" alt="">` : ""}<span></span>`;
    el.querySelector("span")!.textContent = group.label;
    const label = new CSS2DObject(el);
    label.center.set(0, 0.5);
    label.position.set(-at.w / 2 + 10, PLATE / 2 + 0.5, -at.d / 2 + 16);
    plate.add(label);
  }

  private addNode(node: InfraNode, layout: Layout) {
    const at = layout.nodes.get(node.id);
    if (!at) return;
    const look = lookOf(node.kind);
    const { geometry, height } = SHAPES[look.shape]();
    const baseY = at.level ? (at.level - 1) * LEVEL + PLATE : 0;
    const baseColor = new THREE.Color(this.palette.category[look.category]);
    const body = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: baseColor.clone(), roughness: 0.55, metalness: 0.05, transparent: true }));
    body.position.set(at.x, baseY + height / 2, at.z);
    body.castShadow = body.receiveShadow = true;
    body.userData = { type: "node", id: node.id };
    this.content.add(body);
    this.pickables.push(body);

    const top = new THREE.Vector3(at.x, baseY + height, at.z);
    let decal: THREE.Object3D | undefined;
    const texture = decalTexture(look, this.palette.ink);
    if (look.shape === "sphere") {
      decal = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
      decal.scale.set(22, 22, 1);
      decal.position.set(at.x, baseY + height / 2, at.z);
      decal.renderOrder = 2;
    } else {
      const size = look.shape === "queue" ? 22 : look.shape === "slab" ? 26 : 28;
      decal = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
      decal.rotation.x = -Math.PI / 2;
      decal.position.copy(top).add(new THREE.Vector3(0, 0.3, 0));
    }
    decal.userData = body.userData;
    this.content.add(decal);
    this.pickables.push(decal);

    const ring = new THREE.Mesh(new THREE.RingGeometry(25, 30, 48), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(at.x, baseY + 0.4, at.z);
    this.content.add(ring);

    const el = document.createElement("div");
    el.className = "node-label";
    el.innerHTML = `<b></b><small></small>`;
    el.querySelector("b")!.textContent = node.label;
    const label = new CSS2DObject(el);
    label.center.set(0.5, 0);
    label.position.set(at.x, baseY, at.z + at.d / 2 + 6);
    this.content.add(label);

    this.nodes.set(node.id, { node, look, body, decal, ring, label, top, base: new THREE.Vector3(at.x, baseY, at.z), baseColor, flames: [] });
  }

  private addEdge(edge: Edge) {
    const a = this.nodes.get(edge.from);
    const b = this.nodes.get(edge.to);
    if (!a || !b) return;
    const start = a.top.clone().add(new THREE.Vector3(0, 1, 0));
    const end = b.top.clone().add(new THREE.Vector3(0, 1, 0));
    const lift = 18 + start.distanceTo(end) * 0.22;
    const mid = start.clone().lerp(end, 0.5);
    mid.y = Math.max(start.y, end.y) + lift;
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const length = curve.getLength();
    const texture = bands();
    texture.repeat.set(Math.max(1, Math.round(length / 60)), 1);
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 64, 1.6, 10),
      new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.35, metalness: 0.1, map: texture, emissiveMap: texture }),
    );
    const hit = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 5, 5), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hit.userData = { type: "edge", id: edge.id };
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(2.8, 8, 14), new THREE.MeshStandardMaterial({ transparent: true }));
    arrow.position.copy(curve.getPoint(0.9));
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(0.9));
    const el = document.createElement("div");
    el.className = "edge-marker";
    const marker = new CSS2DObject(el);
    marker.position.copy(curve.getPoint(0.5));
    this.content.add(tube, hit, arrow, marker);
    this.pickables.push(hit);
    this.edges.set(edge.id, { edge, curve, length, tube, hit, arrow, marker });
  }

  private clear() {
    for (const v of this.edges.values()) v.tube.material.map?.dispose();
    for (const object of [...this.content.children]) {
      object.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (mat) for (const x of [mat].flat()) x.dispose();
      });
      this.content.remove(object);
    }
    this.nodes.clear();
    this.edges.clear();
    this.groups.clear();
    this.pickables = [];
  }

  private exists(pick: NonNullable<Pick>) {
    return pick.type === "node" ? this.nodes.has(pick.id) : pick.type === "edge" ? this.edges.has(pick.id) : this.groups.has(pick.id);
  }

  // ---------------------------------------------------------------- state

  private paintNode(v: NodeView) {
    const p = this.palette;
    const state = v.node.state ?? "ok";
    const color = v.baseColor.clone();
    if (state === "down") color.lerp(new THREE.Color(p.muted), 0.6);
    v.body.material.color.copy(color);
    v.body.material.emissive.set(state === "fire" ? p.fire : state === "down" ? p.crit : state === "degraded" ? p.warn : "#000000");
    v.body.material.emissiveIntensity = state === "ok" ? 0 : 0.35;
    const ringColor = { ok: p.ok, degraded: p.warn, down: p.crit, fire: p.fire, unknown: p.idle }[state];
    v.ring.material.color.set(ringColor);
    v.ring.visible = state !== "ok";
    v.label.element.dataset.state = state;
    v.label.element.querySelector("small")!.textContent = state === "ok" ? "" : (v.node.message ?? state);

    if (state !== "fire") this.throb(v, 1);
    if (state === "fire" && v.flames.length === 0) {
      for (let i = 0; i < 16; i++) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: flame(), color: p.fire, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
        sprite.userData.seed = Math.random();
        sprite.renderOrder = 3;
        this.content.add(sprite);
        v.flames.push(sprite);
      }
    } else if (state !== "fire") {
      for (const s of v.flames) {
        s.material.dispose();
        this.content.remove(s);
      }
      v.flames = [];
    }
  }

  /** Scales a node about its base, so it swells on its plate and the icon stays on top. */
  private throb(v: NodeView, scale: number) {
    const height = v.top.y - v.base.y;
    v.body.scale.setScalar(scale);
    v.body.position.y = v.base.y + (height / 2) * scale;
    if (v.decal instanceof THREE.Sprite) v.decal.scale.set(22 * scale, 22 * scale, 1);
    else if (v.decal) {
      v.decal.scale.setScalar(scale);
      v.decal.position.y = v.base.y + height * scale + 0.3;
    }
  }

  private paintEdge(v: EdgeView) {
    const p = this.palette;
    const state = v.edge.state ?? "ok";
    // Healthy pipes are coloured by load: teal when light, cobalt when heavy (log scale up to ~2,000 req/s).
    const load = THREE.MathUtils.clamp(Math.log10((v.edge.rps ?? 30) + 1) / 3.3, 0, 1);
    const ok = new THREE.Color(p.flow).lerp(new THREE.Color(p.flowHeavy), load);
    const color = state === "ok" ? ok : new THREE.Color({ slow: p.warn, broken: p.crit, idle: p.idle }[state]);
    v.tube.material.color.copy(color);
    v.tube.material.emissive.copy(color);
    v.tube.material.emissiveIntensity = state === "idle" ? 0 : 0.45;
    v.arrow.material.color.copy(color);
    v.arrow.material.emissive.copy(color);
    v.arrow.material.emissiveIntensity = 0.4;
    v.marker.element.dataset.state = state;
    v.marker.element.textContent = state === "broken" ? "✕" : state === "slow" ? `${v.edge.latencyMs ?? "slow"}${v.edge.latencyMs ? " ms" : ""}` : "";
    v.marker.visible = state === "broken" || state === "slow";
  }

  private applySelection() {
    const sel = this.selected;
    const related = new Set<string>();
    if (sel?.type === "node") {
      related.add(sel.id);
      for (const e of this.edges.values())
        if (e.edge.from === sel.id || e.edge.to === sel.id) related.add(e.edge.id), related.add(e.edge.from), related.add(e.edge.to);
    } else if (sel?.type === "edge") {
      const e = this.edges.get(sel.id);
      if (e) [e.edge.id, e.edge.from, e.edge.to].forEach((id) => related.add(id));
    }
    const hl = sel ? null : this.highlight;
    if (hl) {
      hl.forEach((id) => related.add(id));
      for (const e of this.edges.values()) if (hl.has(e.edge.from) && hl.has(e.edge.to)) related.add(e.edge.id);
    }
    const dim = (id: string) => (hl ? !related.has(id) : sel?.type !== "group" && sel !== null && !related.has(id));
    for (const v of this.nodes.values()) {
      v.body.material.opacity = dim(v.node.id) ? 0.35 : 1;
      v.label.element.classList.toggle("dim", dim(v.node.id));
      v.label.element.classList.toggle("selected", sel?.type === "node" && sel.id === v.node.id);
      v.label.element.classList.toggle("highlighted", !!hl?.has(v.node.id));
    }
    for (const v of this.edges.values()) {
      v.tube.material.opacity = dim(v.edge.id) ? 0.15 : 0.95;
      v.arrow.material.opacity = dim(v.edge.id) ? 0.15 : 1;
      v.tube.scale.setScalar(1);
    }
    for (const [id, plate] of this.groups)
      ((plate.children[0] as THREE.LineSegments).material as THREE.LineBasicMaterial).color.set(sel?.type === "group" && sel.id === id ? this.palette.accent : this.palette.line);
  }

  // ---------------------------------------------------------------- camera

  private makeControls() {
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.minZoom = 0.03;
    controls.maxZoom = 20;
    controls.zoomToCursor = true;
    controls.autoRotate = this.spin;
    controls.autoRotateSpeed = 0.6;
    return controls;
  }

  private moveCamera(target: THREE.Vector3, offset: THREE.Vector3, zoom: number, animate: boolean) {
    const to = target.clone().add(offset);
    const toZoom = this.camera === this.ortho ? zoom : undefined;
    if (!animate || this.reducedMotion) {
      this.camera.position.copy(to);
      this.controls.target.copy(target);
      if (toZoom) (this.ortho.zoom = toZoom), this.ortho.updateProjectionMatrix();
      this.controls.update();
      return;
    }
    this.tween = {
      from: this.camera.position.clone(), to, fromTarget: this.controls.target.clone(), toTarget: target,
      zoom: toZoom ? [this.ortho.zoom, toZoom] : undefined, t: 0,
    };
  }

  private focus(pick: NonNullable<Pick>) {
    const point =
      pick.type === "node" ? this.nodes.get(pick.id)?.top :
      pick.type === "edge" ? this.edges.get(pick.id)?.curve.getPoint(0.5) :
      this.groups.get(pick.id)?.position;
    if (!point) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const zoom = this.camera === this.ortho ? Math.max(this.ortho.zoom, (2 * (this.ortho.top - this.ortho.bottom)) / (this.host.clientHeight || 1)) : 1;
    if (this.camera === this.persp) offset.setLength(Math.min(offset.length(), 380));
    this.moveCamera(point.clone(), offset, zoom, true);
  }

  private fit() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    const aspect = w / h;
    const half = 300;
    this.ortho.left = -half * aspect;
    this.ortho.right = half * aspect;
    this.ortho.top = half;
    this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- input

  private pick(e: PointerEvent): Pick {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...this.pickables, ...this.groups.values()], false)[0];
    return hit ? (hit.object.userData as Pick) : null;
  }

  private pointerMove = (e: PointerEvent) => {
    if (e.buttons) return;
    const pick = this.pick(e);
    this.setHover(pick?.type === "group" ? null : pick, e.clientX, e.clientY);
  };

  private pointerUp = (e: PointerEvent) => {
    if (!this.down || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) return;
    const pick = this.pick(e);
    this.selected = pick;
    this.applySelection();
    this.onSelect(pick);
  };

  private setHover(pick: Pick, x: number, y: number) {
    const same = pick?.id === this.hovered?.id && pick?.type === this.hovered?.type;
    this.hovered = pick;
    this.renderer.domElement.style.cursor = pick ? "pointer" : "grab";
    if (!same || pick) this.onHover(pick, x, y);
  }

  // ---------------------------------------------------------------- animation

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const time = this.clock.elapsedTime;

    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / 0.7);
      const k = 1 - Math.pow(1 - tw.t, 3);
      this.camera.position.lerpVectors(tw.from, tw.to, k);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
      if (tw.zoom) (this.ortho.zoom = THREE.MathUtils.lerp(tw.zoom[0], tw.zoom[1], k)), this.ortho.updateProjectionMatrix();
      if (tw.t >= 1) this.tween = undefined;
    }
    // A camera glide (Fit, a view switch) would fight the spin and look like it turns backwards: pause it meanwhile.
    this.controls.autoRotate = this.spin && !this.tween;
    this.controls.update();

    const ppu = this.pixelsPerUnit();
    this.labels.domElement.classList.toggle("far", ppu < 1.1);
    this.labels.domElement.classList.toggle("tiny", ppu < 0.6);

    this.animateFlows(dt);
    this.animateStates(time);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  /** Liquid in the pipes: the colour wave slides toward the target at the connection's speed. */
  private animateFlows(dt: number) {
    for (const v of this.edges.values()) {
      const state = v.edge.state ?? "ok";
      const map = v.tube.material.map!;
      if (state === "ok" || state === "slow") {
        const speed = (state === "slow" ? 8 : SPEED[flowSpeed(v.edge, this.infra)]) * (this.reducedMotion ? 0.3 : 1);
        map.offset.x -= (speed * dt * map.repeat.x) / v.length;
      }
      if (state === "broken") v.tube.material.emissiveIntensity = 0.25 + 0.5 * (Math.sin(performance.now() / 160) > 0 ? 1 : 0);
    }
  }

  private animateStates(time: number) {
    for (const v of this.nodes.values()) {
      const state = v.node.state ?? "ok";
      if (state === "ok") continue;
      const pulse = this.reducedMotion ? 0.5 : (Math.sin(time * (state === "fire" ? 9 : 3.5)) + 1) / 2;
      v.ring.scale.setScalar(1 + pulse * 0.35);
      v.ring.material.opacity = 0.9 - pulse * 0.6;
      v.body.material.emissiveIntensity = state === "down" ? 0.15 : 0.2 + pulse * (state === "fire" ? 0.6 : 0.35);
      if (state === "fire") this.throb(v, 1 + 0.07 * pulse);
      v.flames.forEach((s, k) => {
        const seed = s.userData.seed as number;
        const life = this.reducedMotion ? seed : (time * (0.9 + seed * 0.8) + seed) % 1;
        const angle = seed * Math.PI * 2 + k;
        s.position.set(v.top.x + Math.cos(angle) * 10 * (1 - life), v.top.y + 2 + life * 34, v.top.z + Math.sin(angle) * 10 * (1 - life));
        s.scale.setScalar(16 * (1 - life * 0.75));
        s.material.color.set(life < 0.35 ? "#ffe08a" : this.palette.fire);
        s.material.opacity = 1 - life;
      });
    }
  }
}
