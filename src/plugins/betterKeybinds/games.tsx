/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { Button, TextButton } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { ExpandableSection } from "@components/ExpandableCard";
import { IS_LINUX } from "@utils/constants";
import { OptionType } from "@utils/types";
import type { RunningGame } from "@vencord/discord-types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ContextMenuApi, Menu, React, RunningGameStore, useStateFromStores } from "@webpack/common";

export type Game = Pick<RunningGame, "id" | "exePath" | "name">;

const LocalActivityStore = findStoreLazy("LocalActivityStore");
const KeybindStore = findStoreLazy("KeybindsStore") as { getUserAgnosticState(): Record<string, Keybind>; };
const KeybindActions = findByPropsLazy("addKeybind", "enableAll");

export function getGameStores() {
    return IS_DISCORD_DESKTOP ? [RunningGameStore] : [RunningGameStore, LocalActivityStore];
}

export function getRunningGames(): readonly Game[] {
    const running = RunningGameStore.getRunningGames();
    if (IS_DISCORD_DESKTOP) return running;

    // Vesktop/arRPC report local playing activities rather than native processes.
    const games: Game[] = [...running];
    for (const activity of LocalActivityStore.getActivities()) {
        if (activity.type !== 0 || !activity.application_id || games.some(game => game.id === activity.application_id)) continue;
        games.push({ id: activity.application_id, name: activity.name, exePath: "" });
    }
    return games;
}

interface Keybind {
    id: string;
}

interface KeybindGroup {
    key: string;
    game?: Game;
    keybinds: Keybind[];
}

export const settings = definePluginSettings({
    linuxCompatibility: {
        type: OptionType.BOOLEAN,
        displayName: "Linux input compatibility",
        description: "Capture global keyboard and mouse shortcuts on Linux/Wayland. Requires official Discord, Python 3 and read access to /dev/input/event*.",
        default: false,
        restartNeeded: true,
        disabled: !(IS_DISCORD_DESKTOP && IS_LINUX)
    },
    gameBindings: {
        type: OptionType.CUSTOM,
        description: "Optional game restrictions for Discord keybinds.",
        default: {} as Record<string, Game | undefined>
    }
});

function gameKey(game: Game) {
    if (game.id) return `id:${game.id}`;
    if (game.exePath) return `path:${game.exePath}`;
    return "";
}

function isRunning(game: Game, runningGames: readonly Game[]) {
    return runningGames.some(running => game.id
        ? running.id === game.id
        : Boolean(game.exePath) && running.exePath === game.exePath);
}

export function isBindingEnabled(id: number, runningGames: readonly Game[]) {
    const game = settings.store.gameBindings[id];
    return !game || isRunning(game, runningGames);
}

function assignKeybind(id: string, game?: Game) {
    if (game) {
        const { id: gameId, name, exePath } = game;
        settings.store.gameBindings[id] = { id: gameId, name, exePath };
    } else {
        delete settings.store.gameBindings[id];
    }
}

function addKeybind(game?: Game): string {
    const previous = KeybindStore.getUserAgnosticState();
    KeybindActions.addKeybind({});
    // Discord assigns the ID and replaces its state synchronously on dispatch.
    for (const id in KeybindStore.getUserAgnosticState()) {
        if (id in previous) continue;
        assignKeybind(id, game);
        return id;
    }
    throw new Error("Discord did not create the keybind");
}

function GameMenu({ selectedKey, exclude, onSelect }: {
    selectedKey?: string;
    exclude?: ReadonlySet<string>;
    onSelect: (game?: Game) => void;
}) {
    const { gameBindings } = settings.use(["gameBindings"]);
    const [seenGames, runningGames] = useStateFromStores(getGameStores(), () => [
        RunningGameStore.getGamesSeen(),
        getRunningGames()
    ] as const);
    const games = new Map<string, Game>();
    // Remember every saved group, including games Discord no longer detects.
    for (const game of [...Object.values(gameBindings), ...seenGames, ...runningGames]) {
        if (!game) continue;
        const key = gameKey(game);
        if (key && !exclude?.has(key)) games.set(key, game);
    }
    const choices = [...games].sort(([, a], [, b]) => a.name.localeCompare(b.name));

    return (
        <Menu.Menu
            navId="vc-better-keybinds-games"
            aria-label={selectedKey === undefined ? "Add game" : "Move keybind to"}
            onClose={ContextMenuApi.closeContextMenu}
        >
            {selectedKey !== undefined && (
                <>
                    <Menu.MenuItem id="global" label="Global" disabled={selectedKey === ""} action={() => onSelect()} />
                    <Menu.MenuSeparator />
                </>
            )}
            {choices.map(([key, game]) => (
                <Menu.MenuItem
                    key={key}
                    id={key}
                    label={game.name}
                    disabled={key === selectedKey}
                    action={() => onSelect(game)}
                />
            ))}
            {!choices.length && <Menu.MenuItem id="no-games" label="No games found" disabled />}
        </Menu.Menu>
    );
}

export const KeybindGroups = ErrorBoundary.wrap(function KeybindGroups({ keybinds, renderKeybind }: {
    keybinds: Keybind[];
    renderKeybind: (keybind: Keybind) => React.ReactNode;
}) {
    const { gameBindings } = settings.use(["gameBindings"]);
    const runningGames = useStateFromStores(getGameStores(), getRunningGames);
    const grouped = new Map<string, KeybindGroup>([["", { key: "", keybinds: [] }]]);
    const assignments = new Map<string, string>();
    for (const keybind of keybinds) {
        const game = gameBindings[keybind.id];
        const key = game ? gameKey(game) : "";
        let group = grouped.get(key);
        if (!group) {
            group = { key, game, keybinds: [] };
            grouped.set(key, group);
        }
        group.keybinds.push(keybind);
        assignments.set(keybind.id, key);
    }
    const groups = [...grouped.values()].sort((a, b) =>
        Number(Boolean(a.game)) - Number(Boolean(b.game))
        || (a.game?.name ?? "").localeCompare(b.game?.name ?? "")
        || a.key.localeCompare(b.key)
    );
    const [expandedGroups, setExpandedGroups] = React.useState<Record<string, boolean>>({});
    const [pendingFocus, setPendingFocus] = React.useState<string>();
    const root = React.useRef<HTMLDivElement>(null);
    const previousAssignments = React.useRef(assignments);

    // Reveal newly added or reassigned shortcuts, without reopening a group the
    // user collapsed when only a game's running status or a row's action changes.
    React.useEffect(() => {
        const reveal = new Set<string>();
        for (const [id, key] of assignments) {
            if (previousAssignments.current.get(id) !== key) reveal.add(key);
        }
        previousAssignments.current = assignments;
        if (!reveal.size) return;
        setExpandedGroups(current => {
            let next = current;
            for (const key of reveal) {
                if (current[key] !== false) continue;
                if (next === current) next = { ...current };
                next[key] = true;
            }
            return next;
        });
    });

    React.useEffect(() => {
        if (!pendingFocus) return;
        const row = root.current?.querySelector<HTMLElement>(`[data-keybind-id="${CSS.escape(pendingFocus)}"]`);
        if (!row) return;
        const frame = requestAnimationFrame(() => {
            row.focus({ preventScroll: true });
            row.scrollIntoView({ block: "nearest" });
            setPendingFocus(undefined);
        });
        return () => cancelAnimationFrame(frame);
    }, [pendingFocus, expandedGroups, keybinds]);

    function addToGroup(game?: Game) {
        setPendingFocus(addKeybind(game));
    }

    return (
        <div ref={root} className="vc-better-keybinds-groups">
            <div className="vc-better-keybinds-toolbar">
                <Button
                    size="small"
                    variant="secondary"
                    aria-haspopup="menu"
                    onClick={event => ContextMenuApi.openContextMenu(event, () => (
                        <GameMenu exclude={new Set(grouped.keys())} onSelect={addToGroup} />
                    ))}
                >
                    Add game
                </Button>
            </div>
            {groups.map(group => (
                <ExpandableSection
                    key={group.key}
                    className="vc-better-keybinds-group"
                    expanded={expandedGroups[group.key] ?? true}
                    onExpandedChange={expanded => setExpandedGroups(current => ({ ...current, [group.key]: expanded }))}
                    headerActions={(
                        <Button
                            size="small"
                            variant="secondary"
                            aria-label={`Add keybind to ${group.game?.name ?? "Global"}`}
                            onClick={() => addToGroup(group.game)}
                        >
                            Add keybind
                        </Button>
                    )}
                    renderContent={() => group.keybinds.map(keybind => (
                        <div key={keybind.id} data-keybind-id={keybind.id} tabIndex={-1} className="vc-better-keybinds-row">
                            {renderKeybind(keybind)}
                            <div className="vc-better-keybinds-row-actions">
                                <TextButton
                                    variant="secondary"
                                    aria-haspopup="menu"
                                    onClick={event => ContextMenuApi.openContextMenu(event, () => (
                                        <GameMenu
                                            selectedKey={group.key}
                                            onSelect={game => {
                                                assignKeybind(keybind.id, game);
                                                setPendingFocus(keybind.id);
                                            }}
                                        />
                                    ))}
                                >
                                    Move to…
                                </TextButton>
                            </div>
                        </div>
                    ))}
                >
                    <div className="vc-better-keybinds-group-heading">
                        <span className="vc-better-keybinds-group-name">{group.game?.name ?? "Global"}</span>
                        <span className="vc-better-keybinds-group-count">
                            {group.keybinds.length} {group.keybinds.length === 1 ? "keybind" : "keybinds"}
                        </span>
                        <span className="vc-better-keybinds-group-status">
                            {!group.game ? "Always available" : isRunning(group.game, runningGames) ? "Running" : "Not running"}
                        </span>
                    </div>
                </ExpandableSection>
            ))}
        </div>
    );
}, { message: "Could not render the BetterKeybinds groups." });

