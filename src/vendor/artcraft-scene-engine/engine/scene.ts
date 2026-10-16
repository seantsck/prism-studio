import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/addons/loaders/GLTFLoader.js";

import { Font } from "three/examples/jsm/loaders/FontLoader.js";
import { generateUUID } from "three/src/math/MathUtils.js";
import { LoadingPlaceHolderManager } from "./placeholder_manager";
import { MediaFileType } from "../enums";
import { getShapeFactory } from "../shims/shape-factory";
import { InfiniteGridHelper } from "./InfiniteGridHelper";
import type { Camera } from "../shims/common";
import toast from "../shims/toast";
import {
  collectObjectTextures,
  disposeObject3D,
} from "../shims/ui-viewer-3d";

// Capabilities Scene needs from outside its own state. Editor wires
// these in inline at construction (Phase 2 idiom — same shape as
// SceneUtilsDeps, SaveManagerDeps, etc.). Scene does NOT import the
// Zustand store directly and has no Tauri imports; the host (artcraft
// wrapper) supplies fetchAsset (CORS-bypassed binary fetch) and
// getMediaUrlByToken (resolves a media_file_token to its CDN URL).
export type SceneDeps = {
  getCameras: () => Camera[];
  getSelectedCameraId: () => string;
  // Adapter-supplied binary fetch. Optional `init.signal` lets the
  // scene loader cancel in-flight downloads when its load is
  // superseded.
  fetchAsset: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<Response>;
  getMediaUrlByToken: (token: string) => Promise<string>;
  // Optional batch resolver — when provided, the proxy scene loader
  // warms a URL cache with one roundtrip instead of N. When absent,
  // Scene.warmMediaURLs falls back to Promise.all of the single-token
  // method.
  getMediaUrlsByTokens?: (tokens: string[]) => Promise<Record<string, string>>;
  // Fired after a GLB finishes loading into the scene. Outliner metadata
  // (hasSkeleton, bakedClips) is computed at refresh time, so the editor
  // uses this to refresh rows that were rendered before the async load
  // completed (e.g. saved-scene proxy loads).
  onGlbLoaded?: () => void;
};

class Scene {
  name: string;
  gridHelper: InfiniteGridHelper | undefined;
  groundPlane: THREE.Mesh | undefined;
  scene: THREE.Scene;
  hot_items: THREE.Object3D[] | undefined;

  // Display message
  message_mesh: THREE.Mesh | undefined;
  loading_placeholder: THREE.Object3D | undefined;
  message_font: Font | undefined;

  // global names
  camera_name: string;

  // PRISM PATCH: kept (always empty) for the editor tick; upstream's Water/MMD paths are not vendored
  shader_objects: Array<THREE.Mesh & { material: THREE.ShaderMaterial }> = [];
  video_planes: HTMLVideoElement[] = [];

  skybox: string;

  // loading indicator manager
  placeholder_manager: LoadingPlaceHolderManager | undefined;

  updateSurfaceIdAttributeToMesh: Function;
  ambientLight: THREE.AmbientLight | undefined;
  hemisphereLight: THREE.HemisphereLight | undefined;
  directional_light: THREE.DirectionalLight | undefined;
  version: number;

  // This is used to ensure we do not rerender or process the video if we already have done so.
  // This allows us to reprompt things quickly. This is only written when a snap shot is taken.
  // Which guarentees that the scene is availible.
  current_scene_checksum: string;
  private deps: SceneDeps;
  constructor(
    name: string,
    camera_name: string,
    updateSurfaceIdAttributeToMesh: Function,
    version: number,
    deps: SceneDeps,
  ) {
    this.version = version;
    this.name = name;
    this.gridHelper;
    this.scene = new THREE.Scene();
    this.hot_items = [];

    this.message_mesh = undefined;
    this.loading_placeholder = undefined;
    this.message_font = undefined;
    this.skybox = "m_1";

    // global names
    this.camera_name = camera_name;
    this.placeholder_manager = undefined;
    this.updateSurfaceIdAttributeToMesh = updateSurfaceIdAttributeToMesh;
    this.deps = deps;

    this.current_scene_checksum = "";
  }

  initialize() {
    this.scene = new THREE.Scene();
    this.placeholder_manager = new LoadingPlaceHolderManager(this.scene);
    this.placeholder_manager.initialize();

    this._createGrid();
    this._create_base_lighting();
    this._create_skybox();
    this._create_camera_obj();
  }

  // Apply a grid visibility change. Pure THREE-side mutation — the
  // store subscription that drives this lives at the engine boundary
  // (editor.ts), not inside Scene itself.
  applyGridVisibility(visible: boolean) {
    if (!this.gridHelper) return;
    if (visible) {
      if (!this.scene.children.includes(this.gridHelper)) {
        this.scene.add(this.gridHelper);
      }
    } else {
      this.scene.remove(this.gridHelper);
    }
  }

  clear() {
    this.disposeContents();
    this._createGrid();
    this._create_base_lighting();
    this._create_skybox();
    this._create_camera_obj();
  }

  // Remove everything from the scene and free its GPU resources. The
  // background is left in place: _create_skybox frees it when it is
  // replaced, and teardown frees it through disposeBackground.
  disposeContents() {
    this.disposeObject(this.scene);
    this.scene.clear();
    // hot_items held detached keyframe-point refs across reloads; reset it
    // so it never carries stale objects from a previous scene.
    this.hot_items = [];
  }

  // Free an object tree that has left the scene for good: its GPU
  // resources, plus its entries in the per-object registries (video elements).
  disposeObject(root: THREE.Object3D) {
    const inTree = new Set<THREE.Object3D>();
    root.traverse((child) => inTree.add(child));

    const videos = new Set<HTMLVideoElement>();
    for (const texture of collectObjectTextures(root)) {
      if (texture instanceof THREE.VideoTexture) videos.add(texture.image);
    }
    for (const video of videos) stopVideo(video);
    this.video_planes = this.video_planes.filter(
      (video) => !videos.has(video),
    );

    disposeObject3D(root);
  }

  // Final teardown when the owning Editor unmounts: free the contents and
  // the background. The Scene is not used again — every mount builds a new
  // Editor, and EngineProvider serializes the scene before unmounting.
  dispose() {
    this.disposeContents();
    this.disposeBackground();
    this.scene.background = null;
  }

  disposeBackground() {
    if (this.scene.background instanceof THREE.Texture) {
      this.scene.background.dispose();
    }
  }

  async instantiate(
    name: string,
    pos: THREE.Vector3 = new THREE.Vector3(0, 0, 0),
  ) {
    const material = new THREE.MeshPhongMaterial({ color: 0xdacbce });
    material.shininess = 0.0;
    let geometry;
    if (name == "Box") {
      geometry = new THREE.BoxGeometry(1, 1, 1);
    } else if (name == "Cone") {
      geometry = new THREE.ConeGeometry(0.5, 1, 16);
    } else if (name == "Cylinder") {
      geometry = new THREE.CylinderGeometry(0.5, 0.5, 2, 12);
    } else if (name == "Sphere") {
      geometry = new THREE.SphereGeometry(0.5, 18, 12);
    } else if (name == "Donut") {
      geometry = new THREE.TorusGeometry(0.5, 0.25, 8, 24);
    } else if (getShapeFactory(name)) {
      // PRISM PATCH: host-registered procedural shapes (Plane, Mannequin)
      const factory = getShapeFactory(name)!;
      geometry = factory.geometry();
      if (factory.doubleSided) material.side = THREE.DoubleSide;
    } else if (name == "PointLight") {
      geometry = new THREE.SphereGeometry(0.06, 18, 12);
    } else if (name.includes("Image::")) {
      geometry = new THREE.PlaneGeometry(1, 1);
    }

    let obj;
    if (name.includes("Image::")) {
      const image_token = name.replace("Image::", "");
      let texture;

      // PRISM PATCH: video planes (and the forum-sourced chroma-key shader) are not vendored
      if (image_token.includes(".mp4")) {
        throw new Error("Video planes are not supported in Prism 3D sets.");
      } else {
        const loader = new THREE.TextureLoader();
        // NB(bt,2025-08-26): Images loaded throughout the rest of ArtCraft with the <img> tag set
        // the "sec-fetch-mode: no-cors" header. On Safari (Mac), this is cached and makes the image
        // permanently impossible to use in Three.js. We bypass this by appending a query parameter
        // to the URL.
        const modifiedUrl = image_token + "?threejs=true";
        texture = loader.load(modifiedUrl);
        texture.colorSpace = THREE.SRGBColorSpace;
        const image_material = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          map: texture,
          transparent: true,
          side: THREE.DoubleSide,
        });
        obj = new THREE.Mesh(geometry, image_material);
        obj.userData["media_id"] = name;
        obj.userData["media_file_type"] = MediaFileType.Image;
      }
    } else if (name == "PointLight") {
      const light_material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
      });
      obj = new THREE.Mesh(geometry, light_material);
      obj.userData["media_id"] = "Parim";
    } else {
      obj = new THREE.Mesh(geometry, material);
      obj.userData["media_id"] = "Parim";
    }
    obj.receiveShadow = true;
    obj.castShadow = true;
    //obj.type = "Object3D";
    obj.name = name;
    obj.position.copy(pos);
    obj.userData["color"] = "#FFFFFF";
    obj.userData["metalness"] = 0.0;
    obj.userData["shininess"] = 0.5;
    obj.userData["specular"] = 0.0;
    obj.userData["locked"] = false;
    obj.userData["media_file_type"] = MediaFileType.None;
    // Dedicated, persisted shape marker. `media_id === "Parim"` is set
    // by every geometric primitive (Box/Cone/Cylinder/Sphere/Donut/
    // PointLight/Water) and NOT by Image::/video planes, so this tags
    // exactly the constant-color shapes. setColor reads userData.isShape
    // to decide constant-color (shapes) vs leave-textures (everything
    // else). instantiate is the single creation chokepoint (fresh add,
    // paste, undo/redo, proxy load), so this is always present.
    if (obj.userData["media_id"] === "Parim") {
      obj.userData["isShape"] = true;
      obj.userData["shapeType"] = name;
    }

    this.scene.add(obj);

    if (name == "PointLight") {
      const light = new THREE.PointLight(0xffffff, 1, 100);
      this.scene.add(light);
      light.position.copy(obj.position);
      obj.attach(light);
      obj.layers.set(1);
      obj.userData["light"] = light.uuid;
    }

    this.updateSurfaceIdAttributeToMesh(this.scene);
    return obj;
  }

  get_objects_name(uuid: string): string {
    const object = this.get_object_by_uuid(uuid);
    if (object) {
      return object.name;
    }
    return uuid;
  }

  get_objects_position(uuid: string): THREE.Vector3 {
    const object = this.get_object_by_uuid(uuid);
    let pos = new THREE.Vector3(0, 0, 0);
    if (object) {
      pos = pos.copy(object.position);
    }
    return pos;
  }

  get_objects_userdata(uuid: string): Record<string, any> {
    const object = this.get_object_by_uuid(uuid);
    let userdata = {};
    if (object) {
      userdata = object.userData;
    }
    return userdata;
  }

  get_object_by_uuid(uuid: string) {
    return this.scene.getObjectByProperty("uuid", uuid);
  }

  get_object_by_name(name: string) {
    return this.scene.getObjectByName(name);
  }

  createPoint(
    pos: THREE.Vector3,
    rot: THREE.Vector3,
    scale: THREE.Vector3,
    keyframe_uuid: string,
  ): THREE.Object3D {
    const geometry = new THREE.SphereGeometry(0.1, 18, 12);
    const material = new THREE.MeshBasicMaterial({ color: 0x05c3dd });
    const obj = new THREE.Mesh(geometry, material);
    const first_quat = new THREE.Euler(
      THREE.MathUtils.degToRad(rot.x),
      THREE.MathUtils.degToRad(rot.y),
      THREE.MathUtils.degToRad(rot.z),
    );
    obj.position.copy(pos);
    obj.rotation.copy(first_quat);
    //obj.scale.copy(scale);
    obj.receiveShadow = false;
    obj.castShadow = false;
    obj.userData["media_id"] = "Point::" + keyframe_uuid;
    obj.layers.set(1); // Enable default layer
    if (this.hot_items != undefined) {
      this.hot_items.push(obj);
    }
    this.scene.add(obj);
    return obj;
  }

  deletePoint(keyframe_uuid: string) {
    this.scene.children.forEach((object) => {
      if (object.userData.media_id) {
        const obj_keyframe_uuid = object.userData.media_id.replace(
          "Point::",
          "",
        );
        if (obj_keyframe_uuid === keyframe_uuid) {
          this.scene.remove(object);
          return;
        }
      }
    });
  }

  getPoint(keyframe_uuid: string): THREE.Object3D | undefined {
    let keyframe_point = undefined;
    this.scene.children.forEach((object) => {
      if (object.userData.media_id) {
        const obj_keyframe_uuid = object.userData.media_id.replace(
          "Point::",
          "",
        );
        if (obj_keyframe_uuid === keyframe_uuid) {
          keyframe_point = object;
          return;
        }
      }
    });
    return keyframe_point;
  }

  updatePoint(
    keyframe_uuid: string,
    keyframe_pos: THREE.Vector3,
    keyframe_rot: THREE.Vector3,
    // keyframe_scl: THREE.Vector3,
  ) {
    this.scene.traverse((object) => {
      if (object.userData.media_id) {
        const obj_keyframe_uuid = object.userData.media_id.replace(
          "Point::",
          "",
        );
        if (obj_keyframe_uuid === keyframe_uuid) {
          const first_quat = new THREE.Euler(
            THREE.MathUtils.degToRad(keyframe_rot.x),
            THREE.MathUtils.degToRad(keyframe_rot.y),
            THREE.MathUtils.degToRad(keyframe_rot.z),
          );
          object.position.copy(keyframe_pos);
          object.rotation.copy(first_quat);
          //object.scale.copy(keyframe_scl);

          return;
        }
      }
    });
  }

  _disable_skybox() {
    //this.scene.background = null;
  }

  // Creates the render-camera placeholder — a selectable wireframe frustum
  // named "::CAM::" that lives in the scene like a Blender camera. Its
  // transform mirrors the render camera (CameraController.tickPerFrame syncs
  // cam_obj → render_camera). Placed on layer 1 so the viewport camera sees
  // it but render_camera (layer 1 disabled) excludes it from output. Has no
  // userData.media_id, so the save path skips it. Single camera for now.
  _create_camera_obj() {
    const cameras = this.deps.getCameras();
    const renderCam = cameras.find((c) => c.id !== "main") ?? cameras[0];
    if (!renderCam) return;

    // Idempotent: drop any existing frustum so callers (initialize, clear,
    // load-restore) never leave duplicate "::CAM::" objects.
    const existing = this.scene.getObjectByName("::CAM::");
    if (existing) this.scene.remove(existing);

    const group = this._buildCameraFrustum();
    group.name = "::CAM::";
    group.userData["name"] = "Camera";
    group.position.set(
      renderCam.position.x,
      renderCam.position.y,
      renderCam.position.z,
    );
    group.rotation.set(
      renderCam.rotation.x,
      renderCam.rotation.y,
      renderCam.rotation.z,
    );
    group.layers.set(1);
    group.children.forEach((child) => child.layers.set(1));
    this.scene.add(group);
  }

  // Builds the frustum line geometry: apex at the camera origin opening
  // toward -Z, with a near rectangle. White lines, matching the design.
  private _buildCameraFrustum(): THREE.Group {
    const group = new THREE.Group();
    const depth = 0.7;
    const halfW = 0.45;
    const halfH = 0.3;
    const apex = new THREE.Vector3(0, 0, 0);
    const tl = new THREE.Vector3(-halfW, halfH, -depth);
    const tr = new THREE.Vector3(halfW, halfH, -depth);
    const br = new THREE.Vector3(halfW, -halfH, -depth);
    const bl = new THREE.Vector3(-halfW, -halfH, -depth);
    const points: THREE.Vector3[] = [
      apex, tl, apex, tr, apex, br, apex, bl, // apex → corners
      tl, tr, tr, br, br, bl, bl, tl, // near rectangle
    ];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: 0xffffff });
    const lines = new THREE.LineSegments(geometry, material);
    // Disable line raycasting: THREE picks LineSegments with a 1-world-unit
    // threshold, which dwarfs this ~0.7u frustum and selects it from far
    // away. Selection is instead handled by the invisible pick-proxy below.
    lines.raycast = () => {};
    group.add(lines);

    // Invisible pick-proxy sized to the frustum volume so clicks match the
    // wireframe rather than a 1-unit halo. Raycastable (opacity 0, not
    // mesh.visible=false) but draws nothing.
    const proxyGeometry = new THREE.BoxGeometry(halfW * 2, halfH * 2, depth);
    const proxyMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const proxy = new THREE.Mesh(proxyGeometry, proxyMaterial);
    proxy.position.set(0, 0, -depth / 2);
    group.add(proxy);

    return group;
  }

  renderMode(enabled: boolean = true) {
    if (this.gridHelper == undefined) {
      return;
    }
    if (enabled) {
      this._disable_skybox();
      this.scene.remove(this.gridHelper);
    } else {
      this.scene.add(this.gridHelper);
      this._create_skybox();
    }
  }

  // URL cache populated by warmMediaURLs() before a scene load. Lets
  // every per-asset loadObject() skip its own metadata roundtrip. Lives
  // for the lifetime of the Scene; entries are cheap (string→string).
  private mediaUrlCache: Map<string, string> = new Map();

  // Resolve a media_file_token to its CDN URL. Reads from the warm
  // cache first (populated by warmMediaURLs during a scene load) before
  // falling back to a single-token metadata fetch.
  async getMediaURL(media_id: string) {
    const cached = this.mediaUrlCache.get(media_id);
    if (cached !== undefined) return cached;
    return this.deps.getMediaUrlByToken(media_id);
  }

  // Warm the URL cache for a batch of tokens up front. Uses the host's
  // batch resolver when available (one roundtrip), otherwise fans out
  // single-token requests in parallel. Missing tokens (e.g. an asset
  // was deleted) silently fall through to the per-asset fetch path.
  async warmMediaURLs(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    const unique = Array.from(new Set(tokens));
    if (this.deps.getMediaUrlsByTokens) {
      const urls = await this.deps.getMediaUrlsByTokens(unique);
      for (const [token, url] of Object.entries(urls)) {
        if (url) this.mediaUrlCache.set(token, url);
      }
      return;
    }
    const results = await Promise.all(
      unique.map((token) =>
        this.deps
          .getMediaUrlByToken(token)
          .then((url) => [token, url] as const)
          .catch(() => [token, ""] as const),
      ),
    );
    for (const [token, url] of results) {
      if (url) this.mediaUrlCache.set(token, url);
    }
  }

  private floatToPercent(value: number) {
    return `${(value * 100).toFixed(0)}%`;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  setColor(object_uuid: string, hex_color: string) {
    const object = this.get_object_by_uuid(object_uuid);
    if (!object) return;
    object.userData["color"] = hex_color;
    // Deterministic, classification-based color (see instantiate, where
    // the persisted userData.isShape / shapeType marker is set):
    //   shape → exact constant solid color (incl. white). No heuristic.
    //   non-shape (character/GLB/MMD/image) → leave its own
    //     texture/material colors untouched; the picker does not flatten
    //     it. userData.color is still recorded so the inspector swatch
    //     stays controlled.
    const isShape = object.userData["isShape"] === true;
    const picked = new THREE.Color(hex_color);
    object.traverse((c: THREE.Object3D) => {
      if (!(c instanceof THREE.Mesh)) return;
      if (!isShape) return;
      if (c.material.color === undefined) return;
      c.material.color.set(picked);
      if (c.name == "PointLight") {
        const light = this.get_object_by_uuid(c.userData["light"]);
        if (light) {
          (light as THREE.PointLight).color = new THREE.Color(hex_color);
        }
      }
    });
  }

  setVisible(object_uuid: string, visible: boolean) {
    const object = this.get_object_by_uuid(object_uuid);
    if (object) {
      object.visible = visible;
      object.userData["visible"] = object.visible;
    }
  }

  async loadObjectFromUrl(
    url: string,
    position: THREE.Vector3 = new THREE.Vector3(-0.5, 1.5, 0),
  ): Promise<THREE.Object3D | undefined> {
    console.log("loadObjectFromUrl!!!!!!!!", url);
    if (
      url.includes(".png") ||
      url.includes(".jpg") ||
      url.includes(".jpeg") ||
      url.includes(".mp4")
    ) {
      const obj = await this.instantiate("Image::" + url);
      obj.position.copy(position);
      if (url.includes(".mp4")) {
        obj.userData["media_file_type"] = MediaFileType.Video;
      } else {
        obj.userData["media_file_type"] = MediaFileType.Image;
      }
      return obj;
    }
    return undefined;
  }

  async loadObject(
    media_id: string,
    name: string,
    auto_add: boolean = true,
    position: THREE.Vector3 = new THREE.Vector3(-0.5, 1.5, 0),
    version: number = 1.0,
    signal?: AbortSignal,
  ): Promise<THREE.Object3D> {
    const url = await this.getMediaURL(media_id);

    // PRISM PATCH: MMD (.pmd/.pmx) is not supported
    if (url.includes(".pmd") || url.includes(".pmx")) {
      throw new Error("MMD models are not supported in Prism 3D sets.");
    } else if (
      url.includes(".png") ||
      url.includes(".jpg") ||
      url.includes(".jpeg") ||
      url.includes(".mp4")
    ) {
      const obj = await this.instantiate("Image::" + url);
      obj.position.copy(position);
      // Preserve original token to enable copy/paste and timeline mapping
      obj.userData["media_id"] = media_id;
      if (url.includes(".mp4")) {
        obj.userData["media_file_type"] = MediaFileType.Video;
      } else {
        obj.userData["media_file_type"] = MediaFileType.Image;
      }
      return obj;
    } else if (url.includes(".spz")) {
      // PRISM PATCH: Gaussian splats (and @sparkjsdev/spark) are not part of M1
      throw new Error("Gaussian splats are not supported in Prism 3D sets yet.");
    }

    return await this.loadGlbWithPlaceholder(
      media_id,
      name,
      auto_add,
      position,
      version,
      signal,
    );
  }

  addChildrenToScene(parent: THREE.Object3D, scene: THREE.Scene): void {
    parent.children.forEach((child: THREE.Object3D) => {
      scene.add(child);
      // If the child has its own children, recursively add them
      if (child.children && child.children.length > 0) {
        this.addChildrenToScene(child, scene);
      }
    });
  }

  containsGroup(object: THREE.Object3D): boolean {
    if (object instanceof THREE.Group) {
      return true;
    }
    for (const child of object.children) {
      if (this.containsGroup(child)) {
        return true;
      }
    }
    return false;
  }

  async loadGlbWithPlaceholder(
    media_id: string,
    name: string,
    auto_add: boolean = true,
    position: THREE.Vector3 = new THREE.Vector3(-0.5, 1.5, 0),
    load_version: number = 1.0,
    signal?: AbortSignal,
  ): Promise<THREE.Object3D> {
    if (this.placeholder_manager === undefined) {
      throw Error("Place holder Manager is undefined");
    }

    const url = await this.getMediaURL(media_id);
    const key = media_id + name + generateUUID();
    await this.placeholder_manager.add(key, `Loading: ${name}`, position);

    // await this.delay(3000); // artificial delay.

    // NB(bt,2025-07-22): This is causing a lot of CORS errors in dev, so I'm starting
    // to funnel everything through Tauri. Not sure if that'll be more inefficient due
    // to spinning up new HTTP clients with new SSL handshakes without caching, but at
    // least it should bypass the cors errors.
    //
    // const glb = await this.load_glb_wrapped(url, async (progress) => {
    //   const total_loaded = progress.loaded / progress.total;
    //   //const percent = this.floatToPercent(total_loaded);
    //   //console.log(`GLB Loading: ${percent}`);
    //
    //   if (total_loaded == 1.0) {
    //     if (this.placeholder_manager === undefined) {
    //       throw Error("Place holder Manager is undefined");
    //     }
    //     //console.log(`GLB Loading: ${total_loaded} === ${key}`);
    //     await this.placeholder_manager.remove(key);
    //   }
    // }).catch((error: Error) => {
    //   throw error;
    // });

    const glb = await this.load_glb_wrapped_no_cors(
      url,
      async () => {
        if (this.placeholder_manager === undefined) {
          throw Error("Place holder Manager is undefined");
        }
        await this.placeholder_manager.remove(key);
      },
      signal,
    ).catch(async (error) => {
      if (this.placeholder_manager !== undefined) {
        await this.placeholder_manager.remove(key);
      }
      // Don't toast aborts — those are us cancelling a superseded load.
      if ((error as { name?: string })?.name !== "AbortError") {
        toast.error("Failed to load 3D asset.");
      }
      throw error;
    });

    let child_result = undefined;
    // Loads the first child
    glb.scene.children.forEach((child) => {
      child.traverse((c: THREE.Object3D) => {
        if (c instanceof THREE.Mesh) {
          c.material.metalness = 0.0;
          c.material.specular = 0.5;
          c.material.shininess = 0.0;
          c.castShadow = true;
          c.receiveShadow = true;
          c.frustumCulled = false;
          c.material.transparent = false;
        }
      });

      child.frustumCulled = false;
      child.userData["media_id"] = media_id;
      child.userData["color"] = "#FFFFFF";
      child.userData["metalness"] = 0.0;
      child.userData["shininess"] = 0.5;
      child.userData["specular"] = 0.5;
      child.userData["locked"] = false;
      child.userData["media_file_type"] = MediaFileType.GLB;

      child.layers.enable(0);
      child.layers.enable(1);
      if (load_version <= 1.0) {
        child_result = child;
        console.log(
          "Loading older model consider resaving to upgrade to newer version of save file. Save Version:",
          load_version,
        );
      }
    });

    if (load_version <= 1.0) {
      glb.scene.name = "Scene";
      glb.scene.userData["name"] = "Scene";
      glb.scene.userData["media_id"] = media_id;
      glb.scene.userData["color"] = "#FFFFFF";
      glb.scene.userData["metalness"] = 0.0;
      glb.scene.userData["shininess"] = 0.5;
      glb.scene.userData["specular"] = 0.5;
      glb.scene.userData["locked"] = false;
    } else if (load_version > 1.0) {
      glb.scene.name = name;
      glb.scene.userData["name"] = name;
      glb.scene.userData["media_id"] = media_id;
      glb.scene.userData["color"] = "#FFFFFF";
      glb.scene.userData["metalness"] = 0.0;
      glb.scene.userData["shininess"] = 0.5;
      glb.scene.userData["specular"] = 0.5;
      glb.scene.userData["locked"] = false;
    }
    glb.scene.userData["media_file_type"] = MediaFileType.GLB;

    if (load_version > 1.0) {
      child_result = glb.scene;
    }

    if (child_result == undefined) {
      throw Error("GLB Did not contain an object or children.");
    }

    child_result.position.copy(position);

    if (auto_add) {
      this.scene.add(child_result);
      if (glb.animations.length > 0) {
        child_result.animations = glb.animations;
      }
      this.deps.onGlbLoaded?.();
    }
    this.updateSurfaceIdAttributeToMesh(this.scene);
    return child_result;
  }

  /**
   * Load a full media_url via Tauri (without browser cors)
   * @param media_url
   * @param onComplete
   * @returns
   */
  // Load a GLB by media id and return the raw GLTF (scene + animations)
  // WITHOUT adding it to the scene or attaching a loading placeholder. Used to
  // source skeletal animation clips (their `animations[0]`) for retargeting
  // onto characters — the clip's own mesh/armature is never rendered.
  async loadRawGlb(
    media_id: string,
    signal?: AbortSignal,
  ): Promise<GLTF | null> {
    try {
      const url = await this.getMediaURL(media_id);
      return await this.load_glb_wrapped_no_cors(url, () => {}, signal);
    } catch (error) {
      if ((error as { name?: string })?.name !== "AbortError") {
        console.error("loadRawGlb failed:", media_id, error);
      }
      return null;
    }
  }

  private async load_glb_wrapped_no_cors(
    media_url: string,
    onComplete: () => void,
    signal?: AbortSignal,
  ): Promise<GLTF> {
    return new Promise<GLTF>(async (resolve, reject) => {
      let buffer;
      try {
        // Host-supplied CORS-bypassed binary fetch (FetchProxy under
        // Tauri; plain fetch under web hosts that allow it).
        buffer = await (
          await this.deps.fetchAsset(media_url, { signal })
        ).arrayBuffer();
      } catch (error) {
        if ((error as { name?: string })?.name !== "AbortError") {
          console.error("load GLB from Tauri error:", error);
        }
        reject(error);
        return;
      }
      const glbLoader = new GLTFLoader();
      glbLoader.parse(
        buffer,
        "", // NB: No relative path to load additional assets!
        (gltf) => {
          resolve(gltf);
          onComplete();
        },
        (error) => {
          console.error("GLTF loader error:", error);
          reject(error);
        },
      );
    });
  }

  /**
   * Using a constructed media_url load a glb, grab the progress.
   * @param media_url
   * @param progress
   * @returns
   */
  private load_glb_wrapped(
    media_url: string,
    progress: (event: ProgressEvent) => void,
  ): Promise<GLTF> {
    return new Promise((resolve, reject) => {
      const glbLoader = new GLTFLoader();
      glbLoader.load(
        media_url,
        (gltf) => {
          resolve(gltf);
        },
        progress,
        (error) => {
          reject(error);
        },
      );
    });
  }

  // default skybox.
  _create_skybox() {
    const loader = new THREE.CubeTextureLoader();
    // Every branch below replaces the background, so free the cube texture
    // being replaced (skybox switches and New Scene used to leak it).
    this.disposeBackground();

    // Theme-aware: in light mode, use a near-white background for better contrast with UI
    try {
      if (
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("theme-light")
      ) {
        this.scene.background = new THREE.Color("#f5f6f8");
        if (this.ambientLight) this.scene.add(this.ambientLight);
        if (this.directional_light) this.scene.remove(this.directional_light);
        if (this.hemisphereLight) this.scene.add(this.hemisphereLight);
        return;
      }
    } catch (_) {
      // no-op: fallback to defaults below
    }

    if (this.skybox == "Default") {
      const texture = loader.load([
        "/resources/skybox/day/px.webp",
        "/resources/skybox/day/nx.webp",
        "/resources/skybox/day/py.webp",
        "/resources/skybox/day/ny.webp",
        "/resources/skybox/day/pz.webp",
        "/resources/skybox/day/nz.webp",
      ]);
      this.scene.background = texture;
      if (this.ambientLight) this.scene.remove(this.ambientLight);
      if (this.directional_light) this.scene.add(this.directional_light);
      if (this.hemisphereLight) this.scene.add(this.hemisphereLight);
    } else if (this.skybox == "m_0") {
      const texture = loader.load([
        "/resources/skybox/night/Night_Moon_Burst_Cam_2_LeftX.webp",
        "/resources/skybox/night/Night_Moon_Burst_Cam_3_Right-X.webp",
        "/resources/skybox/night/Night_Moon_Burst_Cam_4_UpY.webp",
        "/resources/skybox/night/Night_Moon_Burst_Cam_5_Down-Y.webp",
        "/resources/skybox/night/Night_Moon_Burst_Cam_0_FrontZ.webp",
        "/resources/skybox/night/Night_Moon_Burst_Cam_1_Back-Z.webp",
      ]);
      this.scene.background = texture;
      if (this.ambientLight) this.scene.remove(this.ambientLight);
      if (this.directional_light) this.scene.add(this.directional_light);
      if (this.hemisphereLight) this.scene.add(this.hemisphereLight);
    } else if (this.skybox == "m_1") {
      // Empty skybox - just a plain color
      this.scene.background = new THREE.Color("#282828");
      if (this.ambientLight) this.scene.remove(this.ambientLight);
      if (this.directional_light) this.scene.add(this.directional_light);
      if (this.hemisphereLight) this.scene.add(this.hemisphereLight);
    } else if (this.skybox == "m_2") {
      this.scene.background = new THREE.Color("#000000");
      if (this.ambientLight) this.scene.add(this.ambientLight);
      if (this.directional_light) this.scene.remove(this.directional_light);
      if (this.hemisphereLight) this.scene.remove(this.hemisphereLight);
    } else if (this.skybox == "m_3") {
      const texture = loader.load([
        "/resources/skybox/gray/Sky_AllSky_Overcast4_Low_Cam_2_LeftX.webp",
        "/resources/skybox/gray/Sky_AllSky_Overcast4_Low_Cam_3_Right-X.webp",
        "/resources/skybox/gray/Sky_AllSky_Overcast4_Low_Cam_4_UpY.webp",
        "/resources/skybox/gray/Sky_AllSky_Overcast4_Low_Cam_5_Down-Y.webp",
        "/resources/skybox/gray/Sky_AllSky_Overcast4_Low_Cam_0_FrontZ.webp",
        "/resources/skybox/gray/Sky_AllSky_Overcast4_Low_Cam_1_Back-Z.webp",
      ]);
      this.scene.background = texture;
      if (this.ambientLight) this.scene.remove(this.ambientLight);
      if (this.directional_light) this.scene.add(this.directional_light);
      if (this.hemisphereLight) this.scene.add(this.hemisphereLight);
    } else {
      // Default to empty skybox if no match
      this.scene.background = new THREE.Color("#282828");
      if (this.ambientLight) this.scene.remove(this.ambientLight);
      if (this.directional_light) this.scene.add(this.directional_light);
      if (this.hemisphereLight) this.scene.add(this.hemisphereLight);
    }

    console.log("Background creation..");
  }

  updateSkybox(media_id: string) {
    this.skybox = media_id;
    this._create_skybox();
  }

  // deafult image skybox.
  _create_single_skybox() {
    const loader = new THREE.TextureLoader();
    const texture = loader.load("/resources/skybox/single.webp", () => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = texture;
    });
  }

  _create_base_lighting() {
    const color = 0xfcece7;
    this.hemisphereLight = new THREE.HemisphereLight(color, 0x8d8d8d, 3.0);
    this.scene.add(this.hemisphereLight);

    this.ambientLight = new THREE.AmbientLight(new THREE.Color("#ffffff"), 3);

    this.directional_light = new THREE.DirectionalLight(color, 2.0);

    this.directional_light.position.set(5, 10, 3);
    this.directional_light.shadow.mapSize.width = 2048;
    this.directional_light.shadow.mapSize.height = 2048;
    this.directional_light.shadow.map = null;
    this.directional_light.castShadow = false;
    this.directional_light.shadow.bias = 0.00004;
    this.directional_light.userData["media_id"] = "DirectionalLight";

    this.scene.add(this.directional_light);
    this.scene.add(this.directional_light.target);
    return this.directional_light;
  }

  _createGrid() {
    // Create visual infinite grid
    const size1 = 0.5; // Primary grid
    const size2 = 2.5; // Secondary grid
    const color = new THREE.Color(0xffffff);
    const distance = 80;

    this.gridHelper = new InfiniteGridHelper(size1, size2, color, distance);
    this.gridHelper.layers.set(1); // Enable default layer
    this.scene.add(this.gridHelper);

    // Create invisible ground plane for proper object placement
    const planeGeometry = new THREE.PlaneGeometry(300, 300); // Same as original grid size
    const planeMaterial = new THREE.MeshBasicMaterial({
      visible: false,
      side: THREE.DoubleSide,
    });
    this.groundPlane = new THREE.Mesh(planeGeometry, planeMaterial);
    this.groundPlane.rotation.x = -Math.PI / 2;
    this.groundPlane.name = ""; // Empty name to avoid selection
    this.groundPlane.layers.set(0); // Put in layer 0 for placement raycasting
    this.groundPlane.userData["selectable"] = false; // Mark as non-selectable
    this.groundPlane.userData["placementOnly"] = false; // Don't include in interactable list
    this.groundPlane.matrixAutoUpdate = false; // Optimize performance since it never moves
    this.groundPlane.updateMatrix();
    this.groundPlane.receiveShadow = false;
    // Store the original raycast function
    const originalRaycast = this.groundPlane.raycast;
    // Override raycast to only work when the raycaster is checking layer 0
    this.groundPlane.raycast = function (raycaster, intersects) {
      if (raycaster.layers.test(this.layers)) {
        return originalRaycast.call(this, raycaster, intersects);
      }
    };
    this.scene.add(this.groundPlane);
  }

}

// Pausing alone keeps the decoder and buffered media alive; dropping the
// source and reloading is what releases them.
function stopVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

export default Scene;
