/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Quest } from "@vencord/discord-types";
import { QuestRewardType, QuestTaskType } from "@vencord/discord-types/enums";

export type QuestIncludedTypes = Record<QuestTaskType | QuestRewardType, boolean>;

export function questMatchesIncludedTypes(quest: Pick<Quest, "config">, includedTypes: QuestIncludedTypes): boolean {
    const rewardTypeAllowed = quest.config.rewardsConfig.rewards.some(reward => Boolean(includedTypes[reward.type]));
    const taskTypeAllowed = Object.values(quest.config.taskConfigV2.tasks).some(task => Boolean(includedTypes[task.type]));

    return rewardTypeAllowed && taskTypeAllowed;
}

export function normalizeQuestName(quest: Pick<Quest, "config">): string {
    const normalized = quest.config.messages.questName.trim().toUpperCase();
    return normalized.endsWith("QUEST") ? normalized.slice(0, -5).trim() : normalized;
}
