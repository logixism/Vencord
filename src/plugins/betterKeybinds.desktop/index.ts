/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { migratePluginSettings, SettingsStore } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { type PluginNative } from "@utils/types";
import { filters, findByPropsLazy, waitFor } from "@webpack";
import { MediaEngineStore, RunningGameStore, showToast } from "@webpack/common";

import { GameSelector, isBindingEnabled, KeybindGroups, settings } from "./games";
import { type InputEvent, Keybinds, type KeyOptions, Recorder, type Shortcut } from "./input";
import type * as NativeModule from "./native";

const Native = VencordNative.pluginHelpers.BetterKeybinds as PluginNative<typeof NativeModule>;
const runningGameStoreReady = Promise.withResolvers<typeof RunningGameStore>();
waitFor(filters.byStoreName("RunningGameStore"), runningGameStoreReady.resolve);
const inputModules = Promise.all([
    new Promise<any>(resolve => waitFor(["getDiscordUtils", "inputEventRegister"], resolve)),
    new Promise<any>(resolve => waitFor(["addKeybind", "enableAll"], resolve)),
    runningGameStoreReady.promise
]);
const AudioActions = findByPropsLazy("setTemporarySelfMute", "setSelfMute");
const logger = new Logger("BetterKeybinds");
const keybinds = new Keybinds();

type InputWatcher = (device: number, state: number, code: number, deviceId: string) => void;
interface Capture {
    recorder: Recorder;
    finish: (cancel?: boolean) => void;
}

const captures = new Set<Capture>();
const unregisterRecorders = new Set<() => void>();
let watcher: InputWatcher | null = null;
let generation = 0;
let running = false;
let ready = false;
let keybindsEnabled = true;
let configureQueued = false;
let refreshQueued = false;
let restoreNative: (() => void) | undefined;

function configure() {
    const capturing = captures.size > 0 || watcher !== null;
    keybinds.setCapturing(capturing);
    if (!running || !ready || configureQueued) return;
    configureQueued = true;
    queueMicrotask(() => {
        configureQueued = false;
        if (!running || !ready) return;
        const currentGeneration = generation;
        Native.configure(currentGeneration, keybinds.watch(), captures.size > 0 || watcher !== null)
            .catch(error => fail(currentGeneration, String(error)));
    });
}

function refreshGameBindings() {
    if (!running || refreshQueued) return;
    refreshQueued = true;

    queueMicrotask(() => {
        refreshQueued = false;
        if (!running) return;
        const games = RunningGameStore.getRunningGames();
        keybinds.refreshEnabled(id => isBindingEnabled(id, games));
    });
}

function resetInput() {
    if (keybinds.hasActiveHold) {
        AudioActions.setSelfMute("default", true, false);
        if (!MediaEngineStore.getSettings().mute)
            throw new Error("Discord did not apply the safety mute");
    }
    keybinds.reset();
    watcher = null;
    for (const capture of [...captures]) capture.finish(true);
    configure();
}

function fail(currentGeneration: number, message: string) {
    if (!running || currentGeneration !== generation) return;
    ready = false;
    try {
        resetInput();
    } finally {
        logger.error(message);
        showToast(`BetterKeybinds: ${message}`, "failure");
        Native.stop().catch(error => logger.error("Could not stop input helper", error));
    }
}

function registerRecorder(elementId: string, callback: (shortcut: Shortcut) => void) {
    let active: Capture | undefined;
    const start = () => {
        if (active) return;
        if (!ready) {
            showToast("BetterKeybinds input helper is not ready. Check the plugin error and restart Discord.", "failure");
            return;
        }
        const recorder = new Recorder();
        const finish = (cancel = false) => {
            if (!active) return;
            clearTimeout(timer);
            captures.delete(active);
            active = undefined;
            configure();
            callback(cancel ? [] : recorder.result());
        };
        const timer = setTimeout(finish, 5000);
        active = { recorder, finish };
        captures.add(active);
        configure();
    };
    const stop = () => active?.finish();
    const register = DiscordNative.app.registerUserInteractionHandler;
    const listeners = [
        register(elementId, "click", start),
        register(elementId, "focus", start),
        register(elementId, "blur", stop)
    ];
    const unregister = () => {
        for (const remove of listeners) remove();
        active?.finish(true);
        unregisterRecorders.delete(unregister);
    };
    unregisterRecorders.add(unregister);
    return unregister;
}

function focusChanged() {
    const focused = document.hasFocus();
    keybinds.setFocused(focused);
    if (!focused) {
        watcher = null;
        for (const capture of [...captures]) capture.finish();
        configure();
    }
}

migratePluginSettings("BetterKeybinds", "LinuxKeybinds");

export default definePlugin({
    name: "BetterKeybinds",
    description: "Fixes global keyboard and mouse keybinds on Linux and adds per-game activation to Discord's Keybinds menu.",
    tags: ["Shortcuts", "Voice"],
    authors: [Devs.logix],
    requiresRestart: true,
    settings,

    patches: [
        {
            find: "keybindDescriptions:",
            replacement: [
                {
                    match: /(\(0,\i\.jsx\))\(\i,\{keybind:(\i)\}\)(?=\]\}\)\}\))/,
                    replace: "$&,$1($self.GameSelector,{keybind:$2})"
                },
                {
                    // Keep Discord's original row renderer, but group the rows instead
                    // of inserting a divider between every item in one flat list.
                    match: /(\i)\.map\(\((\i),\i\)=>\(0,\i\.jsxs\)\(\i\.Fragment,\{children:\[((\(0,\i\.jsx\))\(\i,\{keybind:\2,keybindDescriptions:\i,keybindActionTypes:\i\}\)),.{0,150}?\]\},\2\.id\)\)/,
                    replace: "$4($self.KeybindGroups,{keybinds:$1,renderKeybind:$2=>$3})"
                }
            ]
        }
    ],

    GameSelector,
    KeybindGroups,

    flux: {
        KEYBINDS_ENABLE_ALL_KEYBINDS({ enable }: { enable: boolean; }) {
            keybindsEnabled = enable;
        },
        KEYBINDS_DELETE_KEYBIND({ id }: { id: string; }) {
            if (settings.store.gameBindings[id])
                delete settings.store.gameBindings[id];
        }
    },

    start() {
        if (DiscordNative?.process?.platform !== "linux")
            throw new Error("BetterKeybinds requires Discord's Linux desktop client");

        running = true;
        const currentGeneration = ++generation;

        inputModules.then(async ([DesktopNative, KeybindActions]) => {
            if (!running || generation !== currentGeneration) return;

            const originalRequire = DesktopNative.requireModule;
            const originalUtils = DesktopNative.getDiscordUtils();
            const utils = Object.create(originalUtils);
            Object.defineProperties(utils, {
                inputEventRegister: {
                    value(id: number, shortcut: Shortcut, callback: (down: boolean) => void, options: KeyOptions) {
                        keybinds.register(id, shortcut, callback, options, isBindingEnabled(id, RunningGameStore.getRunningGames()));
                        configure();
                    }
                },
                inputEventUnregister: {
                    value(id: number) {
                        keybinds.unregister(id);
                        configure();
                    }
                },
                inputCaptureRegisterElement: { value: registerRecorder },
                inputWatchAll: {
                    value(callback: InputWatcher | null) {
                        watcher = callback;
                        configure();
                    }
                }
            });

            const enabled = keybindsEnabled;
            KeybindActions.enableAll(false);
            const requireModule = function (name: string) {
                return name === "discord_utils" ? utils : originalRequire.call(DesktopNative, name);
            };
            DesktopNative.requireModule = requireModule;
            restoreNative = () => {
                const enabled = keybindsEnabled;
                KeybindActions.enableAll(false);
                if (DesktopNative.requireModule === requireModule)
                    DesktopNative.requireModule = originalRequire;
                KeybindActions.enableAll(enabled);
            };
            focusChanged();
            window.addEventListener("focus", focusChanged);
            window.addEventListener("blur", focusChanged);
            RunningGameStore.addChangeListener(refreshGameBindings);
            SettingsStore.addChangeListener("plugins.BetterKeybinds.gameBindings", refreshGameBindings);
            KeybindActions.enableAll(enabled);
            await Native.start(currentGeneration);
            if (!running || generation !== currentGeneration) return;
            ready = true;
            configure();
        }).catch(error => fail(currentGeneration, String(error)));
    },

    stop() {
        try {
            resetInput();
        } finally {
            ready = false;
            running = false;
            ++generation;
            for (const unregister of [...unregisterRecorders]) unregister();
            window.removeEventListener("focus", focusChanged);
            window.removeEventListener("blur", focusChanged);
            RunningGameStore?.removeChangeListener(refreshGameBindings);
            SettingsStore.removeChangeListener("plugins.BetterKeybinds.gameBindings", refreshGameBindings);
            restoreNative?.();
            restoreNative = undefined;
            Native.stop().catch(error => logger.error("Could not stop input helper", error));
        }
    },

    receive(currentGeneration: number, events: InputEvent[]) {
        if (!running || !ready || currentGeneration !== generation) return;
        for (const event of events) {
            keybinds.input(event);
            watcher?.(event[0], event[2] ? 1 : 0, event[1], "");
            for (const capture of [...captures])
                if (capture.recorder.input(event)) capture.finish();
        }
    },

    reset(currentGeneration: number, reason: string) {
        if (!running || currentGeneration !== generation) return;
        resetInput();
        logger.warn("Input state reset", reason);
    },

    failed: fail
});
