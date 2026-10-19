/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { getCurrentUserId, getQuestifySettings } from "@plugins/questify/settings/access";
import { questIsIgnored } from "@plugins/questify/settings/ignoredQuests";
import { sleep } from "@utils/misc";
import type { PluginNative } from "@utils/types";
import type { Quest } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { QuestStore, RestAPI } from "@webpack/common";
import { NavigationRouter } from "@webpack/common/utils";

import { playAudio } from "./audio";
import { normalizeQuestName, type QuestIncludedTypes, questMatchesIncludedTypes } from "./filtering";
import { QL } from "./logging";
import { QUEST_PAGE } from "./ui";

const QuestifyNative = VencordNative?.pluginHelpers?.Questify as PluginNative<typeof import("../native")> | undefined;

type NotifiableQuest = Pick<Quest, "id" | "config">;

export interface QuestRefresh {
    quests: Quest[];
    excludedQuests: { id: string; }[];
}

interface QuestNotificationSession {
    userId: string;
    initialized: boolean;
    questIds: Set<string>;
    excludedQuestIds: Set<string>;
}

let notificationSession: QuestNotificationSession | undefined;

export function snakeToCamel(obj: any): any {
    if (Array.isArray(obj)) {
        return obj.map(snakeToCamel);
    }

    if (obj && typeof obj === "object") {
        return Object.fromEntries(
            Object.entries(obj).map(([key, value]) => [
                key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
                snakeToCamel(value),
            ]),
        );
    }

    return obj;
}

export const fetchAndDispatchQuests = findByCodeLazy("QUESTS_FETCH_CURRENT_QUESTS_BEGIN");
const parseQuestConfig = findByCodeLazy("config).with({config_version:");
const formatQuestConfig = findByCodeLazy("taskConfigV2:", "config_version:2");

async function fetchQuestById(questId: string): Promise<NotifiableQuest | null> {
    try {
        const { body } = await RestAPI.get({ url: `/quests/${questId}`, retries: 3 });
        const valid = !!parseQuestConfig({ config: body });

        if (!valid) {
            QL.warn("FETCH_QUEST_BY_ID_INVALID_BODY", { questId, body });

            return null;
        }

        return { id: questId, config: formatQuestConfig(body) };
    } catch (error: unknown) {
        QL.warn("FETCH_QUEST_BY_ID_FAILED", { questId, error });

        return null;
    }
}

async function fetchExcludedQuestConfigs(questIds: string[], session: QuestNotificationSession): Promise<NotifiableQuest[]> {
    const quests: NotifiableQuest[] = [];

    for (const [index, questId] of questIds.entries()) {
        if (index > 0) {
            await sleep(1000);
        }

        if (!isCurrentNotificationSession(session)) break;

        const quest = await fetchQuestById(questId);

        if (quest) {
            quests.push(quest);
        }
    }

    return quests;
}

export function canOpenDevToolsWindow(): boolean {
    return typeof QuestifyNative?.canOpenDevTools === "function"
        && typeof QuestifyNative?.openDevTools === "function";
}

export async function openDevToolsWindow(): Promise<boolean> {
    if (!canOpenDevToolsWindow()) {
        return false;
    }

    const native = QuestifyNative!;

    return await native.canOpenDevTools()
        ? native.openDevTools()
        : false;
}

function getQuestNotificationText(quests: NotifiableQuest[], excluded: boolean): { title: string; body: string; } {
    const firstQuest = quests[0];
    const firstQuestName = normalizeQuestName(firstQuest);

    if (quests.length === 1) {
        return {
            title: excluded ? "New Excluded Quest Detected!" : "New Quest Detected!",
            body: excluded
                ? `The excluded ${firstQuestName} Quest was detected. ID: ${firstQuest.id}`
                : `The ${firstQuestName} Quest is now available.`
        };
    }

    return {
        title: excluded ? "New Excluded Quests Detected!" : "New Quests Detected!",
        body: excluded
            ? `${quests.length} new excluded Quests were detected. Check the console for their Quest IDs.`
            : `${quests.length} new Quests are now available.`
    };
}

function notifyNewQuests(quests: NotifiableQuest[], excluded: boolean): void {
    if (quests.length === 0) return;

    const firstQuest = quests[0];
    const { title, body } = getQuestNotificationText(quests, excluded);
    const onClick = excluded
        ? canOpenDevToolsWindow() ? openDevToolsWindow : undefined
        : () => NavigationRouter.transitionTo(`${QUEST_PAGE}#${firstQuest.id}`);

    showNotification({
        title,
        body,
        dismissOnClick: true,
        onClick
    });

    QL.log("NOTIFY_NEW_QUESTS", { excluded, quests });
}

function isCurrentNotificationSession(session: QuestNotificationSession): boolean {
    return notificationSession === session && session.userId === getCurrentUserId();
}

export function startQuestNotifications(): void {
    const userId = getCurrentUserId();
    if (!userId || notificationSession?.userId === userId) return;

    const initialized = QuestStore.lastFetchedCurrentQuests > 0;
    notificationSession = {
        userId,
        initialized,
        questIds: new Set(initialized ? QuestStore.quests.keys() : []),
        excludedQuestIds: new Set(initialized ? QuestStore.excludedQuests.keys() : [])
    };
}

export function stopQuestNotifications(): void {
    notificationSession = undefined;
}

function alertNewQuests(quests: NotifiableQuest[], excluded: boolean): void {
    const settings = getQuestifySettings();
    if (settings.disableQuestsEverything) return;

    const includedTypes = settings.questButtonIncludedTypes as QuestIncludedTypes;
    const includedQuests = quests.filter(quest => questMatchesIncludedTypes(quest, includedTypes) && !questIsIgnored(quest.id));
    if (includedQuests.length === 0) return;

    const sound = excluded ? settings.newExcludedQuestAlertSound : settings.newQuestAlertSound;
    const volume = excluded ? settings.newExcludedQuestAlertVolume : settings.newQuestAlertVolume;
    const notify = excluded ? settings.notifyOnNewExcludedQuests : settings.notifyOnNewQuests;

    if (sound) {
        playAudio(sound, { volume: Math.max(0, Math.min(100, volume)) });
    }

    if (notify) {
        notifyNewQuests(includedQuests, excluded);
    }
}

export async function handleQuestRefresh({ quests, excludedQuests }: QuestRefresh): Promise<void> {
    const session = notificationSession;
    if (!session || !isCurrentNotificationSession(session)) return;

    const newQuests: Quest[] = [];
    const newExcludedQuestIds: string[] = [];

    // Consume the authoritative payload before any await, including filtered IDs.
    // Seen IDs survive repeated refreshes and temporary omissions for this session.
    for (const quest of quests) {
        if (!session.questIds.has(quest.id)) {
            session.questIds.add(quest.id);
            if (session.initialized) newQuests.push(quest);
        }
    }
    for (const quest of excludedQuests) {
        if (!session.excludedQuestIds.has(quest.id)) {
            session.excludedQuestIds.add(quest.id);
            if (session.initialized && !questIsIgnored(quest.id)) newExcludedQuestIds.push(quest.id);
        }
    }

    // A successful empty refresh is a baseline too, not an unfetched store.
    session.initialized = true;
    alertNewQuests(newQuests, false);

    const settings = getQuestifySettings();
    if (settings.disableQuestsEverything || newExcludedQuestIds.length === 0
        || !(settings.notifyOnNewExcludedQuests || settings.newExcludedQuestAlertSound)) return;

    const newExcludedQuests = await fetchExcludedQuestConfigs(newExcludedQuestIds, session);
    if (!isCurrentNotificationSession(session)) return;

    alertNewQuests(newExcludedQuests, true);
}
