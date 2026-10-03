/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findModuleId, proxyLazyWebpack, wreq } from "@webpack";

import { QL } from "./logging";

interface DiscordSounds {
    (key: string): string;
    keys(): string[];
}

// Load the asset context directly; Questify does not need to patch Discord's audio player.
const sounds = proxyLazyWebpack<DiscordSounds>(() => {
    const id = findModuleId("./discodo.mp3");
    if (id == null) throw new Error("Discord sound assets are unavailable.");
    return wreq(id);
});
let soundNames: string[] | undefined;

export function defaultAudioNames(): string[] {
    return soundNames ??= sounds.keys().flatMap(key => {
        const match = key.match(/^\.\/([\w-]+)\.mp3$/);
        return match ? [match[1]] : [];
    });
}

export interface AudioPlayerInterface {
    play(): void;
    stop(): void;
}

interface AudioPlayerOptions {
    volume?: number;
    onEnded?: () => void;
    onError?: (error: Error) => void;
}

export function createAudioPlayer(sound: string, options: AudioPlayerOptions = {}): AudioPlayerInterface {
    let audio: HTMLAudioElement | null = null;

    function stop(): void {
        if (!audio) return;
        const current = audio;
        audio = null;
        current.onended = current.onerror = null;
        current.pause();
        current.removeAttribute("src");
        current.load();
    }

    function fail(error: unknown): void {
        stop();
        const cause = error instanceof Error ? error : new Error(String(error));
        QL.error("AUDIO_PLAYBACK_FAILED", cause);
        options.onError?.(cause);
    }

    return {
        play() {
            if (audio) return;
            try {
                const source = defaultAudioNames().includes(sound) ? sounds(`./${sound}.mp3`) : sound;
                const current = audio = new Audio(source);
                current.volume = Math.max(0, Math.min(100, options.volume ?? 100)) / 100;
                current.onended = () => {
                    if (audio !== current) return;
                    stop();
                    options.onEnded?.();
                };
                current.onerror = () => {
                    if (audio === current) fail(new Error(current.error?.message || "Unable to load sound."));
                };
                void current.play().catch(error => {
                    // A stopped preview may reject after a different preview has already started.
                    if (audio === current) fail(error);
                });
            } catch (error) {
                fail(error);
            }
        },
        stop,
    };
}

export function playAudio(sound: string, options: AudioPlayerOptions = {}): AudioPlayerInterface {
    const player = createAudioPlayer(sound, options);
    player.play();
    return player;
}
