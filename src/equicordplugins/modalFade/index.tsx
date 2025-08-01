/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { filters, findByPropsLazy, mapMangledModuleLazy } from "@webpack";
import { useEffect, useRef } from "@webpack/common";
import type { StoreApi, UseBoundStore } from "zustand";

type Modal = {
    Layer?: any,
    instant?: boolean,
    backdropStyle?: "SUBTLE" | "DARK" | "IMMERSIVE" | "BLUR",
};

const { useModalContext } = mapMangledModuleLazy("ENTERED:this.state.transitionState;return", {
    useModalContext: filters.byCode(")())}")
}) as { useModalContext(): "default" | "popout"; };

const { useModalsStore } = mapMangledModuleLazy("?arguments[1]:{},{contextKey:", {
    useModalsStore: filters.byCode(/^(\i)=>\i\(\i,\1\)$/),
}) as { useModalsStore: UseBoundStore<StoreApi<{ default: Modal[]; popout: Modal[]; }>>; };

const { animated, useSpring, useTransition } = findByPropsLazy("a", "animated", "useTransition");

const ANIMS = {
    SUBTLE: {
        off: { opacity: 1 },
        on: { opacity: 0.9 },
    },
    DARK: {
        off: { opacity: 1 },
        on: { opacity: 0.7 },
    },
    IMMERSIVE: {
        off: { opacity: 1 },
        on: { opacity: 0.7 },
    },
    BLUR: {
        off: { opacity: 1, filter: "blur(0px)" },
        on: { opacity: 0.7, filter: "blur(8px)" },
    },
};

export default definePlugin({
    name: "ModalFade",
    description: "Makes modals fade the backdrop, rather than dimming",
    authors: [Devs.Kyuuhachi],

    patches: [
        {
            find: "contextMenuCallbackNative,!1):window",
            replacement: {
                match: /(?<=\()"div"(?=,\{className:\i\(\)\(\i\?\i\.mobileApp:\i.app\))/,
                replace: "$self.MainWrapper",
            }
        },
        {
            find: ".SUBTLE=\"SUBTLE\"",
            replacement: {
                match: /\(0,\i.\i\)(?=\(\i,\{keys:\i=>\i\?"backdrop":"empty",)/,
                replace: "$self.nullTransition"
            }
        },
    ],

    nullTransition(value: any, args: object) {
        return useTransition(value, {
            ...args,
            from: {},
            enter: { _: 0 }, // Spring gets unhappy if there's zero animations
            leave: {},
        });
    },

    MainWrapper(props: object) {
        const context = useModalContext();
        const modals = useModalsStore(modals => modals[context] ?? []);
        const modal = modals.findLast(modal => modal.Layer == null); // || modal.Layer === AppLayer
        const anim = ANIMS[modal?.backdropStyle ?? "DARK"] ?? ANIMS.DARK;
        const isInstant = modal?.instant;
        const prevIsInstant = usePrevious(isInstant);
        const style = useSpring({
            config: { duration: isInstant || prevIsInstant ? 0 : 300 },
            ...modal != null ? anim.on : anim.off,
        });
        return <animated.div style={style} {...props} />;
    }
});

function usePrevious<T>(value: T | undefined): T | undefined {
    const ref = useRef<T>(undefined);
    useEffect(() => {
        if (ref !== undefined) {
            ref.current = value;
        }
    }, [value]);
    return ref.current;
}
