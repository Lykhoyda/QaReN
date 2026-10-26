/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

/**
 * The soft keyboard a tap on an editable field opens is that tap's visible
 * effect, but its window arrives after the tap returns, and the settle probe
 * watches only the app's own windows. The tap waits until the keyboard is
 * listed, so the read after it sees the effect. The runner owns no bound of its
 * own: the caller passes the post-act settle budget it applies to this tap, and
 * no bound means no wait. A field that opens no keyboard (a hardware keyboard,
 * or soft input off) costs that budget and reports the keyboard as not shown.
 */
object KeyboardEffect {
    // Poll cadence only; the bound is the caller's.
    const val POLL_MS = 50L

    /** Whether the keyboard was listed before [boundMs] ran out; a failed read counts as not yet. */
    fun await(keyboardListed: () -> Boolean, boundMs: Long, now: () -> Long, sleep: (Long) -> Unit): Boolean {
        val deadline = now() + boundMs
        while (true) {
            if (runCatching(keyboardListed).getOrDefault(false)) return true
            val left = deadline - now()
            if (left <= 0) return false
            sleep(minOf(POLL_MS, left))
        }
    }
}
