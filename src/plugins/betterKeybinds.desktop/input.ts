/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type InputKey = [device: number, code: number];
export type InputEvent = [device: number, code: number, down: boolean];
export type Shortcut = [device: number, code: number, platformOrDevice?: number | string][];
export interface KeyOptions {
    keydown?: boolean;
    keyup?: boolean;
    focused?: boolean;
    blurred?: boolean;
}

interface Binding {
    keys: number[];
    callback: (down: boolean) => void;
    options: KeyOptions;
    enabled: boolean;
    matched: boolean;
    active: boolean;
}

function keyId(device: number, code: number) {
    if (device === 2) device = 0;
    if ((device !== 0 && device !== 1) || !Number.isInteger(code) || code < 0 || code > 0xffff)
        throw new Error("BetterKeybinds supports keyboard and mouse shortcuts only");
    return device * 0x10000 + code;
}

/** Matches Discord's registered shortcuts; Discord still owns every action callback. */
export class Keybinds {
    private bindings = new Map<number, Binding>();
    private pressed = new Set<number>();
    private focused = true;
    private capturing = false;

    register(id: number, shortcut: Shortcut, callback: (down: boolean) => void, options: KeyOptions, enabled = true) {
        this.unregister(id);
        const keys = shortcut.map(([device, code]) => keyId(device, code));
        if (!keys.length) return;
        this.bindings.set(id, {
            keys, callback, options, enabled,
            matched: keys.every(key => this.pressed.has(key)),
            active: false
        });
    }

    unregister(id: number) {
        const binding = this.bindings.get(id);
        this.bindings.delete(id);
        if (binding) this.cancel(binding);
    }

    private cancel(binding: Binding) {
        const release = binding.active && binding.options.keydown && binding.options.keyup;
        binding.active = false;
        // Unregistering/cancelling a held action must not activate a release-only toggle.
        if (release) binding.callback(false);
    }

    private allowed(binding: Binding) {
        return binding.enabled && !this.capturing && (this.focused ? binding.options.focused !== false : binding.options.blurred !== false);
    }

    refreshEnabled(isEnabled: (id: number) => boolean) {
        // Releasing a hold can synchronously change Discord's registrations.
        for (const [id, binding] of [...this.bindings]) {
            if (this.bindings.get(id) !== binding) continue;
            binding.enabled = isEnabled(id);
            if (!binding.enabled) this.cancel(binding);
        }
    }

    setFocused(focused: boolean) {
        this.focused = focused;
        for (const binding of this.bindings.values())
            if (!this.allowed(binding)) this.cancel(binding);
    }

    setCapturing(capturing: boolean) {
        this.capturing = capturing;
        for (const binding of this.bindings.values())
            if (!this.allowed(binding)) this.cancel(binding);
    }

    input([device, code, down]: InputEvent) {
        const id = keyId(device, code);
        if (down === this.pressed.has(id)) return;
        if (down) this.pressed.add(id);
        else this.pressed.delete(id);

        // Callbacks can synchronously register/unregister bindings through Flux.
        for (const [bindingId, binding] of [...this.bindings]) {
            if (this.bindings.get(bindingId) !== binding) continue;
            const matched = binding.keys.every(key => this.pressed.has(key));
            if (matched === binding.matched) continue;
            binding.matched = matched;
            if (matched) {
                binding.active = this.allowed(binding);
                if (binding.active && binding.options.keydown) binding.callback(true);
            } else {
                const release = binding.active && this.allowed(binding) && binding.options.keyup;
                binding.active = false;
                if (release) binding.callback(false);
            }
        }
    }

    get hasActiveHold() {
        for (const binding of this.bindings.values())
            if (binding.active && binding.options.keydown && binding.options.keyup) return true;
        return false;
    }

    reset() {
        this.pressed.clear();
        for (const binding of [...this.bindings.values()]) {
            binding.matched = false;
            this.cancel(binding);
        }
    }

    watch(): InputKey[] {
        // Track disabled shortcuts too: launching a game with a key held must not
        // synthesize a fresh press or lose the release that clears that held key.
        const keys = new Set<number>();
        for (const binding of this.bindings.values())
            for (const key of binding.keys) keys.add(key);
        // Releases of unwatched keys are intentionally not sent by the helper.
        // Forget them now so re-adding a shortcut cannot inherit stale key-downs.
        for (const key of this.pressed)
            if (!keys.has(key)) this.pressed.delete(key);
        return [...keys].map(key => [key >>> 16, key & 0xffff]);
    }
}

/** Mirrors Discord's native recorder: at most four inputs, finishing on release. */
export class Recorder {
    private keys = new Map<number, Shortcut[number]>();
    private pressed = new Set<number>();

    input([device, code, down]: InputEvent): boolean {
        // The left click that starts/stops recording is not part of the shortcut.
        if (device === 1 && code === 1) return false;
        const id = keyId(device, code);
        if (down) {
            this.keys.set(id, [device === 2 ? 0 : device, code, 3]);
            this.pressed.add(id);
        } else {
            this.pressed.delete(id);
        }
        return this.keys.size >= 4 || (this.keys.size !== 0 && this.pressed.size === 0);
    }

    result(): Shortcut {
        return [...this.keys.values()];
    }
}
