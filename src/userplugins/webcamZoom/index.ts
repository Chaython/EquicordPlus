/*
 * Equicord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_SENSITIVITY = 0.0015;
const DRAG_THRESHOLD = 3;
const CLICK_SUPPRESSION_TIME = 500;

const TILE_SELECTOR = "[data-selenium-video-tile]";
const FULLSCREEN_ATTRIBUTE = "data-webcam-zoom-fullscreen";
const FULLSCREEN_VIDEO_ATTRIBUTE = "data-webcam-zoom-fullscreen-video";
const FULLSCREEN_UI_ATTRIBUTE = "data-webcam-zoom-fullscreen-ui";

interface SavedViewState {
    zoom: number;
    panX: number;
    panY: number;
}

interface StyleSnapshot {
    value: string;
    priority: string;
}

interface GeometrySnapshot {
    containerWidth: number;
    containerHeight: number;
    baseWidth: number;
    baseHeight: number;
}

interface ViewState {
    key: string;
    video: HTMLVideoElement;
    container: HTMLElement;
    zoom: number;
    x: number;
    y: number;
    mirroredX: boolean;
    geometry: GeometrySnapshot | null;
    originalTranslate: StyleSnapshot;
    originalScale: StyleSnapshot;
    originalTransformOrigin: StyleSnapshot;
    originalWillChange: StyleSnapshot;
    originalObjectFit: StyleSnapshot;
    originalObjectPosition: StyleSnapshot;
    originalWidth: StyleSnapshot;
    originalHeight: StyleSnapshot;
    originalOverflow: StyleSnapshot;
    originalCursor: StyleSnapshot;
    originalBackground: StyleSnapshot;
}

interface DragState {
    video: HTMLVideoElement;
    key: string;
    pointerId: number;
    captureElement: HTMLElement;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
}

interface VideoContext {
    video: HTMLVideoElement;
    container: HTMLElement;
    fullscreen: boolean;
}

interface FullscreenSession {
    overlay: HTMLDivElement;
    video: HTMLVideoElement;
    sourceVideo: HTMLVideoElement;
    sourceContainer: HTMLElement;
    sourceTileId: string | null;
    sourceStream: MediaStream | null;
    sourceTracks: MediaStreamTrack[];
    sourceSignature: string;
    key: string;
    requestedNativeFullscreen: boolean;
}

const states = new WeakMap<HTMLVideoElement, ViewState>();
const activeVideos = new Set<HTMLVideoElement>();
const savedStates = new Map<string, SavedViewState>();
const suppressedClicks = new Map<string, number>();
const anonymousVideoIds = new WeakMap<HTMLVideoElement, number>();
const pendingApplyVideos = new Set<HTMLVideoElement>();
const pendingTiles = new Set<HTMLElement>();

let nextAnonymousVideoId = 1;
let dragState: DragState | null = null;
let fullscreenSession: FullscreenSession | null = null;
let observer: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let applyFrame: number | null = null;
let tileFrame: number | null = null;
let fullScanFrame: number | null = null;

const settings = definePluginSettings({
    wheelZoom: {
        type: OptionType.BOOLEAN,
        description: "Allow mouse-wheel zooming on webcams",
        default: true
    },
    dragPan: {
        type: OptionType.BOOLEAN,
        description: "Allow click-and-drag panning while a webcam is zoomed",
        default: true
    },
    rememberView: {
        type: OptionType.BOOLEAN,
        description: "Remember zoom and pan when Discord recreates a camera or when switching to/from fullscreen",
        default: true,
        onChange(value) {
            if (!value) savedStates.clear();
        }
    },
    fitAspectRatio: {
        type: OptionType.BOOLEAN,
        description: "Show normal/focused webcams using their real aspect ratio instead of Discord cropping them",
        default: true,
        onChange() {
            for (const video of activeVideos) {
                const state = states.get(video);
                if (!state) continue;
                saveState(state);
                invalidateGeometry(state);
                loadSavedState(state);
                scheduleApply(video);
            }
            scheduleVideoScan();
        }
    },
    customFullscreen: {
        type: OptionType.BOOLEAN,
        description: "Double-click a webcam to open it in a custom fullscreen viewer",
        default: true
    },
    nativeFullscreen: {
        type: OptionType.BOOLEAN,
        description: "Use real system fullscreen for the custom camera viewer when supported",
        default: true
    },
    preventFullscreenWhilePanning: {
        type: OptionType.BOOLEAN,
        description: "Prevent a completed drag/pan from also triggering Discord's camera focus/fullscreen action",
        default: true
    },
    middleClickReset: {
        type: OptionType.BOOLEAN,
        description: "Middle-click a webcam to reset its zoom and pan",
        default: true
    }
});

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function getStyleSnapshot(element: HTMLElement, property: string): StyleSnapshot {
    return {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property)
    };
}

function restoreStyle(element: HTMLElement, property: string, snapshot: StyleSnapshot) {
    if (!snapshot.value) {
        element.style.removeProperty(property);
        return;
    }
    element.style.setProperty(property, snapshot.value, snapshot.priority);
}

function isFullscreenContainer(container: HTMLElement) {
    return container.getAttribute(FULLSCREEN_ATTRIBUTE) === "true";
}

function getDiscordVideoTile(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>(TILE_SELECTOR);
}

function getVisibleVideo(container: HTMLElement): HTMLVideoElement | null {
    const videos = container.querySelectorAll<HTMLVideoElement>("video");
    for (const video of videos) {
        const rect = video.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return video;
    }
    return videos[0] ?? null;
}

function getVideoContext(target: EventTarget | null): VideoContext | null {
    if (!(target instanceof Element)) return null;
    if (target.closest("[" + FULLSCREEN_UI_ATTRIBUTE + "]")) return null;

    const fullscreen = target.closest<HTMLElement>("[" + FULLSCREEN_ATTRIBUTE + "="true"]");
    if (fullscreen) {
        const video = fullscreen.querySelector<HTMLVideoElement>("video[" + FULLSCREEN_VIDEO_ATTRIBUTE + "]");
        return video ? { video, container: fullscreen, fullscreen: true } : null;
    }

    const tile = getDiscordVideoTile(target);
    if (!tile) return null;
    const video = getVisibleVideo(tile);
    return video ? { video, container: tile, fullscreen: false } : null;
}

function getAnonymousVideoId(video: HTMLVideoElement) {
    let id = anonymousVideoIds.get(video);
    if (id === undefined) {
        id = nextAnonymousVideoId++;
        anonymousVideoIds.set(video, id);
    }
    return id;
}

function getVideoKey(video: HTMLVideoElement, container: HTMLElement): string {
    const source = video.srcObject;
    if (source instanceof MediaStream && source.id) return "stream:" + source.id;

    const tile = container.closest<HTMLElement>(TILE_SELECTOR);
    const tileId = tile?.getAttribute("data-selenium-video-tile");
    if (tileId) return "tile:" + tileId;
    if (video.currentSrc) return "src:" + video.currentSrc;
    return "video:" + getAnonymousVideoId(video);
}

function isMirrored(video: HTMLVideoElement) {
    try {
        const transform = getComputedStyle(video).transform;
        if (!transform || transform === "none") return false;
        return new DOMMatrixReadOnly(transform).a < 0;
    } catch {
        return false;
    }
}

function shouldFitAspectRatio(state: ViewState) {
    return isFullscreenContainer(state.container) || settings.store.fitAspectRatio;
}

function applyAspectRatioFit(video: HTMLVideoElement, container: HTMLElement) {
    video.style.setProperty("width", "100%", "important");
    video.style.setProperty("height", "100%", "important");
    video.style.setProperty("object-fit", "contain", "important");
    video.style.setProperty("object-position", "center center", "important");
    container.style.setProperty("background-color", "#000", "important");
}

function restoreAspectRatioStyles(state: ViewState) {
    restoreStyle(state.video, "object-fit", state.originalObjectFit);
    restoreStyle(state.video, "object-position", state.originalObjectPosition);
    restoreStyle(state.video, "width", state.originalWidth);
    restoreStyle(state.video, "height", state.originalHeight);
    restoreStyle(state.container, "background-color", state.originalBackground);
}

function invalidateGeometry(state: ViewState) {
    state.geometry = null;
}

function getGeometry(state: ViewState): GeometrySnapshot {
    if (state.geometry) return state.geometry;

    const rect = state.container.getBoundingClientRect();
    const containerWidth = Math.max(0, rect.width);
    const containerHeight = Math.max(0, rect.height);
    let baseWidth = containerWidth;
    let baseHeight = containerHeight;

    if (shouldFitAspectRatio(state) && state.video.videoWidth > 0 && state.video.videoHeight > 0 && containerWidth > 0 && containerHeight > 0) {
        const videoAspect = state.video.videoWidth / state.video.videoHeight;
        const containerAspect = containerWidth / containerHeight;
        if (videoAspect > containerAspect) {
            baseHeight = containerWidth / videoAspect;
        } else {
            baseWidth = containerHeight * videoAspect;
        }
    }

    state.geometry = { containerWidth, containerHeight, baseWidth, baseHeight };
    return state.geometry;
}

function getPanLimits(state: ViewState) {
    const geometry = getGeometry(state);
    return {
        x: Math.max(0, (geometry.baseWidth * state.zoom - geometry.containerWidth) / 2),
        y: Math.max(0, (geometry.baseHeight * state.zoom - geometry.containerHeight) / 2)
    };
}

function clampPan(state: ViewState, limits = getPanLimits(state)) {
    state.x = clamp(state.x, -limits.x, limits.x);
    state.y = clamp(state.y, -limits.y, limits.y);
    return limits;
}

function saveState(state: ViewState, limits = getPanLimits(state)) {
    if (!settings.store.rememberView) return;
    if (state.zoom <= MIN_ZOOM + 0.001) {
        savedStates.delete(state.key);
        return;
    }

    savedStates.set(state.key, {
        zoom: state.zoom,
        panX: limits.x > 0 ? clamp(state.x / limits.x, -1, 1) : 0,
        panY: limits.y > 0 ? clamp(state.y / limits.y, -1, 1) : 0
    });
}

function loadSavedState(state: ViewState) {
    if (!settings.store.rememberView) return;
    const saved = savedStates.get(state.key);
    if (!saved) return;

    state.zoom = clamp(saved.zoom, MIN_ZOOM, MAX_ZOOM);
    const limits = getPanLimits(state);
    state.x = saved.panX * limits.x;
    state.y = saved.panY * limits.y;
}

function maybeUnobserveContainer(container: HTMLElement) {
    for (const video of activeVideos) {
        if (states.get(video)?.container === container) return;
    }
    resizeObserver?.unobserve(container);
}

function onManagedVideoResize(event: Event) {
    if (!(event.currentTarget instanceof HTMLVideoElement)) return;
    const state = states.get(event.currentTarget);
    if (!state) return;

    saveState(state);
    invalidateGeometry(state);
    loadSavedState(state);
    state.mirroredX = isMirrored(state.video);
    scheduleApply(state.video);

    if (fullscreenSession?.sourceVideo === state.video) syncFullscreenMedia(fullscreenSession);
}

function createState(video: HTMLVideoElement, container: HTMLElement, key: string): ViewState {
    const state: ViewState = {
        key,
        video,
        container,
        zoom: MIN_ZOOM,
        x: 0,
        y: 0,
        mirroredX: isMirrored(video),
        geometry: null,
        originalTranslate: getStyleSnapshot(video, "translate"),
        originalScale: getStyleSnapshot(video, "scale"),
        originalTransformOrigin: getStyleSnapshot(video, "transform-origin"),
        originalWillChange: getStyleSnapshot(video, "will-change"),
        originalObjectFit: getStyleSnapshot(video, "object-fit"),
        originalObjectPosition: getStyleSnapshot(video, "object-position"),
        originalWidth: getStyleSnapshot(video, "width"),
        originalHeight: getStyleSnapshot(video, "height"),
        originalOverflow: getStyleSnapshot(container, "overflow"),
        originalCursor: getStyleSnapshot(container, "cursor"),
        originalBackground: getStyleSnapshot(container, "background-color")
    };

    states.set(video, state);
    activeVideos.add(video);
    video.addEventListener("resize", onManagedVideoResize);
    resizeObserver?.observe(container);
    loadSavedState(state);
    return state;
}

function restoreElement(video: HTMLVideoElement, state: ViewState) {
    video.removeEventListener("resize", onManagedVideoResize);
    pendingApplyVideos.delete(video);

    restoreStyle(video, "translate", state.originalTranslate);
    restoreStyle(video, "scale", state.originalScale);
    restoreStyle(video, "transform-origin", state.originalTransformOrigin);
    restoreStyle(video, "will-change", state.originalWillChange);
    restoreStyle(video, "object-fit", state.originalObjectFit);
    restoreStyle(video, "object-position", state.originalObjectPosition);
    restoreStyle(video, "width", state.originalWidth);
    restoreStyle(video, "height", state.originalHeight);
    restoreStyle(state.container, "overflow", state.originalOverflow);
    restoreStyle(state.container, "cursor", state.originalCursor);
    restoreStyle(state.container, "background-color", state.originalBackground);

    states.delete(video);
    activeVideos.delete(video);
    if (dragState?.video === video) finishDrag(undefined, true);
    maybeUnobserveContainer(state.container);
}

function getState(video: HTMLVideoElement, container: HTMLElement) {
    const key = getVideoKey(video, container);
    const current = states.get(video);

    if (current && (current.container !== container || current.key !== key)) {
        saveState(current);
        restoreElement(video, current);
    }

    const state = states.get(video) ?? createState(video, container, key);
    state.mirroredX = isMirrored(video);
    return state;
}

function applyNow(video: HTMLVideoElement, state: ViewState) {
    if (shouldFitAspectRatio(state)) applyAspectRatioFit(video, state.container);
    else restoreAspectRatioStyles(state);

    const limits = clampPan(state);
    const transformed = state.zoom > MIN_ZOOM + 0.001;
    const dragging = dragState?.video === video;

    if (transformed) {
        const translateX = state.mirroredX ? -state.x : state.x;
        video.style.setProperty("translate", String(translateX) + "px " + String(state.y) + "px", "important");
        video.style.setProperty("scale", String(state.zoom), "important");
        video.style.setProperty("transform-origin", "center center", "important");
    } else {
        state.x = 0;
        state.y = 0;
        restoreStyle(video, "translate", state.originalTranslate);
        restoreStyle(video, "scale", state.originalScale);
        restoreStyle(video, "transform-origin", state.originalTransformOrigin);
    }

    if (transformed || dragging) video.style.setProperty("will-change", "translate, scale", "important");
    else restoreStyle(video, "will-change", state.originalWillChange);

    if (transformed || isFullscreenContainer(state.container)) {
        state.container.style.setProperty("overflow", "hidden", "important");
    } else {
        restoreStyle(state.container, "overflow", state.originalOverflow);
    }

    if (settings.store.dragPan && transformed) {
        state.container.style.setProperty("cursor", dragging ? "grabbing" : "grab", "important");
    } else {
        restoreStyle(state.container, "cursor", state.originalCursor);
    }

    saveState(state, limits);
}

function flushApplyQueue() {
    applyFrame = null;
    const videos = [...pendingApplyVideos];
    pendingApplyVideos.clear();

    for (const video of videos) {
        const state = states.get(video);
        if (!state || !video.isConnected || !state.container.isConnected) continue;
        applyNow(video, state);
    }
}

function scheduleApply(video: HTMLVideoElement) {
    pendingApplyVideos.add(video);
    if (applyFrame === null) applyFrame = requestAnimationFrame(flushApplyQueue);
}

function resetKey(key: string) {
    savedStates.delete(key);
    for (const video of activeVideos) {
        const state = states.get(video);
        if (!state || state.key !== key) continue;
        state.zoom = MIN_ZOOM;
        state.x = 0;
        state.y = 0;
        scheduleApply(video);
    }
}

function resetVideo(video: HTMLVideoElement, container: HTMLElement) {
    resetKey(states.get(video)?.key ?? getVideoKey(video, container));
}

function syncStatesForKey(key: string, except?: HTMLVideoElement) {
    if (!settings.store.rememberView) return;
    const saved = savedStates.get(key);

    for (const video of activeVideos) {
        if (video === except) continue;
        const state = states.get(video);
        if (!state || state.key !== key) continue;

        if (!saved) {
            state.zoom = MIN_ZOOM;
            state.x = 0;
            state.y = 0;
        } else {
            state.zoom = saved.zoom;
            invalidateGeometry(state);
            const limits = getPanLimits(state);
            state.x = saved.panX * limits.x;
            state.y = saved.panY * limits.y;
        }
        scheduleApply(video);
    }
}

function pruneDisconnectedVideos() {
    for (const video of [...activeVideos]) {
        const state = states.get(video);
        if (!state) {
            activeVideos.delete(video);
            continue;
        }
        if (video.isConnected && state.container.isConnected) continue;
        saveState(state);
        restoreElement(video, state);
    }
}

function syncFullscreenSourceFromTile(video: HTMLVideoElement, container: HTMLElement, state: ViewState) {
    const session = fullscreenSession;
    if (!session) return;

    const tileId = container.getAttribute("data-selenium-video-tile");
    const matches = session.sourceContainer === container || state.key === session.key || (!!tileId && tileId === session.sourceTileId);
    if (!matches) return;

    if (state.key !== session.key) {
        const saved = savedStates.get(session.key);
        if (saved && !savedStates.has(state.key)) savedStates.set(state.key, saved);
        const fullscreenState = states.get(session.video);
        if (fullscreenState) fullscreenState.key = state.key;
        session.key = state.key;
    }

    session.sourceVideo = video;
    session.sourceContainer = container;
    session.sourceTileId = tileId;
    syncFullscreenMedia(session);
}

function processTile(tile: HTMLElement) {
    if (!tile.isConnected) return;
    const visible = getVisibleVideo(tile);

    for (const video of [...activeVideos]) {
        const state = states.get(video);
        if (!state || state.container !== tile || video === visible) continue;
        saveState(state);
        restoreElement(video, state);
    }

    if (!visible || visible.hasAttribute(FULLSCREEN_VIDEO_ATTRIBUTE)) return;
    const state = getState(visible, tile);
    invalidateGeometry(state);
    state.mirroredX = isMirrored(visible);
    scheduleApply(visible);
    syncFullscreenSourceFromTile(visible, tile, state);
}

function queueTile(tile: HTMLElement) {
    pendingTiles.add(tile);
    if (tileFrame === null) tileFrame = requestAnimationFrame(flushPendingTiles);
}

function queueTilesFromNode(node: Node) {
    if (!(node instanceof Element)) return;

    const closest = node.matches(TILE_SELECTOR) ? node as HTMLElement : node.closest<HTMLElement>(TILE_SELECTOR);
    if (closest) pendingTiles.add(closest);
    node.querySelectorAll<HTMLElement>(TILE_SELECTOR).forEach(tile => pendingTiles.add(tile));

    if (pendingTiles.size && tileFrame === null) tileFrame = requestAnimationFrame(flushPendingTiles);
}

function flushPendingTiles() {
    tileFrame = null;
    pruneDisconnectedVideos();
    const tiles = [...pendingTiles];
    pendingTiles.clear();
    for (const tile of tiles) processTile(tile);
}

function scanVideos() {
    fullScanFrame = null;
    pruneDisconnectedVideos();
    document.querySelectorAll<HTMLElement>(TILE_SELECTOR).forEach(processTile);
}

function scheduleVideoScan() {
    if (fullScanFrame === null) fullScanFrame = requestAnimationFrame(scanVideos);
}

function onMutations(mutations: MutationRecord[]) {
    let sawRemoval = false;
    for (const mutation of mutations) {
        if (mutation.removedNodes.length) sawRemoval = true;
        mutation.addedNodes.forEach(queueTilesFromNode);
        if (mutation.target instanceof Element) {
            const tile = mutation.target.closest<HTMLElement>(TILE_SELECTOR);
            if (tile) pendingTiles.add(tile);
        }
    }

    if ((sawRemoval || pendingTiles.size) && tileFrame === null) tileFrame = requestAnimationFrame(flushPendingTiles);
}

function onContainerResize(entries: ResizeObserverEntry[]) {
    for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue;
        for (const video of activeVideos) {
            const state = states.get(video);
            if (!state || state.container !== entry.target) continue;
            saveState(state);
            invalidateGeometry(state);
            loadSavedState(state);
            scheduleApply(video);
        }
    }
}

function makeFullscreenButton(text: string, title: string) {
    const button = document.createElement("button");
    button.textContent = text;
    button.title = title;
    button.setAttribute(FULLSCREEN_UI_ATTRIBUTE, "true");
    button.style.position = "absolute";
    button.style.top = "18px";
    button.style.right = "18px";
    button.style.zIndex = "10";
    button.style.width = "44px";
    button.style.height = "44px";
    button.style.border = "none";
    button.style.borderRadius = "50%";
    button.style.background = "rgba(0, 0, 0, 0.65)";
    button.style.color = "#fff";
    button.style.fontSize = "28px";
    button.style.lineHeight = "40px";
    button.style.cursor = "pointer";
    button.style.fontFamily = "sans-serif";
    return button;
}

function createFullscreenHint() {
    const hint = document.createElement("div");
    hint.setAttribute(FULLSCREEN_UI_ATTRIBUTE, "true");
    hint.textContent = "Double-click or Esc to exit  •  Wheel to zoom  •  Drag to pan";
    hint.style.position = "absolute";
    hint.style.left = "50%";
    hint.style.bottom = "22px";
    hint.style.transform = "translateX(-50%)";
    hint.style.zIndex = "10";
    hint.style.pointerEvents = "none";
    hint.style.padding = "8px 12px";
    hint.style.borderRadius = "8px";
    hint.style.background = "rgba(0, 0, 0, 0.55)";
    hint.style.color = "#fff";
    hint.style.fontFamily = "sans-serif";
    hint.style.fontSize = "13px";
    hint.style.whiteSpace = "nowrap";
    hint.style.userSelect = "none";
    return hint;
}

function getVideoTrackSignature(stream: MediaStream) {
    return stream.getVideoTracks().map(track => track.id + ":" + track.readyState).join("|");
}

function onFullscreenStreamChanged() {
    if (fullscreenSession) syncFullscreenMedia(fullscreenSession);
}

function bindFullscreenTracks(session: FullscreenSession, tracks: MediaStreamTrack[]) {
    for (const track of session.sourceTracks) track.removeEventListener("ended", onFullscreenStreamChanged);
    session.sourceTracks = tracks;
    for (const track of tracks) track.addEventListener("ended", onFullscreenStreamChanged);
}

function bindFullscreenStream(session: FullscreenSession, stream: MediaStream | null) {
    if (session.sourceStream === stream) return;
    session.sourceStream?.removeEventListener("addtrack", onFullscreenStreamChanged);
    session.sourceStream?.removeEventListener("removetrack", onFullscreenStreamChanged);
    session.sourceStream = stream;
    stream?.addEventListener("addtrack", onFullscreenStreamChanged);
    stream?.addEventListener("removetrack", onFullscreenStreamChanged);
}

function syncFullscreenMedia(session: FullscreenSession) {
    if (fullscreenSession !== session) return;
    const source = session.sourceVideo.srcObject;

    if (source instanceof MediaStream) {
        bindFullscreenStream(session, source);
        const tracks = source.getVideoTracks();
        bindFullscreenTracks(session, tracks);
        const signature = getVideoTrackSignature(source);
        if (signature !== session.sourceSignature || !(session.video.srcObject instanceof MediaStream)) {
            session.sourceSignature = signature;
            session.video.removeAttribute("src");
            session.video.srcObject = new MediaStream(tracks);
            void session.video.play().catch(() => {});
        }
        return;
    }

    bindFullscreenStream(session, null);
    bindFullscreenTracks(session, []);
    const src = session.sourceVideo.currentSrc;
    const signature = src ? "src:" + src : "";
    if (signature === session.sourceSignature) return;

    session.sourceSignature = signature;
    session.video.srcObject = null;
    if (src) {
        session.video.src = src;
        void session.video.play().catch(() => {});
    } else {
        session.video.removeAttribute("src");
    }
}

function openCustomFullscreen(sourceVideo: HTMLVideoElement, sourceContainer: HTMLElement) {
    if (!settings.store.customFullscreen) return;
    closeCustomFullscreen();

    const sourceState = getState(sourceVideo, sourceContainer);
    saveState(sourceState);

    const overlay = document.createElement("div");
    overlay.setAttribute(FULLSCREEN_ATTRIBUTE, "true");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "2147483647";
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.background = "#000";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.overflow = "hidden";
    overlay.style.userSelect = "none";
    overlay.style.touchAction = "none";

    const video = document.createElement("video");
    video.setAttribute(FULLSCREEN_VIDEO_ATTRIBUTE, "true");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
    video.disablePictureInPicture = true;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "contain";
    video.style.objectPosition = "center center";
    video.style.background = "#000";
    if (sourceState.mirroredX) video.style.transform = "scaleX(-1)";

    const closeButton = makeFullscreenButton("×", "Close fullscreen");
    closeButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        closeCustomFullscreen();
    });

    overlay.append(video, closeButton, createFullscreenHint());
    document.body.append(overlay);

    const state = createState(video, overlay, sourceState.key);
    if (!settings.store.rememberView) {
        state.zoom = MIN_ZOOM;
        state.x = 0;
        state.y = 0;
    }

    fullscreenSession = {
        overlay,
        video,
        sourceVideo,
        sourceContainer,
        sourceTileId: sourceContainer.getAttribute("data-selenium-video-tile"),
        sourceStream: null,
        sourceTracks: [],
        sourceSignature: "",
        key: sourceState.key,
        requestedNativeFullscreen: false
    };

    syncFullscreenMedia(fullscreenSession);
    applyNow(video, state);

    if (settings.store.nativeFullscreen && typeof overlay.requestFullscreen === "function") {
        fullscreenSession.requestedNativeFullscreen = true;
        const session = fullscreenSession;
        void overlay.requestFullscreen().catch(() => {
            if (fullscreenSession === session) session.requestedNativeFullscreen = false;
        });
    }
}

function closeCustomFullscreen() {
    const session = fullscreenSession;
    if (!session) return;
    fullscreenSession = null;

    bindFullscreenStream(session, null);
    bindFullscreenTracks(session, []);
    const state = states.get(session.video);
    if (state) {
        saveState(state);
        restoreElement(session.video, state);
    }

    if (document.fullscreenElement === session.overlay && typeof document.exitFullscreen === "function") {
        void document.exitFullscreen().catch(() => {});
    }

    session.video.pause();
    session.video.srcObject = null;
    session.video.removeAttribute("src");
    session.overlay.remove();
    syncStatesForKey(session.key);
    scheduleVideoScan();
}

function onFullscreenChange() {
    const session = fullscreenSession;
    if (!session || !session.requestedNativeFullscreen) return;
    if (document.fullscreenElement !== session.overlay) closeCustomFullscreen();
}

function normalizedWheelDelta(event: WheelEvent) {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * Math.max(1, window.innerHeight);
    return event.deltaY;
}

function onWheel(event: WheelEvent) {
    if (!settings.store.wheelZoom || event.defaultPrevented || event.ctrlKey) return;
    const context = getVideoContext(event.target);
    if (!context) return;

    const state = getState(context.video, context.container);
    const oldZoom = state.zoom;
    const newZoom = clamp(oldZoom * Math.exp(-normalizedWheelDelta(event) * ZOOM_SENSITIVITY), MIN_ZOOM, MAX_ZOOM);

    if (oldZoom <= MIN_ZOOM + 0.001 && newZoom <= MIN_ZOOM + 0.001) return;
    event.preventDefault();

    const geometry = getGeometry(state);
    const rect = context.container.getBoundingClientRect();
    const pointerX = event.clientX - (rect.left + geometry.containerWidth / 2);
    const pointerY = event.clientY - (rect.top + geometry.containerHeight / 2);
    const ratio = newZoom / oldZoom;

    state.x = pointerX - (pointerX - state.x) * ratio;
    state.y = pointerY - (pointerY - state.y) * ratio;
    state.zoom = newZoom;

    if (state.zoom <= MIN_ZOOM + 0.001) {
        state.zoom = MIN_ZOOM;
        state.x = 0;
        state.y = 0;
        savedStates.delete(state.key);
    }

    scheduleApply(context.video);
}

function detachDragListeners(drag: DragState) {
    drag.captureElement.removeEventListener("pointermove", onPointerMove);
    drag.captureElement.removeEventListener("pointerup", onPointerUp);
    drag.captureElement.removeEventListener("pointercancel", onPointerCancel);
    drag.captureElement.removeEventListener("lostpointercapture", onLostPointerCapture);
}

function finishDrag(event?: PointerEvent, cancelled = false) {
    const currentDrag = dragState;
    if (!currentDrag) return;
    dragState = null;
    detachDragListeners(currentDrag);

    try {
        if (currentDrag.captureElement.hasPointerCapture(currentDrag.pointerId)) {
            currentDrag.captureElement.releasePointerCapture(currentDrag.pointerId);
        }
    } catch {}

    if (currentDrag.moved && !cancelled && settings.store.preventFullscreenWhilePanning) {
        suppressedClicks.set(currentDrag.key, Date.now() + CLICK_SUPPRESSION_TIME);
        event?.preventDefault();
    }

    const state = states.get(currentDrag.video);
    if (state) scheduleApply(currentDrag.video);
}

function onPointerDown(event: PointerEvent) {
    if (!settings.store.dragPan || event.defaultPrevented || event.button !== 0 || !event.isPrimary) return;
    const context = getVideoContext(event.target);
    if (!context) return;

    const state = getState(context.video, context.container);
    if (state.zoom <= MIN_ZOOM) return;

    dragState = {
        video: context.video,
        key: state.key,
        pointerId: event.pointerId,
        captureElement: context.container,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false
    };

    event.preventDefault();
    try {
        context.container.setPointerCapture(event.pointerId);
    } catch {}

    context.container.addEventListener("pointermove", onPointerMove);
    context.container.addEventListener("pointerup", onPointerUp);
    context.container.addEventListener("pointercancel", onPointerCancel);
    context.container.addEventListener("lostpointercapture", onLostPointerCapture);
    scheduleApply(context.video);
}

function onPointerMove(event: PointerEvent) {
    const currentDrag = dragState;
    if (!settings.store.dragPan || !currentDrag || event.pointerId !== currentDrag.pointerId) return;

    const state = states.get(currentDrag.video);
    if (!state) {
        finishDrag(event, true);
        return;
    }

    const totalX = event.clientX - currentDrag.startX;
    const totalY = event.clientY - currentDrag.startY;
    if (!currentDrag.moved && Math.hypot(totalX, totalY) >= DRAG_THRESHOLD) currentDrag.moved = true;
    if (!currentDrag.moved) return;

    event.preventDefault();
    state.x += event.clientX - currentDrag.lastX;
    state.y += event.clientY - currentDrag.lastY;
    currentDrag.lastX = event.clientX;
    currentDrag.lastY = event.clientY;
    scheduleApply(currentDrag.video);
}

function onPointerUp(event: PointerEvent) {
    if (dragState && event.pointerId === dragState.pointerId) finishDrag(event, false);
}

function onPointerCancel(event: PointerEvent) {
    if (dragState && event.pointerId === dragState.pointerId) finishDrag(event, true);
}

function onLostPointerCapture(event: PointerEvent) {
    if (dragState && event.pointerId === dragState.pointerId) finishDrag(event, true);
}

function shouldSuppressClick(event: MouseEvent) {
    if (!settings.store.preventFullscreenWhilePanning) return false;
    const context = getVideoContext(event.target);
    if (!context) return false;

    const key = getVideoKey(context.video, context.container);
    const until = suppressedClicks.get(key);
    if (!until) return false;

    suppressedClicks.delete(key);
    return Date.now() <= until;
}

function suppressEvent(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function onClickCapture(event: MouseEvent) {
    if (shouldSuppressClick(event)) suppressEvent(event);
}

function onDoubleClickCapture(event: MouseEvent) {
    if (shouldSuppressClick(event)) {
        suppressEvent(event);
        return;
    }
    if (!settings.store.customFullscreen || !(event.target instanceof Element)) return;

    const fullscreen = event.target.closest<HTMLElement>("[" + FULLSCREEN_ATTRIBUTE + "="true"]");
    if (fullscreen) {
        if (event.target.closest("[" + FULLSCREEN_UI_ATTRIBUTE + "]")) return;
        suppressEvent(event);
        closeCustomFullscreen();
        return;
    }

    const context = getVideoContext(event.target);
    if (!context || context.fullscreen) return;
    suppressEvent(event);
    openCustomFullscreen(context.video, context.container);
}

function onAuxClick(event: MouseEvent) {
    if (!settings.store.middleClickReset || event.button !== 1) return;
    const context = getVideoContext(event.target);
    if (!context) return;
    const state = states.get(context.video);
    if (!state || state.zoom <= MIN_ZOOM) return;
    event.preventDefault();
    resetVideo(context.video, context.container);
}

function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !fullscreenSession) return;
    event.preventDefault();
    event.stopPropagation();
    closeCustomFullscreen();
}

function onWindowBlur() {
    if (dragState) finishDrag(undefined, true);
}

function onVideoSourceEvent(event: Event) {
    if (!(event.target instanceof HTMLVideoElement)) return;
    const video = event.target;
    if (fullscreenSession?.sourceVideo === video) syncFullscreenMedia(fullscreenSession);
}

function onLoadedMetadata(event: Event) {
    if (!(event.target instanceof HTMLVideoElement)) return;
    const video = event.target;

    onVideoSourceEvent(event);

    if (video.hasAttribute(FULLSCREEN_VIDEO_ATTRIBUTE)) {
        const state = states.get(video);
        if (!state) return;
        saveState(state);
        invalidateGeometry(state);
        loadSavedState(state);
        scheduleApply(video);
        return;
    }

    const tile = video.closest<HTMLElement>(TILE_SELECTOR);
    if (tile) queueTile(tile);
}

export default definePlugin({
    name: "WebcamZoom",
    description: "Adds aspect-correct webcams, mouse-wheel zoom, drag panning and true fullscreen camera viewing.",
    authors: [{ name: "Chaython", id: 1415804298771824740n }],
    tags: ["Voice", "Media"],
    settings,

    start() {
        document.addEventListener("wheel", onWheel, { passive: false });
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("click", onClickCapture, true);
        document.addEventListener("dblclick", onDoubleClickCapture, true);
        document.addEventListener("auxclick", onAuxClick);
        document.addEventListener("loadedmetadata", onLoadedMetadata, true);
        document.addEventListener("loadeddata", onVideoSourceEvent, true);
        document.addEventListener("emptied", onVideoSourceEvent, true);
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("fullscreenchange", onFullscreenChange);
        window.addEventListener("blur", onWindowBlur);

        resizeObserver = new ResizeObserver(onContainerResize);
        observer = new MutationObserver(onMutations);
        observer.observe(document.body, { childList: true, subtree: true });
        scheduleVideoScan();
    },

    stop() {
        closeCustomFullscreen();
        finishDrag(undefined, true);

        document.removeEventListener("wheel", onWheel);
        document.removeEventListener("pointerdown", onPointerDown);
        document.removeEventListener("click", onClickCapture, true);
        document.removeEventListener("dblclick", onDoubleClickCapture, true);
        document.removeEventListener("auxclick", onAuxClick);
        document.removeEventListener("loadedmetadata", onLoadedMetadata, true);
        document.removeEventListener("loadeddata", onVideoSourceEvent, true);
        document.removeEventListener("emptied", onVideoSourceEvent, true);
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("fullscreenchange", onFullscreenChange);
        window.removeEventListener("blur", onWindowBlur);

        observer?.disconnect();
        observer = null;
        resizeObserver?.disconnect();
        resizeObserver = null;

        if (applyFrame !== null) cancelAnimationFrame(applyFrame);
        if (tileFrame !== null) cancelAnimationFrame(tileFrame);
        if (fullScanFrame !== null) cancelAnimationFrame(fullScanFrame);
        applyFrame = null;
        tileFrame = null;
        fullScanFrame = null;
        pendingApplyVideos.clear();
        pendingTiles.clear();
        suppressedClicks.clear();
        savedStates.clear();

        for (const video of [...activeVideos]) {
            const state = states.get(video);
            if (state) restoreElement(video, state);
        }
    }
});
