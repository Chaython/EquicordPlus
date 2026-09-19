/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

// Larger = faster mouse-wheel zooming.
const ZOOM_SENSITIVITY = 0.0015;

interface ViewState {
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
    lastX: number;
    lastY: number;
}

const states = new WeakMap<HTMLVideoElement, ViewState>();
const activeVideos = new Set<HTMLVideoElement>();

let dragState: DragState | null = null;

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function getVideoTile(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;

    return target.closest<HTMLElement>("[data-selenium-video-tile]");
}

function getVideo(tile: HTMLElement): HTMLVideoElement | null {
    return tile.querySelector<HTMLVideoElement>("video");
}

function isMirrored(video: HTMLVideoElement) {
    try {
        const transform = getComputedStyle(video).transform;

        if (!transform || transform === "none")
            return false;

        const matrix = new DOMMatrixReadOnly(transform);

        // Discord commonly mirrors the local webcam using scaleX(-1).
        return matrix.a < 0;
    } catch {
        return false;
    }
}

function createState(video: HTMLVideoElement, tile: HTMLElement): ViewState {
    const state: ViewState = {
        zoom: 1,
        x: 0,
        y: 0,

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

function getState(video: HTMLVideoElement, tile: HTMLElement) {
    const current = states.get(video);

    if (current && current.tile === tile)
        return current;

    if (current)
        restore(video, current);

    return createState(video, tile);
}

function getPanLimits(state: ViewState) {
    const rect = state.tile.getBoundingClientRect();

    return {
        x: Math.max(0, rect.width * (state.zoom - 1) / 2),
        y: Math.max(0, rect.height * (state.zoom - 1) / 2)
    };
}

function clampPan(state: ViewState) {
    const limits = getPanLimits(state);

    state.x = clamp(state.x, -limits.x, limits.x);
    state.y = clamp(state.y, -limits.y, limits.y);
}

function apply(video: HTMLVideoElement, state: ViewState) {
    clampPan(state);

    /*
     * Use the individual CSS translate/scale properties instead of replacing
     * transform. Discord uses transform itself for things such as mirrored
     * local-camera previews, so replacing it would break Discord's styling.
     */
    const translateX = state.mirroredX
        ? -state.x
        : state.x;

    video.style.translate = `${translateX}px ${state.y}px`;
    video.style.scale = String(state.zoom);
    video.style.transformOrigin = "center center";
    video.style.willChange = "translate, scale";

    state.tile.style.overflow = "hidden";
    state.tile.style.cursor = state.zoom > 1
        ? dragState?.video === video
            ? "grabbing"
            : "grab"
        : state.originalTileCursor;
}

function restore(video: HTMLVideoElement, state: ViewState) {
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

function reset(video: HTMLVideoElement) {
    const state = states.get(video);

    if (state)
        restore(video, state);
}

function onWheel(event: WheelEvent) {
    /*
     * Discord gets the event before this document-level listener.
     *
     * If Discord's native stream zoom already handled the wheel event,
     * don't apply webcam zoom on top of it.
     */
    if (event.defaultPrevented || event.ctrlKey)
        return;

    const tile = getVideoTile(event.target);

    if (!tile)
        return;

    const video = getVideo(tile);

    if (!video)
        return;

    const oldState = states.get(video);
    const oldZoom = oldState?.zoom ?? 1;

    // Smooth exponential scaling works with both mouse wheels and touchpads.
    const multiplier = Math.exp(-event.deltaY * ZOOM_SENSITIVITY);

    const newZoom = clamp(
        oldZoom * multiplier,
        MIN_ZOOM,
        MAX_ZOOM
    );

    /*
     * At minimum zoom, allow downward scrolling to behave normally.
     */
    if (oldZoom === MIN_ZOOM && newZoom === MIN_ZOOM)
        return;

    event.preventDefault();

    const state = getState(video, tile);

    const previousZoom = state.zoom;

    /*
     * Zoom toward the mouse cursor rather than always zooming toward the
     * exact centre of the webcam.
     */
    const rect = tile.getBoundingClientRect();

    const pointerX =
        event.clientX - (rect.left + rect.width / 2);

    const pointerY =
        event.clientY - (rect.top + rect.height / 2);

    const ratio = newZoom / previousZoom;

    state.x =
        pointerX - (pointerX - state.x) * ratio;

    state.y =
        pointerY - (pointerY - state.y) * ratio;

    state.zoom = newZoom;

    if (state.zoom <= MIN_ZOOM + 0.001) {
        reset(video);
        return;
    }

    apply(video, state);
}

function onMouseDown(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0)
        return;

    const tile = getVideoTile(event.target);

    if (!tile)
        return;

    const video = getVideo(tile);

    if (!video)
        return;

    const state = states.get(video);

    if (!state || state.zoom <= 1)
        return;

    event.preventDefault();

    dragState = {
        video,
        lastX: event.clientX,
        lastY: event.clientY
    };

    apply(video, state);
}

function onMouseMove(event: MouseEvent) {
    if (!dragState)
        return;

    const { video } = dragState;
    const state = states.get(video);

    if (!state) {
        dragState = null;
        return;
    }

    const deltaX = event.clientX - dragState.lastX;
    const deltaY = event.clientY - dragState.lastY;

    dragState.lastX = event.clientX;
    dragState.lastY = event.clientY;

    state.x += deltaX;
    state.y += deltaY;

    apply(video, state);
}

function onMouseUp(event: MouseEvent) {
    if (event.button !== 0 || !dragState)
        return;

    const video = dragState.video;
    const state = states.get(video);

    dragState = null;

    if (state)
        apply(video, state);
}

/*
 * Middle-click is a convenient reset without stealing Discord's normal
 * double-click behaviour.
 */
function onAuxClick(event: MouseEvent) {
    if (event.button !== 1)
        return;

    const tile = getVideoTile(event.target);

    if (!tile)
        return;

    const video = getVideo(tile);

    if (!video || !states.has(video))
        return;

    event.preventDefault();
    reset(video);
}

function onWindowBlur() {
    if (!dragState)
        return;

    const video = dragState.video;
    const state = states.get(video);

    dragState = null;

    if (state)
        apply(video, state);
}

export default definePlugin({
    name: "WebcamZoom",

    description:
        "Adds mouse-wheel zooming and click-drag panning to users' webcam video tiles.",

    authors: [
        {
            name: "Chay",
            // Replace this with your Discord user ID if you want.
            id: 0n
        }
    ],

    tags: ["Voice", "Media"],

    start() {
        /*
         * Deliberately don't use capture mode. Discord's own stream player
         * therefore gets first chance to handle its zoom/pan interactions.
         */
        document.addEventListener("wheel", onWheel, {
            passive: false
        });

        document.addEventListener("mousedown", onMouseDown);
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        document.addEventListener("auxclick", onAuxClick);

        window.addEventListener("blur", onWindowBlur);
    },

    stop() {
        document.removeEventListener("wheel", onWheel);
        document.removeEventListener("mousedown", onMouseDown);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.removeEventListener("auxclick", onAuxClick);

        window.removeEventListener("blur", onWindowBlur);

        dragState = null;

        for (const video of [...activeVideos]) {
            const state = states.get(video);

            if (state)
                restore(video, state);
        }
    }
});