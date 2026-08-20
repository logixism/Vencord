/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

import type { PresenceView } from ".";

const PRESENCE_URL = "https://logix.wtf/api/presence";
const REQUEST_TIMEOUT = 10_000;

export async function fetchPresence(_: IpcMainInvokeEvent): Promise<PresenceView | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
        const response = await fetch(PRESENCE_URL, {
            headers: { Accept: "text/event-stream" },
            signal: controller.signal
        });

        if (!response.ok)
            throw new Error(`${response.status} ${response.statusText}`);
        if (!response.body)
            throw new Error("Presence response did not contain a body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });

            let separator: RegExpMatchArray | null;
            while ((separator = buffer.match(/\r?\n\r?\n/))) {
                const event = buffer.slice(0, separator.index);
                buffer = buffer.slice(separator.index! + separator[0].length);

                const data = event
                    .split(/\r?\n/)
                    .filter(line => line.startsWith("data:"))
                    .map(line => line.slice(5).trimStart())
                    .join("\n");

                if (data)
                    return JSON.parse(data);
            }

            if (done)
                return null;
        }
    } finally {
        clearTimeout(timeout);
        controller.abort();
    }
}
