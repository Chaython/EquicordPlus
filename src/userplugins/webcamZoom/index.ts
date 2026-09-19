/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_SENSITIVITY = 0.0015;

// Mouse movement required before a click becomes a pan.
const DRAG_THRESHOLD = 3;

// How long Discord clicks are suppressed after completing a pan.
const CLICK_SUPPRESSION_TIME = 500;

interface SavedViewState {
    zoom: number;

    /*
     * Pan stored as -1..1 rather than raw pixels.
     * This means switching between a small call tile and fullscreen
     * retains roughly the same viewed portion of the camera.
     */
    panX: number;
    panY: number;
}

interface ViewState {
    key: string;

    zoom: number;
    x: number;
    y: number;

    tile: HTMLElement;
    mirroredX: boolean;

    originalTranslate: string;
    originalScale: string;
    originalTransformOrigin: string;
    originalWillChange: string;

    originalTileOverflow: string;
    originalTileCursor: string;
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
 * Unlike `states`, this survives Discord replacing the <video> element
 * when switching between grid view and fullscreen.
 */
const savedStates = new Map<string, SavedViewState>();

const suppressedClicks = new Map<string, number>();

let dragState: DragState | null = null;
let observer: MutationObserver | null = null;
let scanFrame: number | null = null;

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function getVideoTile(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element))
        return null;

    return target.closest<HTMLElement>("[data-selenium-video-tile]");
}

function getVideo(tile: HTMLElement): HTMLVideoElement | null {
    return tile.querySelector<HTMLVideoElement>("video");
}

function getVideoKey(
    video: HTMLVideoElement,
    tile: HTMLElement
): string {
    /*
     * MediaStream.id is the preferred identifier.
     *
     * When Discord recreates a <video> element to enter fullscreen,
     * the same underlying MediaStream normally remains attached.
     */
    const source = video.srcObject;

    if (source instanceof MediaStream && source.id)
        return `stream:${source.id}`;

    /*
     * Fallback for Discord implementations where srcObject isn't directly
     * exposed on the element.
     */
    const tileId = tile.getAttribute("data-selenium-video-tile");

    if (tileId)
        return `tile:${tileId}`;

    if (video.currentSrc)
        return `src:${video.currentSrc}`;

    /*
     * Last-resort fallback. This cannot survive replacing the element,
     * but avoids breaking zoom entirely if Discord changes its media setup.
     */
    return `video:${video.dataset.webcamZoomId ??= crypto.randomUUID()}`;
}

function isMirrored(video: HTMLVideoElement) {
    try {
        const transform = getComputedStyle(video).transform;

        if (!transform || transform === "none")
            return false;

        const matrix = new DOMMatrixReadOnly(transform);

        return matrix.a < 0;
    } catch {
        return false;
    }
}

function getPanLimits(
    tile: HTMLElement,
    zoom: number
) {
    const rect = tile.getBoundingClientRect();

    return {
        x: Math.max(0, rect.width * (zoom - 1) / 2),
        y: Math.max(0, rect.height * (zoom - 1) / 2)
    };
}

function createState(
    video: HTMLVideoElement,
    tile: HTMLElement,
    key: string
): ViewState {
    const saved = savedStates.get(key);

    const zoom = saved?.zoom ?? 1;
    const limits = getPanLimits(tile, zoom);

    const state: ViewState = {
        key,

        zoom,

        /*
         * Convert normalized pan back into pixels for the current tile size.
         * This is what allows a pan position to survive going fullscreen.
         */
        x: (saved?.panX ?? 0) * limits.x,
        y: (saved?.panY ?? 0) * limits.y,

        tile,
        mirroredX: isMirrored(video),

        originalTranslate: video.style.translate,
        originalScale: video.style.scale,
        originalTransformOrigin: video.style.transformOrigin,
        originalWillChange: video.style.willChange,

        originalTileOverflow: tile.style.overflow,
        originalTileCursor: tile.style.cursor
    };

    states.set(video, state);
    activeVideos.add(video);

    return state;
}

function restoreElement(
    video: HTMLVideoElement,
    state: ViewState
) {
    video.style.translate = state.originalTranslate;
    video.style.scale = state.originalScale;
    video.style.transformOrigin = state.originalTransformOrigin;
    video.style.willChange = state.originalWillChange;

    state.tile.style.overflow = state.originalTileOverflow;
    state.tile.style.cursor = state.originalTileCursor;

    states.delete(video);
    activeVideos.delete(video);

    if (dragState?.video === video)
        dragState = null;
}

function getState(
    video: HTMLVideoElement,
    tile: HTMLElement
) {
    const key = getVideoKey(video, tile);
    const current = states.get(video);

    /*
     * Same video but Discord moved it into a new tile/fullscreen container.
     * Restore the old container and reattach using the persistent state.
     */
    if (
        current &&
        (
            current.tile !== tile ||
            current.key !== key
        )
    ) {
        saveState(current);
        restoreElement(video, current);
    }

    return states.get(video) ?? createState(video, tile, key);
}

function clampPan(state: ViewState) {
    const limits = getPanLimits(
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

function saveState(state: ViewState) {
    if (state.zoom <= MIN_ZOOM) {
        savedStates.delete(state.key);
        return;
    }

    const limits = getPanLimits(
        state.tile,
        state.zoom
    );

    savedStates.set(state.key, {
        zoom: state.zoom,

        panX:
            limits.x > 0
                ? clamp(state.x / limits.x, -1, 1)
                : 0,

        panY:
            limits.y > 0
                ? clamp(state.y / limits.y, -1, 1)
                : 0
    });
}

function apply(
    video: HTMLVideoElement,
    state: ViewState
) {
    clampPan(state);

    /*
     * Recheck because Discord can change mirroring when its video layout
     * changes.
     */
    state.mirroredX = isMirrored(video);

    const translateX =
        state.mirroredX
            ? -state.x
            : state.x;

    /*
     * Don't replace `transform`.
     *
     * Discord itself may use transform for webcam mirroring.
     */
    video.style.translate =
        `${translateX}px ${state.y}px`;

    video.style.scale =
        String(state.zoom);

    video.style.transformOrigin =
        "center center";

    video.style.willChange =
        "translate, scale";

    state.tile.style.overflow =
        "hidden";

    state.tile.style.cursor =
        state.zoom > 1
            ? dragState?.video === video
                ? "grabbing"
                : "grab"
            : state.originalTileCursor;

    saveState(state);
}

function resetKey(key: string) {
    savedStates.delete(key);

    for (const video of [...activeVideos]) {
        const state = states.get(video);

        if (!state || state.key !== key)
            continue;

        restoreElement(video, state);
    }
}

function reset(video: HTMLVideoElement) {
    const state = states.get(video);

    if (state) {
        resetKey(state.key);
        return;
    }

    const tile =
        video.closest<HTMLElement>(
            "[data-selenium-video-tile]"
        );

    if (!tile)
        return;

    resetKey(getVideoKey(video, tile));
}

/*
 * Called when Discord inserts/recreates a video tile.
 *
 * This is what makes the zoom immediately reappear when entering or
 * leaving fullscreen without requiring another wheel event first.
 */
function restoreSavedVideo(
    video: HTMLVideoElement
) {
    const tile =
        video.closest<HTMLElement>(
            "[data-selenium-video-tile]"
        );

    if (!tile)
        return;

    const key = getVideoKey(video, tile);
    const saved = savedStates.get(key);

    if (!saved || saved.zoom <= MIN_ZOOM)
        return;

    const current = states.get(video);

    if (
        current &&
        current.key === key &&
        current.tile === tile
    ) {
        return;
    }

    if (current)
        restoreElement(video, current);

    const state = createState(
        video,
        tile,
        key
    );

    apply(video, state);
}

function scanVideos() {
    scanFrame = null;

    document
        .querySelectorAll<HTMLVideoElement>(
            "[data-selenium-video-tile] video"
        )
        .forEach(restoreSavedVideo);
}

function scheduleVideoScan() {
    if (scanFrame !== null)
        return;

    scanFrame =
        requestAnimationFrame(scanVideos);
}

function onWheel(event: WheelEvent) {
    /*
     * Allow Discord's built-in stream zoom to take priority.
     */
    if (
        event.defaultPrevented ||
        event.ctrlKey
    ) {
        return;
    }

    const tile =
        getVideoTile(event.target);

    if (!tile)
        return;

    const video = getVideo(tile);

    if (!video)
        return;

    const key =
        getVideoKey(video, tile);

    const existing =
        states.get(video);

    const saved =
        savedStates.get(key);

    const oldZoom =
        existing?.zoom ??
        saved?.zoom ??
        MIN_ZOOM;

    const multiplier =
        Math.exp(
            -event.deltaY *
            ZOOM_SENSITIVITY
        );

    const newZoom =
        clamp(
            oldZoom * multiplier,
            MIN_ZOOM,
            MAX_ZOOM
        );

    /*
     * At 1x, scrolling outward shouldn't trap the user's normal wheel.
     */
    if (
        oldZoom === MIN_ZOOM &&
        newZoom === MIN_ZOOM
    ) {
        return;
    }

    event.preventDefault();

    const state =
        getState(video, tile);

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
        newZoom / previousZoom;

    /*
     * Zoom toward the mouse cursor.
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

    state.zoom = newZoom;

    if (
        state.zoom <=
        MIN_ZOOM + 0.001
    ) {
        resetKey(state.key);
        return;
    }

    apply(video, state);
}

function onMouseDown(event: MouseEvent) {
    if (
        event.defaultPrevented ||
        event.button !== 0
    ) {
        return;
    }

    const tile =
        getVideoTile(event.target);

    if (!tile)
        return;

    const video = getVideo(tile);

    if (!video)
        return;

    const state =
        states.get(video);

    const key =
        getVideoKey(video, tile);

    const saved =
        savedStates.get(key);

    const zoom =
        state?.zoom ??
        saved?.zoom ??
        1;

    if (zoom <= 1)
        return;

    const attachedState =
        getState(video, tile);

    dragState = {
        video,
        key: attachedState.key,

        startX: event.clientX,
        startY: event.clientY,

        lastX: event.clientX,
        lastY: event.clientY,

        moved: false
    };

    /*
     * Prevent image/text dragging while still allowing a normal click to
     * become fullscreen if the mouse never actually moves.
     */
    event.preventDefault();

    apply(video, attachedState);
}

function onMouseMove(event: MouseEvent) {
    if (!dragState)
        return;

    const { video } =
        dragState;

    const state =
        states.get(video);

    if (!state) {
        dragState = null;
        return;
    }

    const totalX =
        event.clientX -
        dragState.startX;

    const totalY =
        event.clientY -
        dragState.startY;

    if (
        !dragState.moved &&
        Math.hypot(totalX, totalY) >=
        DRAG_THRESHOLD
    ) {
        dragState.moved = true;
    }

    /*
     * Don't start changing the pan until this is definitely a drag.
     */
    if (!dragState.moved)
        return;

    event.preventDefault();

    const deltaX =
        event.clientX -
        dragState.lastX;

    const deltaY =
        event.clientY -
        dragState.lastY;

    dragState.lastX =
        event.clientX;

    dragState.lastY =
        event.clientY;

    state.x += deltaX;
    state.y += deltaY;

    apply(video, state);
}

function onMouseUp(event: MouseEvent) {
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

    if (currentDrag.moved) {
        /*
         * A browser normally emits `click` after mousedown -> drag -> mouseup.
         * Discord sees that click and opens the camera fullscreen.
         *
         * Remember this camera temporarily so the capture-phase click handler
         * can discard that synthetic post-drag click.
         */
        suppressedClicks.set(
            currentDrag.key,
            Date.now() +
            CLICK_SUPPRESSION_TIME
        );

        event.preventDefault();
    }

    if (state)
        apply(
            currentDrag.video,
            state
        );
}

function shouldSuppressClick(
    event: MouseEvent
) {
    const tile =
        getVideoTile(event.target);

    if (!tile)
        return false;

    const video = getVideo(tile);

    if (!video)
        return false;

    const key =
        getVideoKey(video, tile);

    const until =
        suppressedClicks.get(key);

    if (!until)
        return false;

    if (Date.now() > until) {
        suppressedClicks.delete(key);
        return false;
    }

    return true;
}

function onClickCapture(event: MouseEvent) {
    if (!shouldSuppressClick(event))
        return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function onDoubleClickCapture(
    event: MouseEvent
) {
    if (!shouldSuppressClick(event))
        return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

/*
 * Middle-click still performs an immediate reset.
 */
function onAuxClick(event: MouseEvent) {
    if (event.button !== 1)
        return;

    const tile =
        getVideoTile(event.target);

    if (!tile)
        return;

    const video = getVideo(tile);

    if (!video)
        return;

    const key =
        getVideoKey(video, tile);

    if (!savedStates.has(key))
        return;

    event.preventDefault();
    resetKey(key);
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

    if (state)
        apply(
            currentDrag.video,
            state
        );
}

export default definePlugin({
    name: "WebcamZoom",

    description:
        "Adds mouse-wheel zooming and click-drag panning to users' webcam video tiles.",

    authors: [
        {
            name: "Chay",
            // Replace with your Discord ID if desired.
            id: 0n
        }
    ],

    tags: [
        "Voice",
        "Media"
    ],

    start() {
        document.addEventListener(
            "wheel",
            onWheel,
            {
                passive: false
            }
        );

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
         * Capture is intentional.
         *
         * Discord/React must not receive the click generated after panning.
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

        document.addEventListener(
            "auxclick",
            onAuxClick
        );

        window.addEventListener(
            "blur",
            onWindowBlur
        );

        /*
         * Watch for Discord recreating/reparenting the camera <video>
         * during fullscreen transitions.
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

        window.removeEventListener(
            "blur",
            onWindowBlur
        );

        observer?.disconnect();
        observer = null;

        if (scanFrame !== null) {
            cancelAnimationFrame(
                scanFrame
            );

            scanFrame = null;
        }

        dragState = null;
        suppressedClicks.clear();

        for (
            const video of
            [...activeVideos]
        ) {
            const state =
                states.get(video);

            if (state)
                restoreElement(
                    video,
                    state
                );
        }

        savedStates.clear();
    }
});