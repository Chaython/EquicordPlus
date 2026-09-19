/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_SENSITIVITY = 0.0015;

const DRAG_THRESHOLD = 3;
const CLICK_SUPPRESSION_TIME = 500;

interface SavedViewState {
    zoom: number;

    /*
     * Pan is stored as a normalized -1..1 value instead of raw pixels.
     *
     * This lets the same viewed area survive when Discord changes the
     * camera from a small tile to a large/focused/fullscreen tile.
     */
    panX: number;
    panY: number;
}

interface StyleSnapshot {
    value: string;
    priority: string;
}

interface ViewState {
    key: string;

    video: HTMLVideoElement;
    tile: HTMLElement;

    zoom: number;
    x: number;
    y: number;

    mirroredX: boolean;

    originalTranslate: StyleSnapshot;
    originalScale: StyleSnapshot;
    originalTransformOrigin: StyleSnapshot;
    originalWillChange: StyleSnapshot;

    originalObjectFit: StyleSnapshot;
    originalObjectPosition: StyleSnapshot;
    originalWidth: StyleSnapshot;
    originalHeight: StyleSnapshot;

    originalTileOverflow: StyleSnapshot;
    originalTileCursor: StyleSnapshot;
    originalTileBackground: StyleSnapshot;
}

interface DragState {
    video: HTMLVideoElement;
    key: string;

    startX: number;
    startY: number;

    lastX: number;
    lastY: number;

    moved: boolean;
}

const states = new WeakMap<HTMLVideoElement, ViewState>();

const activeVideos = new Set<HTMLVideoElement>();

/*
 * State stored by camera/stream rather than by <video> element.
 *
 * Discord can destroy and recreate the actual video element when changing
 * layouts. Keeping the state here lets zoom/pan survive those transitions.
 */
const savedStates = new Map<string, SavedViewState>();

/*
 * Used to stop the click generated after dragging from causing Discord to
 * open/close the focused camera.
 */
const suppressedClicks = new Map<string, number>();

const anonymousVideoIds = new WeakMap<HTMLVideoElement, number>();

let nextAnonymousVideoId = 1;

let dragState: DragState | null = null;

let observer: MutationObserver | null = null;
let scanFrame: number | null = null;

function clamp(
    value: number,
    min: number,
    max: number
) {
    return Math.min(
        max,
        Math.max(min, value)
    );
}

function getStyleSnapshot(
    element: HTMLElement,
    property: string
): StyleSnapshot {
    return {
        value:
            element.style.getPropertyValue(
                property
            ),

        priority:
            element.style.getPropertyPriority(
                property
            )
    };
}

function restoreStyle(
    element: HTMLElement,
    property: string,
    snapshot: StyleSnapshot
) {
    if (!snapshot.value) {
        element.style.removeProperty(
            property
        );

        return;
    }

    element.style.setProperty(
        property,
        snapshot.value,
        snapshot.priority
    );
}

function getVideoTile(
    target: EventTarget | null
): HTMLElement | null {
    if (!(target instanceof Element))
        return null;

    return target.closest<HTMLElement>(
        "[data-selenium-video-tile]"
    );
}

function getVideo(
    tile: HTMLElement
): HTMLVideoElement | null {
    /*
     * Prefer the visible video if Discord happens to have more than one
     * video element inside a tile.
     */
    const videos =
        tile.querySelectorAll<HTMLVideoElement>(
            "video"
        );

    for (const video of videos) {
        const rect =
            video.getBoundingClientRect();

        if (
            rect.width > 0 &&
            rect.height > 0
        ) {
            return video;
        }
    }

    return videos[0] ?? null;
}

function getAnonymousVideoId(
    video: HTMLVideoElement
) {
    let id =
        anonymousVideoIds.get(video);

    if (id === undefined) {
        id = nextAnonymousVideoId++;

        anonymousVideoIds.set(
            video,
            id
        );
    }

    return id;
}

function getVideoKey(
    video: HTMLVideoElement,
    tile: HTMLElement
): string {
    /*
     * Best case:
     * Discord keeps the same MediaStream while changing layouts.
     */
    const source =
        video.srcObject;

    if (
        source instanceof MediaStream &&
        source.id
    ) {
        return `stream:${source.id}`;
    }

    /*
     * Fallback to Discord's tile identifier.
     */
    const tileId =
        tile.getAttribute(
            "data-selenium-video-tile"
        );

    if (tileId)
        return `tile:${tileId}`;

    /*
     * Some Discord layouts may expose a normal src/currentSrc.
     */
    if (video.currentSrc)
        return `src:${video.currentSrc}`;

    /*
     * Last-resort per-element identifier.
     *
     * This one cannot survive element replacement, but prevents the plugin
     * from failing entirely if Discord changes the video implementation.
     */
    return `video:${getAnonymousVideoId(video)}`;
}

function isMirrored(
    video: HTMLVideoElement
) {
    try {
        const transform =
            getComputedStyle(
                video
            ).transform;

        if (
            !transform ||
            transform === "none"
        ) {
            return false;
        }

        const matrix =
            new DOMMatrixReadOnly(
                transform
            );

        return matrix.a < 0;
    } catch {
        return false;
    }
}

/*
 * Forces Discord cameras to preserve their actual transmitted aspect ratio.
 *
 * Example:
 *
 * A 9:16 phone camera displayed on a 16:9 screen remains 9:16.
 *
 * Discord gets empty space on the left/right instead of cropping the
 * sender's top and bottom.
 */
function applyAspectRatioFit(
    video: HTMLVideoElement,
    tile: HTMLElement
) {
    video.style.setProperty(
        "width",
        "100%",
        "important"
    );

    video.style.setProperty(
        "height",
        "100%",
        "important"
    );

    video.style.setProperty(
        "object-fit",
        "contain",
        "important"
    );

    video.style.setProperty(
        "object-position",
        "center center",
        "important"
    );

    tile.style.setProperty(
        "background-color",
        "#000",
        "important"
    );

    tile.style.setProperty(
        "overflow",
        "hidden",
        "important"
    );
}

/*
 * Calculates the size of the actual visible video when object-fit: contain
 * is being used.
 *
 * The video may be much narrower than the Discord tile for portrait feeds.
 */
function getContainedVideoSize(
    video: HTMLVideoElement,
    tile: HTMLElement
) {
    const rect =
        tile.getBoundingClientRect();

    const containerWidth =
        rect.width;

    const containerHeight =
        rect.height;

    if (
        containerWidth <= 0 ||
        containerHeight <= 0
    ) {
        return {
            width: 0,
            height: 0
        };
    }

    if (
        !video.videoWidth ||
        !video.videoHeight
    ) {
        return {
            width: containerWidth,
            height: containerHeight
        };
    }

    const videoAspect =
        video.videoWidth /
        video.videoHeight;

    const containerAspect =
        containerWidth /
        containerHeight;

    if (
        videoAspect >
        containerAspect
    ) {
        /*
         * Video is wider relative to the container.
         *
         * Width touches the container edges.
         */
        return {
            width:
                containerWidth,

            height:
                containerWidth /
                videoAspect
        };
    }

    /*
     * Video is taller relative to the container.
     *
     * Height touches the container edges.
     */
    return {
        width:
            containerHeight *
            videoAspect,

        height:
            containerHeight
    };
}

/*
 * Determines how far the zoomed video can actually be panned before empty
 * space would be exposed.
 */
function getPanLimits(
    video: HTMLVideoElement,
    tile: HTMLElement,
    zoom: number
) {
    const rect =
        tile.getBoundingClientRect();

    const contained =
        getContainedVideoSize(
            video,
            tile
        );

    return {
        x: Math.max(
            0,
            (
                contained.width *
                zoom -
                rect.width
            ) / 2
        ),

        y: Math.max(
            0,
            (
                contained.height *
                zoom -
                rect.height
            ) / 2
        )
    };
}

function createState(
    video: HTMLVideoElement,
    tile: HTMLElement,
    key: string
): ViewState {
    /*
     * Save all Discord styles BEFORE modifying anything.
     */
    const originalTranslate =
        getStyleSnapshot(
            video,
            "translate"
        );

    const originalScale =
        getStyleSnapshot(
            video,
            "scale"
        );

    const originalTransformOrigin =
        getStyleSnapshot(
            video,
            "transform-origin"
        );

    const originalWillChange =
        getStyleSnapshot(
            video,
            "will-change"
        );

    const originalObjectFit =
        getStyleSnapshot(
            video,
            "object-fit"
        );

    const originalObjectPosition =
        getStyleSnapshot(
            video,
            "object-position"
        );

    const originalWidth =
        getStyleSnapshot(
            video,
            "width"
        );

    const originalHeight =
        getStyleSnapshot(
            video,
            "height"
        );

    const originalTileOverflow =
        getStyleSnapshot(
            tile,
            "overflow"
        );

    const originalTileCursor =
        getStyleSnapshot(
            tile,
            "cursor"
        );

    const originalTileBackground =
        getStyleSnapshot(
            tile,
            "background-color"
        );

    applyAspectRatioFit(
        video,
        tile
    );

    const saved =
        savedStates.get(key);

    const zoom =
        saved?.zoom ??
        MIN_ZOOM;

    const limits =
        getPanLimits(
            video,
            tile,
            zoom
        );

    const state: ViewState = {
        key,

        video,
        tile,

        zoom,

        x:
            (saved?.panX ?? 0) *
            limits.x,

        y:
            (saved?.panY ?? 0) *
            limits.y,

        mirroredX:
            isMirrored(video),

        originalTranslate,
        originalScale,
        originalTransformOrigin,
        originalWillChange,

        originalObjectFit,
        originalObjectPosition,
        originalWidth,
        originalHeight,

        originalTileOverflow,
        originalTileCursor,
        originalTileBackground
    };

    states.set(
        video,
        state
    );

    activeVideos.add(
        video
    );

    return state;
}

function restoreElement(
    video: HTMLVideoElement,
    state: ViewState
) {
    restoreStyle(
        video,
        "translate",
        state.originalTranslate
    );

    restoreStyle(
        video,
        "scale",
        state.originalScale
    );

    restoreStyle(
        video,
        "transform-origin",
        state.originalTransformOrigin
    );

    restoreStyle(
        video,
        "will-change",
        state.originalWillChange
    );

    restoreStyle(
        video,
        "object-fit",
        state.originalObjectFit
    );

    restoreStyle(
        video,
        "object-position",
        state.originalObjectPosition
    );

    restoreStyle(
        video,
        "width",
        state.originalWidth
    );

    restoreStyle(
        video,
        "height",
        state.originalHeight
    );

    restoreStyle(
        state.tile,
        "overflow",
        state.originalTileOverflow
    );

    restoreStyle(
        state.tile,
        "cursor",
        state.originalTileCursor
    );

    restoreStyle(
        state.tile,
        "background-color",
        state.originalTileBackground
    );

    states.delete(video);

    activeVideos.delete(
        video
    );

    if (
        dragState?.video ===
        video
    ) {
        dragState = null;
    }
}

function clampPan(
    state: ViewState
) {
    const limits =
        getPanLimits(
            state.video,
            state.tile,
            state.zoom
        );

    state.x = clamp(
        state.x,
        -limits.x,
        limits.x
    );

    state.y = clamp(
        state.y,
        -limits.y,
        limits.y
    );
}

function saveState(
    state: ViewState
) {
    if (
        state.zoom <=
        MIN_ZOOM + 0.001
    ) {
        savedStates.delete(
            state.key
        );

        return;
    }

    const limits =
        getPanLimits(
            state.video,
            state.tile,
            state.zoom
        );

    savedStates.set(
        state.key,
        {
            zoom:
                state.zoom,

            panX:
                limits.x > 0
                    ? clamp(
                        state.x /
                        limits.x,
                        -1,
                        1
                    )
                    : 0,

            panY:
                limits.y > 0
                    ? clamp(
                        state.y /
                        limits.y,
                        -1,
                        1
                    )
                    : 0
        }
    );
}

function apply(
    video: HTMLVideoElement,
    state: ViewState
) {
    applyAspectRatioFit(
        video,
        state.tile
    );

    clampPan(state);

    /*
     * Re-evaluate mirroring because Discord can change the camera styling
     * when moving it between layouts.
     */
    state.mirroredX =
        isMirrored(video);

    const translateX =
        state.mirroredX
            ? -state.x
            : state.x;

    /*
     * Individual CSS transform properties are intentional.
     *
     * We do not overwrite Discord's transform property because Discord may
     * already use transform to mirror a local webcam.
     */
    video.style.setProperty(
        "translate",
        `${translateX}px ${state.y}px`,
        "important"
    );

    video.style.setProperty(
        "scale",
        String(state.zoom),
        "important"
    );

    video.style.setProperty(
        "transform-origin",
        "center center",
        "important"
    );

    video.style.setProperty(
        "will-change",
        "translate, scale",
        "important"
    );

    state.tile.style.setProperty(
        "cursor",
        state.zoom > 1
            ? dragState?.video === video
                ? "grabbing"
                : "grab"
            : state.originalTileCursor.value,
        "important"
    );

    saveState(state);
}

function getState(
    video: HTMLVideoElement,
    tile: HTMLElement
) {
    const key =
        getVideoKey(
            video,
            tile
        );

    const current =
        states.get(video);

    /*
     * Discord reused the video but moved it into another tile/container.
     */
    if (
        current &&
        (
            current.tile !== tile ||
            current.key !== key
        )
    ) {
        saveState(current);

        restoreElement(
            video,
            current
        );
    }

    return (
        states.get(video) ??
        createState(
            video,
            tile,
            key
        )
    );
}

function resetKey(
    key: string
) {
    savedStates.delete(key);

    for (
        const video of
        [...activeVideos]
    ) {
        const state =
            states.get(video);

        if (
            !state ||
            state.key !== key
        ) {
            continue;
        }

        /*
         * Reset zoom/pan but keep aspect-ratio correction active.
         */
        state.zoom =
            MIN_ZOOM;

        state.x = 0;
        state.y = 0;

        apply(
            video,
            state
        );
    }
}

function resetVideo(
    video: HTMLVideoElement
) {
    const existing =
        states.get(video);

    if (existing) {
        resetKey(
            existing.key
        );

        return;
    }

    const tile =
        video.closest<HTMLElement>(
            "[data-selenium-video-tile]"
        );

    if (!tile)
        return;

    resetKey(
        getVideoKey(
            video,
            tile
        )
    );
}

/*
 * Attaches our aspect correction and restores saved zoom/pan after Discord
 * creates or moves a webcam video.
 */
function restoreVideo(
    video: HTMLVideoElement
) {
    const tile =
        video.closest<HTMLElement>(
            "[data-selenium-video-tile]"
        );

    if (!tile)
        return;

    const key =
        getVideoKey(
            video,
            tile
        );

    const current =
        states.get(video);

    if (
        current &&
        current.tile === tile &&
        current.key === key
    ) {
        /*
         * Discord may have rewritten its styles, so reassert ours.
         */
        applyAspectRatioFit(
            video,
            tile
        );

        if (
            current.zoom >
            MIN_ZOOM
        ) {
            apply(
                video,
                current
            );
        }

        return;
    }

    if (current) {
        saveState(current);

        restoreElement(
            video,
            current
        );
    }

    const state =
        createState(
            video,
            tile,
            key
        );

    /*
     * Even at 1x, keep object-fit: contain so Discord never crops the feed.
     */
    applyAspectRatioFit(
        video,
        tile
    );

    if (
        state.zoom >
        MIN_ZOOM
    ) {
        apply(
            video,
            state
        );
    }
}

function scanVideos() {
    scanFrame = null;

    document
        .querySelectorAll<HTMLVideoElement>(
            "[data-selenium-video-tile] video"
        )
        .forEach(
            restoreVideo
        );
}

function scheduleVideoScan() {
    if (
        scanFrame !== null
    ) {
        return;
    }

    scanFrame =
        requestAnimationFrame(
            scanVideos
        );
}

function onLoadedMetadata(
    event: Event
) {
    if (
        !(event.target instanceof HTMLVideoElement)
    ) {
        return;
    }

    restoreVideo(
        event.target
    );
}

function onWheel(
    event: WheelEvent
) {
    /*
     * Give Discord-native handlers priority if they already consumed it.
     */
    if (
        event.defaultPrevented ||
        event.ctrlKey
    ) {
        return;
    }

    const tile =
        getVideoTile(
            event.target
        );

    if (!tile)
        return;

    const video =
        getVideo(tile);

    if (!video)
        return;

    const state =
        getState(
            video,
            tile
        );

    const oldZoom =
        state.zoom;

    const multiplier =
        Math.exp(
            -event.deltaY *
            ZOOM_SENSITIVITY
        );

    const newZoom =
        clamp(
            oldZoom *
            multiplier,

            MIN_ZOOM,
            MAX_ZOOM
        );

    /*
     * At minimum zoom, scrolling outward should continue behaving normally.
     */
    if (
        oldZoom <=
            MIN_ZOOM + 0.001 &&
        newZoom <=
            MIN_ZOOM + 0.001
    ) {
        return;
    }

    event.preventDefault();

    const previousZoom =
        state.zoom;

    const rect =
        tile.getBoundingClientRect();

    const pointerX =
        event.clientX -
        (
            rect.left +
            rect.width / 2
        );

    const pointerY =
        event.clientY -
        (
            rect.top +
            rect.height / 2
        );

    const ratio =
        newZoom /
        previousZoom;

    /*
     * Zoom toward the cursor.
     */
    state.x =
        pointerX -
        (
            pointerX -
            state.x
        ) * ratio;

    state.y =
        pointerY -
        (
            pointerY -
            state.y
        ) * ratio;

    state.zoom =
        newZoom;

    if (
        state.zoom <=
        MIN_ZOOM + 0.001
    ) {
        state.zoom =
            MIN_ZOOM;

        state.x = 0;
        state.y = 0;

        savedStates.delete(
            state.key
        );
    }

    apply(
        video,
        state
    );
}

function onMouseDown(
    event: MouseEvent
) {
    if (
        event.defaultPrevented ||
        event.button !== 0
    ) {
        return;
    }

    const tile =
        getVideoTile(
            event.target
        );

    if (!tile)
        return;

    const video =
        getVideo(tile);

    if (!video)
        return;

    const state =
        getState(
            video,
            tile
        );

    if (
        state.zoom <=
        MIN_ZOOM
    ) {
        return;
    }

    dragState = {
        video,
        key:
            state.key,

        startX:
            event.clientX,

        startY:
            event.clientY,

        lastX:
            event.clientX,

        lastY:
            event.clientY,

        moved:
            false
    };

    /*
     * Prevent browser-native video/image dragging.
     *
     * A click is still allowed unless the pointer actually moves enough to
     * cross DRAG_THRESHOLD.
     */
    event.preventDefault();

    apply(
        video,
        state
    );
}

function onMouseMove(
    event: MouseEvent
) {
    if (!dragState)
        return;

    const currentDrag =
        dragState;

    const state =
        states.get(
            currentDrag.video
        );

    if (!state) {
        dragState = null;
        return;
    }

    const totalX =
        event.clientX -
        currentDrag.startX;

    const totalY =
        event.clientY -
        currentDrag.startY;

    if (
        !currentDrag.moved &&
        Math.hypot(
            totalX,
            totalY
        ) >=
            DRAG_THRESHOLD
    ) {
        currentDrag.moved =
            true;
    }

    /*
     * Do not alter pan until the movement is definitely a drag.
     */
    if (!currentDrag.moved)
        return;

    event.preventDefault();

    const deltaX =
        event.clientX -
        currentDrag.lastX;

    const deltaY =
        event.clientY -
        currentDrag.lastY;

    currentDrag.lastX =
        event.clientX;

    currentDrag.lastY =
        event.clientY;

    state.x +=
        deltaX;

    state.y +=
        deltaY;

    apply(
        currentDrag.video,
        state
    );
}

function onMouseUp(
    event: MouseEvent
) {
    if (
        event.button !== 0 ||
        !dragState
    ) {
        return;
    }

    const currentDrag =
        dragState;

    const state =
        states.get(
            currentDrag.video
        );

    dragState = null;

    if (
        currentDrag.moved
    ) {
        /*
         * Browsers normally emit a click after:
         *
         * mousedown -> drag -> mouseup -> click
         *
         * Discord would interpret that click as "focus/fullscreen camera".
         * Suppress it only when an actual pan occurred.
         */
        suppressedClicks.set(
            currentDrag.key,

            Date.now() +
            CLICK_SUPPRESSION_TIME
        );

        event.preventDefault();
    }

    if (state) {
        apply(
            currentDrag.video,
            state
        );
    }
}

function shouldSuppressClick(
    event: MouseEvent
) {
    const tile =
        getVideoTile(
            event.target
        );

    if (!tile)
        return false;

    const video =
        getVideo(tile);

    if (!video)
        return false;

    const key =
        getVideoKey(
            video,
            tile
        );

    const until =
        suppressedClicks.get(
            key
        );

    if (!until)
        return false;

    if (
        Date.now() >
        until
    ) {
        suppressedClicks.delete(
            key
        );

        return false;
    }

    return true;
}

function onClickCapture(
    event: MouseEvent
) {
    if (
        !shouldSuppressClick(
            event
        )
    ) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function onDoubleClickCapture(
    event: MouseEvent
) {
    if (
        !shouldSuppressClick(
            event
        )
    ) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function onAuxClick(
    event: MouseEvent
) {
    /*
     * Middle-click resets zoom and pan.
     */
    if (
        event.button !== 1
    ) {
        return;
    }

    const tile =
        getVideoTile(
            event.target
        );

    if (!tile)
        return;

    const video =
        getVideo(tile);

    if (!video)
        return;

    const state =
        states.get(video);

    const key =
        state?.key ??
        getVideoKey(
            video,
            tile
        );

    const saved =
        savedStates.get(key);

    if (
        !saved &&
        (
            !state ||
            state.zoom <=
                MIN_ZOOM
        )
    ) {
        return;
    }

    event.preventDefault();

    resetVideo(
        video
    );
}

function onWindowBlur() {
    if (!dragState)
        return;

    const currentDrag =
        dragState;

    const state =
        states.get(
            currentDrag.video
        );

    dragState = null;

    if (state) {
        apply(
            currentDrag.video,
            state
        );
    }
}

export default definePlugin({
    name: "WebcamZoom",

    description:
        "Adds aspect-correct webcam viewing, mouse-wheel zooming and click-drag panning.",

    authors: [
        {
            name: "Chay",
            /*
             * Replace this with your Discord user ID if desired.
             */
            id: 0n
        }
    ],

    tags: [
        "Voice",
        "Media"
    ],

    start() {
        /*
         * Wheel zoom.
         */
        document.addEventListener(
            "wheel",
            onWheel,
            {
                passive: false
            }
        );

        /*
         * Drag panning.
         */
        document.addEventListener(
            "mousedown",
            onMouseDown
        );

        document.addEventListener(
            "mousemove",
            onMouseMove
        );

        document.addEventListener(
            "mouseup",
            onMouseUp
        );

        /*
         * Capture-phase handlers prevent the click generated after a pan
         * from making the camera focused/fullscreen.
         */
        document.addEventListener(
            "click",
            onClickCapture,
            true
        );

        document.addEventListener(
            "dblclick",
            onDoubleClickCapture,
            true
        );

        /*
         * Middle-click reset.
         */
        document.addEventListener(
            "auxclick",
            onAuxClick
        );

        /*
         * When video metadata becomes available we can calculate its real
         * transmitted aspect ratio and pan bounds accurately.
         */
        document.addEventListener(
            "loadedmetadata",
            onLoadedMetadata,
            true
        );

        window.addEventListener(
            "blur",
            onWindowBlur
        );

        /*
         * Discord frequently destroys/recreates/reparents video elements
         * when switching between:
         *
         * - normal call grid
         * - focused camera
         * - stage
         * - fullscreen
         *
         * Rescan whenever that happens.
         */
        observer =
            new MutationObserver(
                scheduleVideoScan
            );

        observer.observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );

        scheduleVideoScan();
    },

    stop() {
        document.removeEventListener(
            "wheel",
            onWheel
        );

        document.removeEventListener(
            "mousedown",
            onMouseDown
        );

        document.removeEventListener(
            "mousemove",
            onMouseMove
        );

        document.removeEventListener(
            "mouseup",
            onMouseUp
        );

        document.removeEventListener(
            "click",
            onClickCapture,
            true
        );

        document.removeEventListener(
            "dblclick",
            onDoubleClickCapture,
            true
        );

        document.removeEventListener(
            "auxclick",
            onAuxClick
        );

        document.removeEventListener(
            "loadedmetadata",
            onLoadedMetadata,
            true
        );

        window.removeEventListener(
            "blur",
            onWindowBlur
        );

        observer?.disconnect();
        observer = null;

        if (
            scanFrame !== null
        ) {
            cancelAnimationFrame(
                scanFrame
            );

            scanFrame = null;
        }

        dragState = null;

        suppressedClicks.clear();
        savedStates.clear();

        /*
         * Restore every Discord element exactly to its original inline
         * styling when the plugin is disabled.
         */
        for (
            const video of
            [...activeVideos]
        ) {
            const state =
                states.get(video);

            if (state) {
                restoreElement(
                    video,
                    state
                );
            }
        }
    }
});