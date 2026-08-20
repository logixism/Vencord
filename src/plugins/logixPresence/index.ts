/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { Activity, ActivityAssets } from "@vencord/discord-types";
import { ActivityFlags, ActivityStatusDisplayType, ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

const Native = VencordNative.pluginHelpers.LogixPresence as PluginNative<typeof import("./native")>;

const logger = new Logger("LogixPresence");

const APPLICATION_ID = "1108588077900898414";
const UPDATE_INTERVAL = 15_000;
const SOCKET_ID = "LogixPresence";

export type ActivityTypeName = "playing" | "listening" | "watching" | "coding";

export interface PresenceActivity {
    type: ActivityTypeName;
    name: string;
    details?: string;
    href?: string;
    imageUrl?: string;
    startedAt: number;
    endsAt?: number;
}

export interface PresenceView {
    avatarUrl: string;
    activity?: PresenceActivity;
    lastActivity?: PresenceActivity;
    activityGoneAt?: number;
}

let updateInterval: ReturnType<typeof setInterval> | undefined;
let updateGeneration = 0;

function setActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: SOCKET_ID
    });
}

async function makeActivity(presence: PresenceView | null): Promise<Activity | null> {
    const activity = presence?.activity;
    if (activity?.type !== "listening" || !activity.name)
        return null;

    const assets: ActivityAssets | undefined = activity.imageUrl ? {
        large_image: (await ApplicationAssetUtils.fetchAssetIds(APPLICATION_ID, [activity.imageUrl]))[0],
        large_text: activity.name,
        large_url: activity.href
    } : undefined;

    return {
        application_id: APPLICATION_ID,
        name: "logix.wtf",
        details: activity.details ?? "some music",
        details_url: activity.href,
        timestamps: {
            start: activity.startedAt,
            end: activity.endsAt
        },
        assets,
        type: ActivityType.LISTENING,
        status_display_type: ActivityStatusDisplayType.DETAILS,
        flags: ActivityFlags.INSTANCE
    };
}

export default definePlugin({
    name: "LogixPresence",
    description: "Displays the current listening activity from logix.wtf as Rich Presence",
    tags: ["Activity", "Media"],
    authors: [Devs.logix],

    start() {
        const generation = ++updateGeneration;
        this.updatePresence(generation);
        updateInterval = setInterval(() => this.updatePresence(generation), UPDATE_INTERVAL);
    },

    stop() {
        ++updateGeneration;
        clearInterval(updateInterval);
        updateInterval = undefined;
        setActivity(null);
    },

    async updatePresence(generation: number) {
        try {
            const activity = await makeActivity(await Native.fetchPresence());
            if (generation === updateGeneration)
                setActivity(activity);
        } catch (error) {
            logger.error("Failed to fetch presence", error);
            if (generation === updateGeneration)
                setActivity(null);
        }
    }
});
