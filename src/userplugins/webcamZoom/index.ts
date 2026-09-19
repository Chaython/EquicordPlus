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

interface ViewState {
    key: string;
    video: HTMLVideoElement;
    container: HTMLElement;

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
    originalOverflow: StyleSnapshot;
    originalCursor: StyleSnapshot;
    originalBackground: StyleSnapshot;
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

interface VideoContext {
    video: HTMLVideoElement;
    container: HTMLElement;
    fullscreen: boolean;
}

interface FullscreenSession {
    overlay: HTMLDivElement;
    video: HTMLVideoElement;
    key: string;
    requestedNativeFullscreen: boolean;
}

const states = new WeakMap<HTMLVideoElement, ViewState>();
const activeVideos = new Set<HTMLVideoElement>();
const savedStates = new Map<string, SavedViewState>();
const suppressedClicks = new Map<string, number>();
const anonymousVideoIds = new WeakMap<HTMLVideoElement, number>();

let nextAnonymousVideoId = 1;
let dragState: DragState | null = null;
let fullscreenSession: FullscreenSession | null = null;
let observer: MutationObserver | null = null;
let scanFrame: number | null = null;

export const settings = definePluginSettings({
    wheelZoom: {
        type: OptionType.BOOLEAN,
        description: "Allow mouse-wheel zooming on webcams",
        default: true
    },

    dragPan: {
        type: OptionType.BOOLEAN,
        description: "Allow click-and-drag panning while a webcam is zoomed",
        default: true,

        onChange() {
            refreshActiveStates();
        }
    },

    rememberView: {
        type: OptionType.BOOLEAN,
        description:
            "Remember zoom and pan when Discord recreates a camera or when switching to/from fullscreen",
        default: true,

        onChange(value) {
            if (!value)
                savedStates.clear();
        }
    },

    fitAspectRatio: {
        type: OptionType.BOOLEAN,
        description:
            "At 1x, show webcams using their real aspect ratio instead of Discord cropping them",
        default: true,

        onChange() {
            refreshActiveStates();
            scheduleVideoScan();
        }
    },

    customFullscreen: {
        type: OptionType.BOOLEAN,
        description:
            "Double-click a webcam to open it in the custom fullscreen viewer",
        default: true,

        onChange(value) {
            if (!value)
                closeCustomFullscreen();
        }
    },

    nativeFullscreen: {
        type: OptionType.BOOLEAN,
        description:
            "Use real system fullscreen for the custom camera viewer when supported",
        default: true
    },

    preventFullscreenWhilePanning: {
        type: OptionType.BOOLEAN,
        description:
            "Prevent a completed drag/pan from also triggering Discord's camera focus action",
        default: true
    },

    middleClickReset: {
        type: OptionType.BOOLEAN,
        description:
            "Middle-click a webcam to reset its zoom and pan",
        default: true
    }
});

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

function isFullscreenContainer(
    container: HTMLElement
) {
    return (
        container.getAttribute(
            FULLSCREEN_ATTRIBUTE
        ) === "true"
    );
}

function getDiscordVideoTile(
    target: EventTarget | null
): HTMLElement | null {
    if (!(target instanceof Element))
        return null;

    return target.closest<HTMLElement>(
        "[data-selenium-video-tile]"
    );
}

function getVisibleVideo(
    container: HTMLElement
): HTMLVideoElement | null {
    const videos =
        container.querySelectorAll<HTMLVideoElement>(
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

function getVideoContext(
    target: EventTarget | null
): VideoContext | null {
    if (!(target instanceof Element))
        return null;

    if (
        target.closest(
            `[${FULLSCREEN_UI_ATTRIBUTE}]`
        )
    ) {
        return null;
    }

    const fullscreen =
        target.closest<HTMLElement>(
            `[${FULLSCREEN_ATTRIBUTE}="true"]`
        );

    if (fullscreen) {
        const video =
            fullscreen.querySelector<HTMLVideoElement>(
                `video[${FULLSCREEN_VIDEO_ATTRIBUTE}]`
            );

        if (!video)
            return null;

        return {
            video,
            container:
                fullscreen,
            fullscreen:
                true
        };
    }

    const tile =
        getDiscordVideoTile(
            target
        );

    if (!tile)
        return null;

    const video =
        getVisibleVideo(
            tile
        );

    if (!video)
        return null;

    return {
        video,
        container:
            tile,
        fullscreen:
            false
    };
}

function getAnonymousVideoId(
    video: HTMLVideoElement
) {
    let id =
        anonymousVideoIds.get(
            video
        );

    if (id === undefined) {
        id =
            nextAnonymousVideoId++;

        anonymousVideoIds.set(
            video,
            id
        );
    }

    return id;
}

function getVideoKey(
    video: HTMLVideoElement,
    container: HTMLElement
): string {
    const source =
        video.srcObject;

    if (
        source instanceof MediaStream &&
        source.id
    ) {
        return `stream:${source.id}`;
    }

    const tile =
        container.closest<HTMLElement>(
            "[data-selenium-video-tile]"
        );

    const tileId =
        tile?.getAttribute(
            "data-selenium-video-tile"
        );

    if (tileId)
        return `tile:${tileId}`;

    if (video.currentSrc)
        return `src:${video.currentSrc}`;

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

        return (
            new DOMMatrixReadOnly(
                transform
            ).a < 0
        );
    } catch {
        return false;
    }
}

/*
 * At exactly 1x:
 *
 * - Custom fullscreen always preserves the sender's full image.
 * - Normal Discord tiles preserve it when fitAspectRatio is enabled.
 *
 * As soon as the user zooms above 1x, this returns false so we switch
 * to object-fit: cover and fill the entire frame.
 */
function shouldContainAtCurrentZoom(
    state: ViewState
) {
    if (
        state.zoom >
        MIN_ZOOM + 0.001
    ) {
        return false;
    }

    if (
        isFullscreenContainer(
            state.container
        )
    ) {
        return true;
    }

    return (
        settings.store
            .fitAspectRatio
    );
}

function applyContainMode(
    state: ViewState
) {
    state.video.style.setProperty(
        "width",
        "100%",
        "important"
    );

    state.video.style.setProperty(
        "height",
        "100%",
        "important"
    );

    state.video.style.setProperty(
        "object-fit",
        "contain",
        "important"
    );

    state.video.style.setProperty(
        "object-position",
        "center center",
        "important"
    );

    state.container.style.setProperty(
        "background-color",
        "#000",
        "important"
    );
}

/*
 * Once zoomed above 1x the video switches to cover.
 *
 * This means a portrait camera no longer remains a narrow portrait strip
 * while zooming. It fills the viewport immediately, and the user can pan
 * around the source image.
 */
function applyCoverMode(
    state: ViewState
) {
    state.video.style.setProperty(
        "width",
        "100%",
        "important"
    );

    state.video.style.setProperty(
        "height",
        "100%",
        "important"
    );

    state.video.style.setProperty(
        "object-fit",
        "cover",
        "important"
    );

    state.video.style.setProperty(
        "object-position",
        "center center",
        "important"
    );

    state.container.style.setProperty(
        "background-color",
        "#000",
        "important"
    );
}

function restorePresentationStyles(
    state: ViewState
) {
    restoreStyle(
        state.video,
        "object-fit",
        state.originalObjectFit
    );

    restoreStyle(
        state.video,
        "object-position",
        state.originalObjectPosition
    );

    restoreStyle(
        state.video,
        "width",
        state.originalWidth
    );

    restoreStyle(
        state.video,
        "height",
        state.originalHeight
    );

    restoreStyle(
        state.container,
        "background-color",
        state.originalBackground
    );
}

function getContainerSize(
    container: HTMLElement
) {
    const rect =
        container.getBoundingClientRect();

    return {
        width:
            rect.width,

        height:
            rect.height
    };
}

function getVideoAspect(
    video: HTMLVideoElement
): number | null {
    if (
        !video.videoWidth ||
        !video.videoHeight
    ) {
        return null;
    }

    return (
        video.videoWidth /
        video.videoHeight
    );
}

/*
 * Actual rendered dimensions for object-fit: contain.
 */
function getContainedVideoSize(
    video: HTMLVideoElement,
    container: HTMLElement
) {
    const {
        width:
            containerWidth,

        height:
            containerHeight
    } =
        getContainerSize(
            container
        );

    if (
        containerWidth <= 0 ||
        containerHeight <= 0
    ) {
        return {
            width: 0,
            height: 0
        };
    }

    const videoAspect =
        getVideoAspect(
            video
        );

    if (!videoAspect) {
        return {
            width:
                containerWidth,

            height:
                containerHeight
        };
    }

    const containerAspect =
        containerWidth /
        containerHeight;

    if (
        videoAspect >
        containerAspect
    ) {
        return {
            width:
                containerWidth,

            height:
                containerWidth /
                videoAspect
        };
    }

    return {
        width:
            containerHeight *
            videoAspect,

        height:
            containerHeight
    };
}

/*
 * Actual rendered dimensions for object-fit: cover.
 *
 * One axis exactly matches the viewport; the other extends beyond it.
 * Those extra pixels are what make it possible to pan around the crop.
 */
function getCoveredVideoSize(
    video: HTMLVideoElement,
    container: HTMLElement
) {
    const {
        width:
            containerWidth,

        height:
            containerHeight
    } =
        getContainerSize(
            container
        );

    if (
        containerWidth <= 0 ||
        containerHeight <= 0
    ) {
        return {
            width: 0,
            height: 0
        };
    }

    const videoAspect =
        getVideoAspect(
            video
        );

    if (!videoAspect) {
        return {
            width:
                containerWidth,

            height:
                containerHeight
        };
    }

    const containerAspect =
        containerWidth /
        containerHeight;

    if (
        videoAspect >
        containerAspect
    ) {
        return {
            width:
                containerHeight *
                videoAspect,

            height:
                containerHeight
        };
    }

    return {
        width:
            containerWidth,

        height:
            containerWidth /
            videoAspect
    };
}

function getBaseVideoSize(
    state: ViewState
) {
    /*
     * 1x:
     * use real contained dimensions.
     */
    if (
        shouldContainAtCurrentZoom(
            state
        )
    ) {
        return getContainedVideoSize(
            state.video,
            state.container
        );
    }

    /*
     * >1x:
     * use actual cover dimensions, including any portion already extending
     * beyond the viewport.
     */
    if (
        state.zoom >
        MIN_ZOOM + 0.001
    ) {
        return getCoveredVideoSize(
            state.video,
            state.container
        );
    }

    /*
     * Aspect-ratio correction disabled at 1x.
     */
    return getContainerSize(
        state.container
    );
}

function getPanLimits(
    state: ViewState
) {
    const rect =
        state.container
            .getBoundingClientRect();

    const base =
        getBaseVideoSize(
            state
        );

    return {
        x: Math.max(
            0,
            (
                base.width *
                state.zoom -
                rect.width
            ) / 2
        ),

        y: Math.max(
            0,
            (
                base.height *
                state.zoom -
                rect.height
            ) / 2
        )
    };
}

function clampPan(
    state: ViewState
) {
    const limits =
        getPanLimits(
            state
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
        !settings.store
            .rememberView
    ) {
        return;
    }

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
            state
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

function loadSavedState(
    state: ViewState
) {
    if (
        !settings.store
            .rememberView
    ) {
        return;
    }

    const saved =
        savedStates.get(
            state.key
        );

    if (!saved)
        return;

    state.zoom =
        saved.zoom;

    const limits =
        getPanLimits(
            state
        );

    state.x =
        saved.panX *
        limits.x;

    state.y =
        saved.panY *
        limits.y;
}

function createState(
    video: HTMLVideoElement,
    container: HTMLElement,
    key: string
): ViewState {
    const state: ViewState = {
        key,
        video,
        container,

        zoom:
            MIN_ZOOM,

        x: 0,
        y: 0,

        mirroredX:
            isMirrored(
                video
            ),

        originalTranslate:
            getStyleSnapshot(
                video,
                "translate"
            ),

        originalScale:
            getStyleSnapshot(
                video,
                "scale"
            ),

        originalTransformOrigin:
            getStyleSnapshot(
                video,
                "transform-origin"
            ),

        originalWillChange:
            getStyleSnapshot(
                video,
                "will-change"
            ),

        originalObjectFit:
            getStyleSnapshot(
                video,
                "object-fit"
            ),

        originalObjectPosition:
            getStyleSnapshot(
                video,
                "object-position"
            ),

        originalWidth:
            getStyleSnapshot(
                video,
                "width"
            ),

        originalHeight:
            getStyleSnapshot(
                video,
                "height"
            ),

        originalOverflow:
            getStyleSnapshot(
                container,
                "overflow"
            ),

        originalCursor:
            getStyleSnapshot(
                container,
                "cursor"
            ),

        originalBackground:
            getStyleSnapshot(
                container,
                "background-color"
            )
    };

    states.set(
        video,
        state
    );

    activeVideos.add(
        video
    );

    loadSavedState(
        state
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
        state.container,
        "overflow",
        state.originalOverflow
    );

    restoreStyle(
        state.container,
        "cursor",
        state.originalCursor
    );

    restoreStyle(
        state.container,
        "background-color",
        state.originalBackground
    );

    states.delete(
        video
    );

    activeVideos.delete(
        video
    );

    if (
        dragState?.video ===
        video
    ) {
        dragState =
            null;
    }
}

function getState(
    video: HTMLVideoElement,
    container: HTMLElement
) {
    const key =
        getVideoKey(
            video,
            container
        );

    const current =
        states.get(
            video
        );

    if (
        current &&
        (
            current.container !==
                container ||
            current.key !==
                key
        )
    ) {
        saveState(
            current
        );

        restoreElement(
            video,
            current
        );
    }

    return (
        states.get(
            video
        ) ??
        createState(
            video,
            container,
            key
        )
    );
}

function apply(
    video: HTMLVideoElement,
    state: ViewState
) {
    /*
     * 1x:
     * show full original aspect ratio.
     *
     * >1x:
     * fill the viewport using cover.
     */
    if (
        shouldContainAtCurrentZoom(
            state
        )
    ) {
        applyContainMode(
            state
        );
    } else if (
        state.zoom >
        MIN_ZOOM + 0.001
    ) {
        applyCoverMode(
            state
        );
    } else {
        restorePresentationStyles(
            state
        );
    }

    clampPan(
        state
    );

    state.mirroredX =
        isMirrored(
            video
        );

    const translateX =
        state.mirroredX
            ? -state.x
            : state.x;

    video.style.setProperty(
        "translate",
        `${translateX}px ${state.y}px`,
        "important"
    );

    video.style.setProperty(
        "scale",
        String(
            state.zoom
        ),
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

    if (
        state.zoom >
            MIN_ZOOM ||
        isFullscreenContainer(
            state.container
        )
    ) {
        state.container.style
            .setProperty(
                "overflow",
                "hidden",
                "important"
            );
    } else {
        restoreStyle(
            state.container,
            "overflow",
            state.originalOverflow
        );
    }

    if (
        settings.store.dragPan &&
        state.zoom >
            MIN_ZOOM
    ) {
        state.container.style
            .setProperty(
                "cursor",
                dragState?.video ===
                    video
                    ? "grabbing"
                    : "grab",
                "important"
            );
    } else {
        restoreStyle(
            state.container,
            "cursor",
            state.originalCursor
        );
    }

    saveState(
        state
    );
}

function refreshActiveStates() {
    for (
        const video of
        [...activeVideos]
    ) {
        const state =
            states.get(
                video
            );

        if (state) {
            apply(
                video,
                state
            );
        }
    }
}

function resetKey(
    key: string
) {
    savedStates.delete(
        key
    );

    for (
        const video of
        [...activeVideos]
    ) {
        const state =
            states.get(
                video
            );

        if (
            !state ||
            state.key !== key
        ) {
            continue;
        }

        state.zoom =
            MIN_ZOOM;

        state.x =
            0;

        state.y =
            0;

        apply(
            video,
            state
        );
    }
}

function resetVideo(
    video: HTMLVideoElement,
    container: HTMLElement
) {
    const state =
        states.get(
            video
        );

    resetKey(
        state?.key ??
        getVideoKey(
            video,
            container
        )
    );
}

function syncStatesForKey(
    key: string,
    except?: HTMLVideoElement
) {
    if (
        !settings.store
            .rememberView
    ) {
        return;
    }

    const saved =
        savedStates.get(
            key
        );

    for (
        const video of
        [...activeVideos]
    ) {
        if (
            video ===
            except
        ) {
            continue;
        }

        const state =
            states.get(
                video
            );

        if (
            !state ||
            state.key !== key
        ) {
            continue;
        }

        if (!saved) {
            state.zoom =
                MIN_ZOOM;

            state.x =
                0;

            state.y =
                0;
        } else {
            state.zoom =
                saved.zoom;

            const limits =
                getPanLimits(
                    state
                );

            state.x =
                saved.panX *
                limits.x;

            state.y =
                saved.panY *
                limits.y;
        }

        apply(
            video,
            state
        );
    }
}

function restoreDiscordVideo(
    video: HTMLVideoElement
) {
    if (
        video.hasAttribute(
            FULLSCREEN_VIDEO_ATTRIBUTE
        )
    ) {
        return;
    }

    const container =
        video.closest<HTMLElement>(
            "[data-selenium-video-tile]"
        );

    if (!container)
        return;

    const state =
        getState(
            video,
            container
        );

    apply(
        video,
        state
    );
}

function scanVideos() {
    scanFrame =
        null;

    document
        .querySelectorAll<HTMLVideoElement>(
            "[data-selenium-video-tile] video"
        )
        .forEach(
            restoreDiscordVideo
        );
}

function scheduleVideoScan() {
    if (
        scanFrame !==
        null
    ) {
        return;
    }

    scanFrame =
        requestAnimationFrame(
            scanVideos
        );
}

function makeFullscreenButton(
    text: string,
    title: string
) {
    const button =
        document.createElement(
            "button"
        );

    button.textContent =
        text;

    button.title =
        title;

    button.setAttribute(
        FULLSCREEN_UI_ATTRIBUTE,
        "true"
    );

    Object.assign(
        button.style,
        {
            position:
                "absolute",

            top:
                "18px",

            right:
                "18px",

            zIndex:
                "10",

            width:
                "44px",

            height:
                "44px",

            border:
                "none",

            borderRadius:
                "50%",

            background:
                "rgba(0, 0, 0, 0.65)",

            color:
                "#fff",

            fontSize:
                "28px",

            lineHeight:
                "40px",

            cursor:
                "pointer",

            fontFamily:
                "sans-serif"
        }
    );

    return button;
}

function createFullscreenHint() {
    const hint =
        document.createElement(
            "div"
        );

    hint.setAttribute(
        FULLSCREEN_UI_ATTRIBUTE,
        "true"
    );

    hint.textContent =
        "Double-click or Esc to exit  •  Wheel to zoom  •  Drag to pan";

    Object.assign(
        hint.style,
        {
            position:
                "absolute",

            left:
                "50%",

            bottom:
                "22px",

            transform:
                "translateX(-50%)",

            zIndex:
                "10",

            pointerEvents:
                "none",

            padding:
                "8px 12px",

            borderRadius:
                "8px",

            background:
                "rgba(0, 0, 0, 0.55)",

            color:
                "#fff",

            fontFamily:
                "sans-serif",

            fontSize:
                "13px",

            whiteSpace:
                "nowrap",

            userSelect:
                "none"
        }
    );

    return hint;
}

function openCustomFullscreen(
    sourceVideo: HTMLVideoElement,
    sourceContainer: HTMLElement
) {
    if (
        !settings.store
            .customFullscreen
    ) {
        return;
    }

    closeCustomFullscreen();

    const sourceState =
        getState(
            sourceVideo,
            sourceContainer
        );

    saveState(
        sourceState
    );

    const key =
        sourceState.key;

    const overlay =
        document.createElement(
            "div"
        );

    overlay.setAttribute(
        FULLSCREEN_ATTRIBUTE,
        "true"
    );

    Object.assign(
        overlay.style,
        {
            position:
                "fixed",

            inset:
                "0",

            zIndex:
                "2147483647",

            width:
                "100vw",

            height:
                "100vh",

            background:
                "#000",

            display:
                "flex",

            alignItems:
                "center",

            justifyContent:
                "center",

            overflow:
                "hidden",

            userSelect:
                "none",

            touchAction:
                "none"
        }
    );

    const video =
        document.createElement(
            "video"
        );

    video.setAttribute(
        FULLSCREEN_VIDEO_ATTRIBUTE,
        "true"
    );

    video.autoplay =
        true;

    video.muted =
        true;

    video.playsInline =
        true;

    video.controls =
        false;

    video.disablePictureInPicture =
        true;

    Object.assign(
        video.style,
        {
            width:
                "100%",

            height:
                "100%",

            objectFit:
                "contain",

            objectPosition:
                "center center",

            background:
                "#000"
        }
    );

    const source =
        sourceVideo.srcObject;

    if (
        source instanceof
        MediaStream
    ) {
        video.srcObject =
            source;
    } else if (
        sourceVideo.currentSrc
    ) {
        video.src =
            sourceVideo.currentSrc;
    }

    if (
        isMirrored(
            sourceVideo
        )
    ) {
        video.style.transform =
            "scaleX(-1)";
    }

    const closeButton =
        makeFullscreenButton(
            "×",
            "Close fullscreen"
        );

    closeButton.addEventListener(
        "click",
        event => {
            event.preventDefault();
            event.stopPropagation();

            closeCustomFullscreen();
        }
    );

    const hint =
        createFullscreenHint();

    overlay.append(
        video,
        closeButton,
        hint
    );

    document.body.append(
        overlay
    );

    const state =
        createState(
            video,
            overlay,
            key
        );

    if (
        !settings.store
            .rememberView
    ) {
        state.zoom =
            MIN_ZOOM;

        state.x =
            0;

        state.y =
            0;
    }

    apply(
        video,
        state
    );

    fullscreenSession = {
        overlay,
        video,
        key,

        requestedNativeFullscreen:
            false
    };

    void video
        .play()
        .catch(
            () => {}
        );

    if (
        settings.store
            .nativeFullscreen &&
        typeof overlay
            .requestFullscreen ===
            "function"
    ) {
        fullscreenSession
            .requestedNativeFullscreen =
            true;

        void overlay
            .requestFullscreen()
            .catch(
                () => {}
            );
    }
}

function closeCustomFullscreen() {
    const session =
        fullscreenSession;

    if (!session)
        return;

    fullscreenSession =
        null;

    const state =
        states.get(
            session.video
        );

    if (state) {
        saveState(
            state
        );

        restoreElement(
            session.video,
            state
        );
    }

    if (
        document.fullscreenElement ===
            session.overlay &&
        typeof document
            .exitFullscreen ===
            "function"
    ) {
        void document
            .exitFullscreen()
            .catch(
                () => {}
            );
    }

    session.video.pause();

    if (
        session.video
            .srcObject
    ) {
        session.video.srcObject =
            null;
    }

    session.overlay.remove();

    syncStatesForKey(
        session.key
    );

    scheduleVideoScan();
}

function onFullscreenChange() {
    const session =
        fullscreenSession;

    if (
        !session ||
        !session
            .requestedNativeFullscreen
    ) {
        return;
    }

    if (
        document.fullscreenElement !==
        session.overlay
    ) {
        closeCustomFullscreen();
    }
}

function onWheel(
    event: WheelEvent
) {
    if (
        !settings.store
            .wheelZoom ||
        event.defaultPrevented ||
        event.ctrlKey
    ) {
        return;
    }

    const context =
        getVideoContext(
            event.target
        );

    if (!context)
        return;

    const {
        video,
        container
    } =
        context;

    const state =
        getState(
            video,
            container
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

    if (
        oldZoom <=
            MIN_ZOOM +
            0.001 &&
        newZoom <=
            MIN_ZOOM +
            0.001
    ) {
        return;
    }

    event.preventDefault();

    const rect =
        container
            .getBoundingClientRect();

    const pointerX =
        event.clientX -
        (
            rect.left +
            rect.width /
            2
        );

    const pointerY =
        event.clientY -
        (
            rect.top +
            rect.height /
            2
        );

    const ratio =
        newZoom /
        oldZoom;

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
        MIN_ZOOM +
        0.001
    ) {
        state.zoom =
            MIN_ZOOM;

        state.x =
            0;

        state.y =
            0;

        if (
            settings.store
                .rememberView
        ) {
            savedStates.delete(
                state.key
            );
        }
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
        !settings.store
            .dragPan ||
        event.defaultPrevented ||
        event.button !== 0
    ) {
        return;
    }

    const context =
        getVideoContext(
            event.target
        );

    if (!context)
        return;

    const {
        video,
        container
    } =
        context;

    const state =
        getState(
            video,
            container
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

    event.preventDefault();

    apply(
        video,
        state
    );
}

function onMouseMove(
    event: MouseEvent
) {
    if (
        !settings.store
            .dragPan ||
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

    if (!state) {
        dragState =
            null;

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

    if (
        !currentDrag.moved
    ) {
        return;
    }

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

    dragState =
        null;

    if (
        currentDrag.moved &&
        settings.store
            .preventFullscreenWhilePanning
    ) {
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
    if (
        !settings.store
            .preventFullscreenWhilePanning
    ) {
        return false;
    }

    const context =
        getVideoContext(
            event.target
        );

    if (!context)
        return false;

    const key =
        getVideoKey(
            context.video,
            context.container
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

function suppressEvent(
    event: MouseEvent
) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function onClickCapture(
    event: MouseEvent
) {
    if (
        shouldSuppressClick(
            event
        )
    ) {
        suppressEvent(
            event
        );
    }
}

function onDoubleClickCapture(
    event: MouseEvent
) {
    if (
        shouldSuppressClick(
            event
        )
    ) {
        suppressEvent(
            event
        );

        return;
    }

    if (
        !settings.store
            .customFullscreen
    ) {
        return;
    }

    const target =
        event.target;

    if (
        !(target instanceof
            Element)
    ) {
        return;
    }

    const fullscreen =
        target.closest<HTMLElement>(
            `[${FULLSCREEN_ATTRIBUTE}="true"]`
        );

    if (fullscreen) {
        if (
            target.closest(
                `[${FULLSCREEN_UI_ATTRIBUTE}]`
            )
        ) {
            return;
        }

        suppressEvent(
            event
        );

        closeCustomFullscreen();

        return;
    }

    const context =
        getVideoContext(
            target
        );

    if (
        !context ||
        context.fullscreen
    ) {
        return;
    }

    suppressEvent(
        event
    );

    openCustomFullscreen(
        context.video,
        context.container
    );
}

function onAuxClick(
    event: MouseEvent
) {
    if (
        !settings.store
            .middleClickReset ||
        event.button !== 1
    ) {
        return;
    }

    const context =
        getVideoContext(
            event.target
        );

    if (!context)
        return;

    const state =
        states.get(
            context.video
        );

    if (
        !state ||
        state.zoom <=
            MIN_ZOOM
    ) {
        return;
    }

    event.preventDefault();

    resetVideo(
        context.video,
        context.container
    );
}

function onKeyDown(
    event: KeyboardEvent
) {
    if (
        event.key !==
            "Escape" ||
        !fullscreenSession
    ) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    closeCustomFullscreen();
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

    dragState =
        null;

    if (state) {
        apply(
            currentDrag.video,
            state
        );
    }
}

function onLoadedMetadata(
    event: Event
) {
    if (
        !(
            event.target instanceof
            HTMLVideoElement
        )
    ) {
        return;
    }

    const video =
        event.target;

    if (
        video.hasAttribute(
            FULLSCREEN_VIDEO_ATTRIBUTE
        )
    ) {
        const state =
            states.get(
                video
            );

        if (state) {
            if (
                settings.store
                    .rememberView
            ) {
                loadSavedState(
                    state
                );
            }

            apply(
                video,
                state
            );
        }

        return;
    }

    restoreDiscordVideo(
        video
    );
}

export default definePlugin({
    name:
        "WebcamZoom",

    description:
        "Adds aspect-correct webcams, mouse-wheel zoom, drag panning and true fullscreen camera viewing.",

    authors: [
        {
            name:
                "Chaython",

            id:
                1415804298771824740n
        }
    ],

    tags: [
        "Voice",
        "Media"
    ],

    settings,

    start() {
        document.addEventListener(
            "wheel",
            onWheel,
            {
                passive:
                    false
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

        document.addEventListener(
            "loadedmetadata",
            onLoadedMetadata,
            true
        );

        document.addEventListener(
            "keydown",
            onKeyDown,
            true
        );

        document.addEventListener(
            "fullscreenchange",
            onFullscreenChange
        );

        window.addEventListener(
            "blur",
            onWindowBlur
        );

        observer =
            new MutationObserver(
                scheduleVideoScan
            );

        observer.observe(
            document.body,
            {
                childList:
                    true,

                subtree:
                    true
            }
        );

        scheduleVideoScan();
    },

    stop() {
        closeCustomFullscreen();

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

        document.removeEventListener(
            "keydown",
            onKeyDown,
            true
        );

        document.removeEventListener(
            "fullscreenchange",
            onFullscreenChange
        );

        window.removeEventListener(
            "blur",
            onWindowBlur
        );

        observer?.disconnect();

        observer =
            null;

        if (
            scanFrame !==
            null
        ) {
            cancelAnimationFrame(
                scanFrame
            );

            scanFrame =
                null;
        }

        dragState =
            null;

        suppressedClicks.clear();
        savedStates.clear();

        for (
            const video of
            [...activeVideos]
        ) {
            const state =
                states.get(
                    video
                );

            if (state) {
                restoreElement(
                    video,
                    state
                );
            }
        }
    }
});