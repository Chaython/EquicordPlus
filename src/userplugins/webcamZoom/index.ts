/*
 * Equicord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addGlobalContextMenuPatch, GlobalContextMenuPatchCallback, removeGlobalContextMenuPatch } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Menu, React, UserStore } from "@webpack/common";

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_SENSITIVITY = 0.0015;
const DRAG_THRESHOLD = 3;
const CLICK_SUPPRESSION_TIME = 500;

const TILE_SELECTOR = "[data-selenium-video-tile]";
const FULLSCREEN_ATTRIBUTE = "data-webcam-zoom-fullscreen";
const FULLSCREEN_VIDEO_ATTRIBUTE = "data-webcam-zoom-fullscreen-video";
const FULLSCREEN_UI_ATTRIBUTE = "data-webcam-zoom-fullscreen-ui";

const TILE_ID_ATTRIBUTE = "data-selenium-video-tile";
const POPOUT_UI_ATTRIBUTE = "data-webcam-zoom-popout-ui";
const POPOUT_MIN_WIDTH = 200;
const POPOUT_MIN_HEIGHT = 120;
const POPOUT_DEFAULT_WIDTH = 360;
// Discord's own layers (context menus, tooltips, modals) sit at ~1002, so the pop-outs stay just below them.
const POPOUT_Z_INDEX = 1000;
const HOVER_BUTTON_Z_INDEX = 999;
const HOVER_BUTTON_SIZE = 30;
const HOVER_BUTTON_MARGIN = 8;
const HOVER_MIN_TILE_WIDTH = 140;
const HOVER_MIN_TILE_HEIGHT = 80;
const POPOUT_SYNC_INTERVAL = 500;

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
    stylesApplied: boolean;
    sourceStream: MediaStream | null;
    sourceTracks: MediaStreamTrack[];
    sourceSignature: string;
    originalTranslate: StyleSnapshot;
    originalScale: StyleSnapshot;
    originalTransformOrigin: StyleSnapshot;
    originalWillChange: StyleSnapshot;
    originalObjectFit: StyleSnapshot;
    originalObjectPosition: StyleSnapshot;
    originalWidth: StyleSnapshot;
    originalHeight: StyleSnapshot;
    originalPosition: StyleSnapshot;
    originalLeft: StyleSnapshot;
    originalTop: StyleSnapshot;
    originalMarginLeft: StyleSnapshot;
    originalMarginTop: StyleSnapshot;
    originalMaxWidth: StyleSnapshot;
    originalMaxHeight: StyleSnapshot;
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
    stretchZoom: {
        type: OptionType.BOOLEAN,
        description: "Allow zooming to stretch a camera into its black bars before continuing to crop/zoom",
        default: true,
        onChange() {
            for (const video of activeVideos) {
                const state = states.get(video);
                if (!state) continue;
                invalidateGeometry(state);
                clampPan(state);
                scheduleApply(video);
            }
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
    },
    cameraPopout: {
        type: OptionType.BOOLEAN,
        description: "Allow popping a single camera out into its own freely resizable window (hover button and right-click / \"...\" menu)",
        default: true,
        onChange(value) {
            if (!value) hideHoverButton();
        }
    },
    popoutHoverButton: {
        type: OptionType.BOOLEAN,
        description: "Show a pop-out button when hovering over a camera tile",
        default: true,
        onChange() {
            hideHoverButton();
        }
    },
    popoutButtonCorner: {
        type: OptionType.SELECT,
        description: "Which corner of a camera tile the hover pop-out button appears in",
        options: [
            { label: "Top left", value: "top-left", default: true },
            { label: "Top right", value: "top-right" },
            { label: "Bottom right", value: "bottom-right" }
        ],
        onChange() {
            hideHoverButton();
        }
    },
    popoutFit: {
        type: OptionType.SELECT,
        description: "How the picture fills a new camera pop-out (switchable per window with the button in its title bar)",
        options: [
            { label: "Stretch to fill the window", value: "fill", default: true },
            { label: "Fit (keep aspect ratio, black bars)", value: "contain" },
            { label: "Crop to fill (keep aspect ratio)", value: "cover" }
        ]
    },
    popoutWidth: {
        type: OptionType.NUMBER,
        description: "Starting width of a new camera pop-out, in pixels (height follows the camera's aspect ratio)",
        default: POPOUT_DEFAULT_WIDTH
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

function isRenderableVideo(video: HTMLVideoElement): boolean {
    // Discord can retain the old video's geometry while swapping its stream.
    if (video.readyState < HTMLMediaElement.HAVE_METADATA || video.videoWidth <= 0 || video.videoHeight <= 0) return false;
    const source = video.srcObject;
    if (source instanceof MediaStream) return source.getVideoTracks().some(track => track.readyState === "live");
    return !!source || !!video.currentSrc;
}

function getVisibleVideo(container: HTMLElement): HTMLVideoElement | null {
    let best: HTMLVideoElement | null = null;
    let bestScore = -Infinity;

    // During a camera switch Discord may temporarily retain the old video
    // alongside the new one. Prefer visible, live, decoded media and, on
    // equal scores, the newer element.
    for (const video of container.querySelectorAll<HTMLVideoElement>("video")) {
        const rect = video.getBoundingClientRect();
        const style = getComputedStyle(video);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        const source = video.srcObject;
        const tracks = source instanceof MediaStream ? source.getVideoTracks() : [];
        const live = tracks.some(track => track.readyState === "live");
        const ended = tracks.length > 0 && !live;
        const score = (visible ? 16 : 0) + (live ? 16 : 0) + (isRenderableVideo(video) ? 8 : 0)
            + (source || video.currentSrc ? 2 : 0) - (ended ? 64 : 0);
        if (score >= bestScore) {
            bestScore = score;
            best = video;
        }
    }
    return best;
}

function getVideoContext(target: EventTarget | null): VideoContext | null {
    if (!(target instanceof Element)) return null;
    if (target.closest("[" + FULLSCREEN_UI_ATTRIBUTE + "]")) return null;

    const fullscreen = target.closest<HTMLElement>("[" + FULLSCREEN_ATTRIBUTE + "=\\\"true\\\"]");
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

function applyAspectRatioFit(state: ViewState) {
    const { video, container } = state;
    const geometry = getGeometry(state);

    // Give the <video> itself the aspect-correct rendered size instead of
    // leaving it at 100% with object-fit: contain. That removes the internal
    // letterbox/pillarbox area from the element, allowing independent X/Y
    // scaling to actually stretch the camera image into the black bars.
    video.style.setProperty("position", "absolute", "important");
    video.style.setProperty("left", "50%", "important");
    video.style.setProperty("top", "50%", "important");
    video.style.setProperty("width", String(geometry.baseWidth) + "px", "important");
    video.style.setProperty("height", String(geometry.baseHeight) + "px", "important");
    video.style.setProperty("margin-left", String(-geometry.baseWidth / 2) + "px", "important");
    video.style.setProperty("margin-top", String(-geometry.baseHeight / 2) + "px", "important");
    video.style.setProperty("max-width", "none", "important");
    video.style.setProperty("max-height", "none", "important");
    video.style.setProperty("object-fit", "fill", "important");
    video.style.setProperty("object-position", "center center", "important");
    container.style.setProperty("background-color", "#000", "important");
}

function restoreAspectRatioStyles(state: ViewState) {
    restoreStyle(state.video, "object-fit", state.originalObjectFit);
    restoreStyle(state.video, "object-position", state.originalObjectPosition);
    restoreStyle(state.video, "width", state.originalWidth);
    restoreStyle(state.video, "height", state.originalHeight);
    restoreStyle(state.video, "position", state.originalPosition);
    restoreStyle(state.video, "left", state.originalLeft);
    restoreStyle(state.video, "top", state.originalTop);
    restoreStyle(state.video, "margin-left", state.originalMarginLeft);
    restoreStyle(state.video, "margin-top", state.originalMarginTop);
    restoreStyle(state.video, "max-width", state.originalMaxWidth);
    restoreStyle(state.video, "max-height", state.originalMaxHeight);
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

function getZoomScales(state: ViewState, zoom = state.zoom) {
    if (!settings.store.stretchZoom || !shouldFitAspectRatio(state)) {
        return { x: zoom, y: zoom };
    }

    const geometry = getGeometry(state);
    if (geometry.baseWidth <= 0 || geometry.baseHeight <= 0) {
        return { x: zoom, y: zoom };
    }

    const fillX = Math.max(1, geometry.containerWidth / geometry.baseWidth);
    const fillY = Math.max(1, geometry.containerHeight / geometry.baseHeight);
    const fillZoom = Math.max(fillX, fillY);

    if (fillZoom <= MIN_ZOOM + 0.001) {
        return { x: zoom, y: zoom };
    }

    if (zoom <= fillZoom) {
        return {
            x: Math.min(zoom, fillX),
            y: Math.min(zoom, fillY)
        };
    }

    const extraZoom = zoom / fillZoom;
    return {
        x: fillX * extraZoom,
        y: fillY * extraZoom
    };
}

function getPanLimits(state: ViewState) {
    const geometry = getGeometry(state);
    const scale = getZoomScales(state);
    return {
        x: Math.max(0, (geometry.baseWidth * scale.x - geometry.containerWidth) / 2),
        y: Math.max(0, (geometry.baseHeight * scale.y - geometry.containerHeight) / 2)
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

function onManagedTrackChange(event: Event) {
    for (const video of activeVideos) {
        const state = states.get(video);
        if (!state || (state.sourceStream !== event.target && !state.sourceTracks.includes(event.target as MediaStreamTrack))) continue;
        invalidateGeometry(state);
        queueTile(state.container);
    }
}

function releaseManagedTracks(state: ViewState) {
    state.sourceStream?.removeEventListener("addtrack", onManagedTrackChange);
    state.sourceStream?.removeEventListener("removetrack", onManagedTrackChange);
    for (const track of state.sourceTracks) {
        track.removeEventListener("ended", onManagedTrackChange);
        track.removeEventListener("mute", onManagedTrackChange);
        track.removeEventListener("unmute", onManagedTrackChange);
    }
    state.sourceStream = null;
    state.sourceTracks = [];
}

function refreshManagedTracks(state: ViewState) {
    const stream = state.video.srcObject instanceof MediaStream ? state.video.srcObject : null;
    const tracks = stream?.getVideoTracks() ?? [];
    const signature = stream ? stream.id + ":" + getVideoTrackSignature(stream) : (state.video.currentSrc || "");
    if (state.sourceStream === stream && state.sourceSignature === signature
        && tracks.length === state.sourceTracks.length && tracks.every((track, i) => track === state.sourceTracks[i])) return;

    releaseManagedTracks(state);
    state.sourceStream = stream;
    state.sourceTracks = tracks;
    state.sourceSignature = signature;
    stream?.addEventListener("addtrack", onManagedTrackChange);
    stream?.addEventListener("removetrack", onManagedTrackChange);
    for (const track of tracks) {
        track.addEventListener("ended", onManagedTrackChange);
        track.addEventListener("mute", onManagedTrackChange);
        track.addEventListener("unmute", onManagedTrackChange);
    }
    invalidateGeometry(state);
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
        stylesApplied: false,
        sourceStream: null,
        sourceTracks: [],
        sourceSignature: "",
        originalTranslate: getStyleSnapshot(video, "translate"),
        originalScale: getStyleSnapshot(video, "scale"),
        originalTransformOrigin: getStyleSnapshot(video, "transform-origin"),
        originalWillChange: getStyleSnapshot(video, "will-change"),
        originalObjectFit: getStyleSnapshot(video, "object-fit"),
        originalObjectPosition: getStyleSnapshot(video, "object-position"),
        originalWidth: getStyleSnapshot(video, "width"),
        originalHeight: getStyleSnapshot(video, "height"),
        originalPosition: getStyleSnapshot(video, "position"),
        originalLeft: getStyleSnapshot(video, "left"),
        originalTop: getStyleSnapshot(video, "top"),
        originalMarginLeft: getStyleSnapshot(video, "margin-left"),
        originalMarginTop: getStyleSnapshot(video, "margin-top"),
        originalMaxWidth: getStyleSnapshot(video, "max-width"),
        originalMaxHeight: getStyleSnapshot(video, "max-height"),
        originalOverflow: getStyleSnapshot(container, "overflow"),
        originalCursor: getStyleSnapshot(container, "cursor"),
        originalBackground: getStyleSnapshot(container, "background-color")
    };

    states.set(video, state);
    activeVideos.add(video);
    refreshManagedTracks(state);
    video.addEventListener("resize", onManagedVideoResize);
    resizeObserver?.observe(container);
    loadSavedState(state);
    return state;
}

function restoreElement(video: HTMLVideoElement, state: ViewState) {
    video.removeEventListener("resize", onManagedVideoResize);
    releaseManagedTracks(state);
    pendingApplyVideos.delete(video);

    restoreStyle(video, "translate", state.originalTranslate);
    restoreStyle(video, "scale", state.originalScale);
    restoreStyle(video, "transform-origin", state.originalTransformOrigin);
    restoreStyle(video, "will-change", state.originalWillChange);
    restoreStyle(video, "object-fit", state.originalObjectFit);
    restoreStyle(video, "object-position", state.originalObjectPosition);
    restoreStyle(video, "width", state.originalWidth);
    restoreStyle(video, "height", state.originalHeight);
    restoreStyle(video, "position", state.originalPosition);
    restoreStyle(video, "left", state.originalLeft);
    restoreStyle(video, "top", state.originalTop);
    restoreStyle(video, "margin-left", state.originalMarginLeft);
    restoreStyle(video, "margin-top", state.originalMarginTop);
    restoreStyle(video, "max-width", state.originalMaxWidth);
    restoreStyle(video, "max-height", state.originalMaxHeight);
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
    refreshManagedTracks(state);
    state.mirroredX = isMirrored(video);
    return state;
}

function applyNow(video: HTMLVideoElement, state: ViewState) {
    if (!isRenderableVideo(video)) {
        if (state.stylesApplied) {
            restoreAspectRatioStyles(state);
            restoreStyle(video, "translate", state.originalTranslate);
            restoreStyle(video, "scale", state.originalScale);
            restoreStyle(video, "transform-origin", state.originalTransformOrigin);
            restoreStyle(video, "will-change", state.originalWillChange);
            restoreStyle(state.container, "overflow", state.originalOverflow);
            restoreStyle(state.container, "cursor", state.originalCursor);
            state.stylesApplied = false;
        }
        return;
    }

    state.stylesApplied = true;
    if (shouldFitAspectRatio(state)) applyAspectRatioFit(state);
    else restoreAspectRatioStyles(state);

    const limits = clampPan(state);
    const transformed = state.zoom > MIN_ZOOM + 0.001;
    const dragging = dragState?.video === video;

    if (transformed) {
        const translateX = state.mirroredX ? -state.x : state.x;
        const scale = getZoomScales(state);
        video.style.setProperty("translate", String(translateX) + "px " + String(state.y) + "px", "important");
        video.style.setProperty("scale", String(scale.x) + " " + String(scale.y), "important");
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
    if (!fullscreenSession) return;
    scheduleVideoScan();
    syncFullscreenMedia(fullscreenSession);
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
        const liveTracks = tracks.filter(track => track.readyState === "live");
        const signature = source.id + ":" + getVideoTrackSignature(source);
        const current = session.video.srcObject;
        const attached = current instanceof MediaStream ? current.getVideoTracks() : [];
        const sameTracks = attached.length === liveTracks.length && liveTracks.every((track, i) => track === attached[i]);
        if (signature !== session.sourceSignature || !sameTracks) {
            session.sourceSignature = signature;
            session.video.srcObject = null;
            session.video.removeAttribute("src");
            if (liveTracks.length) {
                session.video.srcObject = new MediaStream(liveTracks);
                void session.video.play().catch(() => {});
            }
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
    const oldScale = getZoomScales(state, oldZoom);
    const newScale = getZoomScales(state, newZoom);

    state.x = pointerX - (pointerX - state.x) * (newScale.x / oldScale.x);
    state.y = pointerY - (pointerY - state.y) * (newScale.y / oldScale.y);
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

    const fullscreen = event.target.closest<HTMLElement>("[" + FULLSCREEN_ATTRIBUTE + "=\\\"true\\\"]");
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
    if (video.hasAttribute(FULLSCREEN_VIDEO_ATTRIBUTE)) return;
    const tile = video.closest<HTMLElement>(TILE_SELECTOR);
    if (!tile) return;
    const state = states.get(video);
    if (state) {
        refreshManagedTracks(state);
        invalidateGeometry(state);
        scheduleApply(video);
    }
    queueTile(tile);
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

/* ------------------------------------------------------------------ *
 * Camera pop-outs: one camera in its own freely resizable window.
 * ------------------------------------------------------------------ */

type PopoutFit = "fill" | "contain" | "cover";

interface Bounds {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface RememberedPopout extends Bounds {
    fit: PopoutFit;
}

interface CameraPopout {
    key: string;
    tileId: string | null;
    label: string;
    root: HTMLDivElement;
    content: HTMLDivElement;
    body: HTMLDivElement;
    stage: HTMLDivElement;
    video: HTMLVideoElement;
    message: HTMLDivElement;
    fitButton: HTMLButtonElement;
    fullscreenButton: HTMLButtonElement;
    onFullscreenChange: () => void;
    dockButton: HTMLButtonElement | null;
    sourceVideo: HTMLVideoElement | null;
    sourceSignature: string;
    mirrored: boolean;
    fit: PopoutFit;
    zoom: number;
    x: number;
    y: number;
    pip: Window | null;
    closed: boolean;
}

interface NamedUser {
    globalName?: string | null;
    username?: string;
}

interface ContextMenuSubject {
    user?: NamedUser;
    stream?: { ownerId?: string; };
}

interface DocumentPictureInPictureApi {
    requestWindow(options?: { width?: number; height?: number; }): Promise<Window>;
}

const FIT_ORDER: PopoutFit[] = ["fill", "contain", "cover"];
const FIT_LABELS: Record<PopoutFit, string> = { fill: "Stretch", contain: "Fit", cover: "Crop" };
const FIT_DESCRIPTIONS: Record<PopoutFit, string> = {
    fill: "stretches the picture to fill the whole window (may distort)",
    contain: "keeps the aspect ratio and adds black bars",
    cover: "keeps the aspect ratio and crops the edges to fill the window"
};
const POPOUT_FONT = "\"gg sans\", \"Noto Sans\", \"Helvetica Neue\", Helvetica, Arial, sans-serif";
const POPOUT_ICON = "<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M15 3h6v6\"/><path d=\"M10 14 21 3\"/><path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"/></svg>";

const RESIZE_HANDLES: Array<{ dir: string; cursor: string; style: Partial<CSSStyleDeclaration>; }> = [
    { dir: "n", cursor: "ns-resize", style: { top: "0", left: "10px", right: "10px", height: "6px" } },
    { dir: "s", cursor: "ns-resize", style: { bottom: "0", left: "10px", right: "10px", height: "6px" } },
    { dir: "e", cursor: "ew-resize", style: { right: "0", top: "10px", bottom: "10px", width: "6px" } },
    { dir: "w", cursor: "ew-resize", style: { left: "0", top: "10px", bottom: "10px", width: "6px" } },
    { dir: "nw", cursor: "nwse-resize", style: { top: "0", left: "0", width: "10px", height: "10px" } },
    { dir: "ne", cursor: "nesw-resize", style: { top: "0", right: "0", width: "10px", height: "10px" } },
    { dir: "sw", cursor: "nesw-resize", style: { bottom: "0", left: "0", width: "10px", height: "10px" } },
    { dir: "se", cursor: "nwse-resize", style: { bottom: "0", right: "0", width: "10px", height: "10px" } }
];

const popouts = new Map<string, CameraPopout>();
const rememberedPopouts = new Map<string, RememberedPopout>();

let popoutSyncTimer: number | null = null;
let hoverButton: HTMLButtonElement | null = null;
let hoverTile: HTMLElement | null = null;
// The camera tile the person last pressed the mouse on. Used to decide whether an opening
// context menu (right-click or Discord's "..." button) belongs to a camera.
let contextTile: HTMLElement | null = null;

function css(element: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(element.style, styles);
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, styles?: Partial<CSSStyleDeclaration>, text?: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (styles) css(element, styles);
    if (text) element.textContent = text;
    return element;
}

function normalizeFit(value: unknown): PopoutFit {
    return FIT_ORDER.find(fit => fit === value) ?? "fill";
}

function getTileWithVideo(target: EventTarget | null) {
    const tile = getDiscordVideoTile(target);
    if (!tile) return null;
    const video = getVisibleVideo(tile);
    return video && isRenderableVideo(video) ? { tile, video } : null;
}

function getTileLabel(tile: HTMLElement) {
    const aria = tile.getAttribute("aria-label")?.trim();
    if (aria) return aria.slice(0, 80);
    return "Camera";
}

function clampBounds(bounds: Bounds): Bounds {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = clamp(bounds.width, POPOUT_MIN_WIDTH, Math.max(POPOUT_MIN_WIDTH, vw));
    const height = clamp(bounds.height, POPOUT_MIN_HEIGHT, Math.max(POPOUT_MIN_HEIGHT, vh));
    return {
        width,
        height,
        // Always keep a part of the title bar on screen so the window can be grabbed again.
        left: clamp(bounds.left, 80 - width, vw - 80),
        top: clamp(bounds.top, 0, vh - 40)
    };
}

function applyBounds(popout: CameraPopout, bounds: Bounds) {
    css(popout.root, {
        left: Math.round(bounds.left) + "px",
        top: Math.round(bounds.top) + "px",
        width: Math.round(bounds.width) + "px",
        height: Math.round(bounds.height) + "px"
    });
}

function trackDrag(
    element: HTMLElement,
    event: PointerEvent,
    onMove: (dx: number, dy: number) => void,
    onEnd?: () => void
) {
    const { pointerId, clientX: startX, clientY: startY } = event;
    try {
        element.setPointerCapture(pointerId);
    } catch {}

    const move = (e: PointerEvent) => {
        if (e.pointerId === pointerId) onMove(e.clientX - startX, e.clientY - startY);
    };
    const end = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", end);
        element.removeEventListener("pointercancel", end);
        try {
            element.releasePointerCapture(pointerId);
        } catch {}
        onEnd?.();
    };

    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
}

/* ---------- hover button ---------- */

function hideHoverButton() {
    hoverTile = null;
    if (hoverButton) hoverButton.style.display = "none";
}

function destroyHoverButton() {
    hoverButton?.remove();
    hoverButton = null;
    hoverTile = null;
}

function ensureHoverButton(): HTMLButtonElement {
    if (hoverButton) return hoverButton;

    const button = make("button", {
        position: "fixed",
        zIndex: String(HOVER_BUTTON_Z_INDEX),
        display: "none",
        alignItems: "center",
        justifyContent: "center",
        width: HOVER_BUTTON_SIZE + "px",
        height: HOVER_BUTTON_SIZE + "px",
        padding: "0",
        border: "none",
        borderRadius: "50%",
        background: "rgba(0, 0, 0, 0.65)",
        color: "#fff",
        cursor: "pointer",
        boxShadow: "0 1px 4px rgba(0, 0, 0, 0.5)"
    });
    button.type = "button";
    button.title = "Pop out camera";
    button.setAttribute("aria-label", "Pop out camera");
    button.setAttribute(POPOUT_UI_ATTRIBUTE, "true");
    button.innerHTML = POPOUT_ICON;
    button.addEventListener("pointerenter", () => css(button, { background: "rgba(0, 0, 0, 0.9)" }));
    button.addEventListener("pointerleave", () => css(button, { background: "rgba(0, 0, 0, 0.65)" }));
    button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const tile = hoverTile;
        hideHoverButton();
        if (tile?.isConnected) openPopoutForTile(tile);
    });

    document.body.append(button);
    hoverButton = button;
    return button;
}

function showHoverButton(tile: HTMLElement) {
    const button = ensureHoverButton();
    const rect = tile.getBoundingClientRect();
    const corner = settings.store.popoutButtonCorner;
    const left = corner === "top-left"
        ? rect.left + HOVER_BUTTON_MARGIN
        : rect.right - HOVER_BUTTON_SIZE - HOVER_BUTTON_MARGIN;
    const top = corner === "bottom-right"
        ? rect.bottom - HOVER_BUTTON_SIZE - HOVER_BUTTON_MARGIN
        : rect.top + HOVER_BUTTON_MARGIN;

    css(button, {
        display: "flex",
        left: Math.round(clamp(left, 0, window.innerWidth - HOVER_BUTTON_SIZE)) + "px",
        top: Math.round(clamp(top, 0, window.innerHeight - HOVER_BUTTON_SIZE)) + "px"
    });
}

function onPointerOver(event: PointerEvent) {
    if (!settings.store.cameraPopout || !settings.store.popoutHoverButton || event.pointerType === "touch") return;
    const { target } = event;
    if (target instanceof Node && hoverButton?.contains(target)) return;

    const tile = getDiscordVideoTile(target);
    if (!tile) {
        hideHoverButton();
        return;
    }

    if (tile !== hoverTile) {
        const rect = tile.getBoundingClientRect();
        if (!getTileWithVideo(tile) || rect.width < HOVER_MIN_TILE_WIDTH || rect.height < HOVER_MIN_TILE_HEIGHT) {
            hideHoverButton();
            return;
        }
        hoverTile = tile;
    }
    showHoverButton(tile);
}

function onInteractionCapture(event: PointerEvent) {
    const { target } = event;
    if (!(target instanceof Element)) return;
    // Pressing inside an open menu must not change which camera the menu belongs to.
    if (target.closest("[role=\"menu\"]")) return;
    contextTile = settings.store.cameraPopout ? getTileWithVideo(target)?.tile ?? null : null;
}

const cameraContextPatch: GlobalContextMenuPatchCallback = (_navId, children, ...args) => {
    const tile = contextTile;
    if (!settings.store.cameraPopout || !tile?.isConnected) return;

    const subject = args[0] as ContextMenuSubject | undefined;
    const ownerId = subject?.stream?.ownerId;
    const user = subject?.user ?? (ownerId ? UserStore.getUser(ownerId) as NamedUser | undefined : undefined);
    const label = user?.globalName || user?.username || undefined;

    children.splice(-1, 0, React.createElement(Menu.MenuGroup, null,
        React.createElement(Menu.MenuItem, {
            id: "webcam-zoom-camera-popout",
            label: "Pop Out Camera",
            action: () => openPopoutForTile(tile, label)
        })
    ));
};

/* ---------- pop-out lifecycle ---------- */

function openPopoutForTile(tile: HTMLElement, label?: string) {
    if (!settings.store.cameraPopout) return;
    const video = getVisibleVideo(tile);
    if (!video || !isRenderableVideo(video)) return;

    const tileId = tile.getAttribute(TILE_ID_ATTRIBUTE);
    const key = tileId ? "tile:" + tileId : getVideoKey(video, tile);

    const existing = popouts.get(key);
    if (existing) {
        focusPopout(existing);
        existing.pip?.focus();
        return;
    }

    createPopout(key, tileId, video, label || getTileLabel(tile));
}

function focusPopout(popout: CameraPopout) {
    for (const other of popouts.values()) css(other.root, { zIndex: String(POPOUT_Z_INDEX) });
    css(popout.root, { zIndex: String(POPOUT_Z_INDEX + 1) });
}

function rememberPopout(popout: CameraPopout) {
    const previous = rememberedPopouts.get(popout.key);
    const rect = popout.root.getBoundingClientRect();
    const inApp = !popout.pip && rect.width > 0 && rect.height > 0;
    const bounds: Bounds | undefined = inApp
        ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        : previous;
    if (bounds) rememberedPopouts.set(popout.key, { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, fit: popout.fit });
}

function applyPopoutView(popout: CameraPopout) {
    const rect = popout.body.getBoundingClientRect();
    const maxX = Math.max(0, rect.width * (popout.zoom - 1) / 2);
    const maxY = Math.max(0, rect.height * (popout.zoom - 1) / 2);
    popout.x = clamp(popout.x, -maxX, maxX);
    popout.y = clamp(popout.y, -maxY, maxY);

    const stageStyle = popout.stage.style;
    if (popout.zoom > MIN_ZOOM + 0.001) {
        stageStyle.setProperty("translate", String(popout.x) + "px " + String(popout.y) + "px");
        stageStyle.setProperty("scale", String(popout.zoom));
        stageStyle.setProperty("will-change", "translate, scale");
        popout.body.style.cursor = settings.store.dragPan ? "grab" : "";
    } else {
        popout.zoom = MIN_ZOOM;
        popout.x = 0;
        popout.y = 0;
        stageStyle.removeProperty("translate");
        stageStyle.removeProperty("scale");
        stageStyle.removeProperty("will-change");
        popout.body.style.cursor = "";
    }

    popout.video.style.objectFit = popout.fit;
    popout.video.style.transform = popout.mirrored ? "scaleX(-1)" : "";
    popout.fitButton.textContent = FIT_LABELS[popout.fit];
    popout.fitButton.title = "Picture mode: " + FIT_LABELS[popout.fit] + " " + FIT_DESCRIPTIONS[popout.fit] + ". Click to change.";
}

function resetPopoutView(popout: CameraPopout) {
    popout.zoom = MIN_ZOOM;
    popout.x = 0;
    popout.y = 0;
    applyPopoutView(popout);
}

function findPopoutSource(popout: CameraPopout): HTMLVideoElement | null {
    const current = popout.sourceVideo;
    if (current?.isConnected && isRenderableVideo(current)) return current;
    if (!popout.tileId) return null;

    // Discord recreates tiles/videos when a camera is toggled or the layout changes,
    // so look the camera up again by its tile id.
    for (const tile of document.querySelectorAll<HTMLElement>(TILE_SELECTOR)) {
        if (tile.getAttribute(TILE_ID_ATTRIBUTE) !== popout.tileId) continue;
        const video = getVisibleVideo(tile);
        if (video && isRenderableVideo(video)) return video;
    }
    return null;
}

function syncPopoutMedia(popout: CameraPopout) {
    if (popout.closed) return;

    const source = findPopoutSource(popout);
    popout.sourceVideo = source;

    if (!source) {
        if (popout.sourceSignature !== "") {
            popout.sourceSignature = "";
            popout.video.pause();
            popout.video.srcObject = null;
            popout.video.removeAttribute("src");
        }
        css(popout.message, { display: "flex" });
        css(popout.video, { visibility: "hidden" });
        return;
    }

    css(popout.message, { display: "none" });
    css(popout.video, { visibility: "visible" });

    const mirrored = isMirrored(source);
    if (mirrored !== popout.mirrored) {
        popout.mirrored = mirrored;
        applyPopoutView(popout);
    }

    const stream = source.srcObject;
    if (stream instanceof MediaStream) {
        const tracks = stream.getVideoTracks().filter(track => track.readyState === "live");
        const signature = stream.id + ":" + tracks.map(track => track.id).join("|");
        if (signature !== popout.sourceSignature || !popout.video.srcObject) {
            popout.sourceSignature = signature;
            popout.video.removeAttribute("src");
            popout.video.srcObject = new MediaStream(tracks);
            void popout.video.play().catch(() => {});
        }
        return;
    }

    const src = source.currentSrc;
    const signature = "src:" + src;
    if (src && signature !== popout.sourceSignature) {
        popout.sourceSignature = signature;
        popout.video.srcObject = null;
        popout.video.src = src;
        void popout.video.play().catch(() => {});
    }
}

function startPopoutSync() {
    if (popoutSyncTimer !== null) return;
    popoutSyncTimer = window.setInterval(() => {
        for (const popout of popouts.values()) syncPopoutMedia(popout);
    }, POPOUT_SYNC_INTERVAL);
}

function stopPopoutSyncIfIdle() {
    if (popouts.size > 0 || popoutSyncTimer === null) return;
    clearInterval(popoutSyncTimer);
    popoutSyncTimer = null;
}

function getPictureInPictureApi(): DocumentPictureInPictureApi | null {
    const api = (window as unknown as { documentPictureInPicture?: DocumentPictureInPictureApi; }).documentPictureInPicture;
    return api && typeof api.requestWindow === "function" ? api : null;
}

/** Moves the pop-out into a real, always-on-top system window (Chromium's Document Picture-in-Picture). */
async function detachPopout(popout: CameraPopout) {
    const api = getPictureInPictureApi();
    if (!api || popout.pip || popout.closed) return;

    const rect = popout.root.getBoundingClientRect();
    let pip: Window;
    try {
        pip = await api.requestWindow({ width: Math.round(rect.width), height: Math.round(rect.height) });
    } catch (error) {
        console.warn("[WebcamZoom] Could not open a separate camera window:", error);
        return;
    }

    if (popout.closed || popout.pip) {
        pip.close();
        return;
    }

    rememberPopout(popout);
    popout.pip = pip;
    pip.document.title = popout.label + " - Camera";
    css(pip.document.body, { margin: "0", background: "#000", overflow: "hidden" });
    pip.addEventListener("resize", () => applyPopoutView(popout));
    pip.addEventListener("pagehide", () => {
        if (popout.pip === pip) dockPopout(popout);
    });

    css(popout.root, { display: "none" });
    pip.document.body.append(popout.content);
    if (popout.dockButton) {
        popout.dockButton.textContent = "Dock";
        popout.dockButton.title = "Move the camera back into Discord";
    }
    applyPopoutView(popout);
    void popout.video.play().catch(() => {});
}

function dockPopout(popout: CameraPopout) {
    const { pip } = popout;
    if (!pip) return;
    popout.pip = null;

    css(popout.root, { display: "" });
    // Keep the content first so the resize handles stay on top of it.
    popout.root.prepend(popout.content);
    try {
        pip.close();
    } catch {}

    if (popout.dockButton) {
        popout.dockButton.textContent = "Detach";
        popout.dockButton.title = "Move the camera into its own always-on-top window";
    }
    applyPopoutView(popout);
    void popout.video.play().catch(() => {});
}

function closePopout(popout: CameraPopout) {
    if (popout.closed) return;
    rememberPopout(popout);
    popout.closed = true;
    popouts.delete(popout.key);

    const { pip } = popout;
    popout.pip = null;
    if (pip) {
        try {
            pip.close();
        } catch {}
    }

    popout.content.removeEventListener("fullscreenchange", popout.onFullscreenChange);
    popout.video.pause();
    popout.video.srcObject = null;
    popout.video.removeAttribute("src");
    popout.content.remove();
    popout.root.remove();
    stopPopoutSyncIfIdle();
}

function closeAllPopouts() {
    for (const popout of [...popouts.values()]) closePopout(popout);
}

function onWindowResize() {
    hideHoverButton();
    for (const popout of popouts.values()) {
        if (popout.pip) continue;
        const rect = popout.root.getBoundingClientRect();
        applyBounds(popout, clampBounds({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }));
        applyPopoutView(popout);
    }
}

function makePopoutButton(text: string, title: string, onClick: () => void) {
    const idle = "rgba(0, 0, 0, 0.6)";
    const button = make("button", {
        flex: "none",
        height: "24px",
        minWidth: "24px",
        padding: "0 10px",
        border: "none",
        borderRadius: "12px",
        background: idle,
        color: "#fff",
        fontFamily: "inherit",
        fontSize: "12px",
        lineHeight: "24px",
        cursor: "pointer"
    }, text);
    button.type = "button";
    button.title = title;
    button.addEventListener("pointerenter", () => css(button, { background: "rgba(255, 255, 255, 0.28)" }));
    button.addEventListener("pointerleave", () => css(button, { background: idle }));
    button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
    });
    return button;
}

function createPopout(key: string, tileId: string | null, source: HTMLVideoElement, label: string) {
    const remembered = rememberedPopouts.get(key);
    const aspect = source.videoWidth > 0 && source.videoHeight > 0 ? source.videoWidth / source.videoHeight : 16 / 9;
    const startWidth = clamp(Number(settings.store.popoutWidth) || POPOUT_DEFAULT_WIDTH, POPOUT_MIN_WIDTH, Math.max(POPOUT_MIN_WIDTH, window.innerWidth - 48));
    const width = remembered?.width ?? startWidth;
    const height = remembered?.height ?? Math.round(width / aspect);
    const stagger = (popouts.size % 6) * 28;
    const bounds = clampBounds({
        left: remembered?.left ?? window.innerWidth - width - 24 - stagger,
        top: remembered?.top ?? window.innerHeight - height - 24 - stagger,
        width,
        height
    });

    const root = make("div", {
        position: "fixed",
        zIndex: String(POPOUT_Z_INDEX),
        overflow: "hidden",
        borderRadius: "8px",
        background: "#000",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.12)"
    });
    root.setAttribute(POPOUT_UI_ATTRIBUTE, "true");

    const content = make("div", { position: "absolute", inset: "0", overflow: "hidden", background: "#000", fontFamily: POPOUT_FONT });
    const body = make("div", { position: "absolute", inset: "0", overflow: "hidden", touchAction: "none" });
    const stage = make("div", { position: "absolute", inset: "0" });
    const video = make("video", {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        background: "#000",
        objectPosition: "center center",
        pointerEvents: "none"
    });
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
    video.disablePictureInPicture = true;

    const message = make("div", {
        position: "absolute",
        inset: "0",
        display: "none",
        alignItems: "center",
        justifyContent: "center",
        color: "#b5bac1",
        fontSize: "14px",
        pointerEvents: "none"
    }, "Camera is off or has left the call");

    stage.append(video);
    body.append(stage, message);

    const bar = make("div", {
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
        zIndex: "2",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "8px 12px",
        background: "linear-gradient(rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0))",
        color: "#fff",
        fontSize: "13px",
        userSelect: "none",
        opacity: "0",
        transition: "opacity 0.12s",
        cursor: "move"
    });
    const title = make("span", {
        flex: "1 1 auto",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        textShadow: "0 1px 2px rgba(0, 0, 0, 0.8)"
    }, label);

    const popout: CameraPopout = {
        key,
        tileId,
        label,
        root,
        content,
        body,
        stage,
        video,
        message,
        fitButton: null as unknown as HTMLButtonElement,
        fullscreenButton: null as unknown as HTMLButtonElement,
        onFullscreenChange: () => {},
        dockButton: null,
        sourceVideo: source,
        sourceSignature: "",
        mirrored: isMirrored(source),
        fit: remembered?.fit ?? normalizeFit(settings.store.popoutFit),
        zoom: MIN_ZOOM,
        x: 0,
        y: 0,
        pip: null,
        closed: false
    };

    popout.fitButton = makePopoutButton("", "", () => {
        popout.fit = FIT_ORDER[(FIT_ORDER.indexOf(popout.fit) + 1) % FIT_ORDER.length];
        applyPopoutView(popout);
        rememberPopout(popout);
    });
    popout.fullscreenButton = makePopoutButton("Fullscreen", "Show this camera pop-out full screen (Escape to exit)", () => {
        const ownerDocument = popout.content.ownerDocument;
        if (ownerDocument.fullscreenElement === popout.content) {
            void ownerDocument.exitFullscreen().catch(error => console.warn("[WebcamZoom] Could not exit pop-out fullscreen:", error));
        } else if (typeof popout.content.requestFullscreen === "function") {
            void popout.content.requestFullscreen().catch(error => console.warn("[WebcamZoom] Could not enter pop-out fullscreen:", error));
        }
    });
    popout.onFullscreenChange = () => {
        const active = popout.content.ownerDocument.fullscreenElement === popout.content;
        const style = popout.content.style;
        if (active) {
            style.setProperty("position", "fixed", "important");
            style.setProperty("inset", "0", "important");
            style.setProperty("width", "100vw", "important");
            style.setProperty("height", "100vh", "important");
            style.setProperty("z-index", "2147483647", "important");
            style.setProperty("border-radius", "0", "important");
            popout.fullscreenButton.textContent = "Exit full screen";
            popout.fullscreenButton.title = "Exit full screen (Escape)";
        } else {
            style.setProperty("position", "absolute", "important");
            style.setProperty("inset", "0", "important");
            for (const property of ["width", "height", "z-index", "border-radius"]) style.removeProperty(property);
            popout.fullscreenButton.textContent = "Fullscreen";
            popout.fullscreenButton.title = "Show this camera pop-out full screen (Escape to exit)";
        }
        applyPopoutView(popout);
    };
    popout.content.addEventListener("fullscreenchange", popout.onFullscreenChange);

    const resetButton = makePopoutButton("Reset", "Reset zoom and pan (double-click or middle-click the picture)", () => resetPopoutView(popout));
    const closeButton = makePopoutButton("\u00d7", "Close", () => closePopout(popout));
    closeButton.style.fontSize = "16px";

    bar.append(title, popout.fitButton, popout.fullscreenButton, resetButton);
    if (getPictureInPictureApi()) {
        popout.dockButton = makePopoutButton("Detach", "Move the camera into its own always-on-top window", () => {
            if (popout.pip) dockPopout(popout);
            else void detachPopout(popout);
        });
        bar.append(popout.dockButton);
    }
    bar.append(closeButton);

    // Title bar controls fade in on hover.
    const showBar = () => { bar.style.opacity = "1"; };
    const hideBar = () => { bar.style.opacity = "0"; };
    for (const target of [root, content]) {
        target.addEventListener("pointerenter", showBar);
        target.addEventListener("pointerleave", hideBar);
    }

    root.addEventListener("pointerdown", () => focusPopout(popout), true);

    // Move the window by its title bar.
    bar.addEventListener("pointerdown", event => {
        if (event.button !== 0 || popout.pip) return;
        if (event.target instanceof Element && event.target.closest("button")) return;
        event.preventDefault();
        const start = root.getBoundingClientRect();
        trackDrag(bar, event, (dx, dy) => {
            applyBounds(popout, clampBounds({ left: start.left + dx, top: start.top + dy, width: start.width, height: start.height }));
        }, () => rememberPopout(popout));
    });

    // Free resizing from every edge and corner.
    const handles = RESIZE_HANDLES.map(({ dir, cursor, style }) => {
        const handle = make("div", { position: "absolute", zIndex: "5", cursor, touchAction: "none", ...style });
        handle.addEventListener("pointerdown", event => {
            if (event.button !== 0 || popout.pip) return;
            event.preventDefault();
            event.stopPropagation();
            const start = root.getBoundingClientRect();
            trackDrag(handle, event, (dx, dy) => {
                let { left, top, right, bottom } = start;
                if (dir.includes("e")) right += dx;
                if (dir.includes("w")) left += dx;
                if (dir.includes("s")) bottom += dy;
                if (dir.includes("n")) top += dy;

                if (right - left < POPOUT_MIN_WIDTH) {
                    if (dir.includes("w")) left = right - POPOUT_MIN_WIDTH;
                    else right = left + POPOUT_MIN_WIDTH;
                }
                if (bottom - top < POPOUT_MIN_HEIGHT) {
                    if (dir.includes("n")) top = bottom - POPOUT_MIN_HEIGHT;
                    else bottom = top + POPOUT_MIN_HEIGHT;
                }

                applyBounds(popout, { left, top, width: right - left, height: bottom - top });
                applyPopoutView(popout);
            }, () => rememberPopout(popout));
        });
        return handle;
    });

    // Wheel zoom (towards the pointer), drag to pan, double/middle click to reset.
    body.addEventListener("wheel", event => {
        if (!settings.store.wheelZoom) return;
        event.preventDefault();

        const oldZoom = popout.zoom;
        const newZoom = clamp(oldZoom * Math.exp(-normalizedWheelDelta(event) * ZOOM_SENSITIVITY), MIN_ZOOM, MAX_ZOOM);
        if (newZoom === oldZoom) return;

        const rect = body.getBoundingClientRect();
        const pointerX = event.clientX - (rect.left + rect.width / 2);
        const pointerY = event.clientY - (rect.top + rect.height / 2);
        const ratio = newZoom / oldZoom;
        popout.x = pointerX - (pointerX - popout.x) * ratio;
        popout.y = pointerY - (pointerY - popout.y) * ratio;
        popout.zoom = newZoom;
        applyPopoutView(popout);
    }, { passive: false });

    body.addEventListener("pointerdown", event => {
        if (!settings.store.dragPan || event.button !== 0 || popout.zoom <= MIN_ZOOM) return;
        event.preventDefault();
        const startX = popout.x;
        const startY = popout.y;
        trackDrag(body, event, (dx, dy) => {
            popout.x = startX + dx;
            popout.y = startY + dy;
            applyPopoutView(popout);
        });
    });

    body.addEventListener("dblclick", event => {
        event.preventDefault();
        resetPopoutView(popout);
    });

    body.addEventListener("auxclick", event => {
        if (event.button !== 1 || !settings.store.middleClickReset) return;
        event.preventDefault();
        resetPopoutView(popout);
    });

    content.append(body, bar);
    root.append(content, ...handles);
    applyBounds(popout, bounds);
    document.body.append(root);

    popouts.set(key, popout);
    focusPopout(popout);
    applyPopoutView(popout);
    syncPopoutMedia(popout);
    startPopoutSync();
}

export default definePlugin({
    name: "WebcamZoom",
    description: "Adds aspect-correct or stretch-to-fill webcams, mouse-wheel zoom, drag panning, true fullscreen camera viewing and freely resizable per-camera pop-out windows.",
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
        document.addEventListener("loadstart", onVideoSourceEvent, true);
        document.addEventListener("playing", onVideoSourceEvent, true);
        document.addEventListener("emptied", onVideoSourceEvent, true);
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("fullscreenchange", onFullscreenChange);
        window.addEventListener("blur", onWindowBlur);
        document.addEventListener("pointerover", onPointerOver, true);
        document.addEventListener("pointerdown", onInteractionCapture, true);
        document.documentElement.addEventListener("pointerleave", hideHoverButton);
        window.addEventListener("blur", hideHoverButton);
        window.addEventListener("resize", onWindowResize);
        addGlobalContextMenuPatch(cameraContextPatch);

        resizeObserver = new ResizeObserver(onContainerResize);
        observer = new MutationObserver(onMutations);
        observer.observe(document.body, { childList: true, subtree: true });
        scheduleVideoScan();
    },

    stop() {
        closeCustomFullscreen();
        closeAllPopouts();
        destroyHoverButton();
        contextTile = null;
        rememberedPopouts.clear();
        finishDrag(undefined, true);

        removeGlobalContextMenuPatch(cameraContextPatch);
        document.removeEventListener("pointerover", onPointerOver, true);
        document.removeEventListener("pointerdown", onInteractionCapture, true);
        document.documentElement.removeEventListener("pointerleave", hideHoverButton);
        window.removeEventListener("blur", hideHoverButton);
        window.removeEventListener("resize", onWindowResize);

        document.removeEventListener("wheel", onWheel);
        document.removeEventListener("pointerdown", onPointerDown);
        document.removeEventListener("click", onClickCapture, true);
        document.removeEventListener("dblclick", onDoubleClickCapture, true);
        document.removeEventListener("auxclick", onAuxClick);
        document.removeEventListener("loadedmetadata", onLoadedMetadata, true);
        document.removeEventListener("loadeddata", onVideoSourceEvent, true);
        document.removeEventListener("loadstart", onVideoSourceEvent, true);
        document.removeEventListener("playing", onVideoSourceEvent, true);
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
