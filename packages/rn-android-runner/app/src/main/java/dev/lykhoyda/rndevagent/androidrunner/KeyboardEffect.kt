/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

/**
 * The soft keyboard a tap on an editable field opens is that tap's visible
 * effect, but its window arrives after the tap returns, and the settle probe
 * watches only the app's own windows. The tap waits, within a bound, until the
 * keyboard is listed, so the read after it sees the effect. A field that opens
 * no keyboard (a hardware keyboard, or soft input off) costs the bound.
 */
object KeyboardEffect {
    const val WAIT_MS = 2_000L
    const val POLL_MS = 50L

    /** Whether the keyboard was listed before the bound ran out; a failed read counts as not yet. */
    fun await(keyboardListed: () -> Boolean, now: () -> Long, sleep: (Long) -> Unit): Boolean {
        val deadline = now() + WAIT_MS
        while (true) {
            if (runCatching(keyboardListed).getOrDefault(false)) return true
            val left = deadline - now()
            if (left <= 0) return false
            sleep(minOf(POLL_MS, left))
        }
    }
}
