/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyboardEffectTest {
    private class Clock {
        var now = 1_000L
        val sleeps = mutableListOf<Long>()
        fun sleep(ms: Long) {
            sleeps.add(ms)
            now += ms
        }
    }

    @Test fun aKeyboardAlreadyShownReturnsWithoutSleeping() {
        val clock = Clock()
        assertTrue(KeyboardEffect.await({ true }, { clock.now }, clock::sleep))
        assertEquals(emptyList<Long>(), clock.sleeps)
    }

    @Test fun aKeyboardThatOpensLaterEndsTheWaitAtItsFirstSighting() {
        val clock = Clock()
        val opensAt = clock.now + 420
        assertTrue(KeyboardEffect.await({ clock.now >= opensAt }, { clock.now }, clock::sleep))
        assertTrue(clock.now - 1_000L in 420L until 420L + KeyboardEffect.POLL_MS)
    }

    @Test fun aKeyboardThatNeverOpensEndsTheWaitAtTheBound() {
        val clock = Clock()
        assertFalse(KeyboardEffect.await({ false }, { clock.now }, clock::sleep))
        assertEquals(KeyboardEffect.WAIT_MS, clock.now - 1_000L)
        assertTrue(clock.sleeps.all { it in 1..KeyboardEffect.POLL_MS })
    }

    @Test fun aFailedReadCountsAsNotYetShown() {
        val clock = Clock()
        var reads = 0
        val opened = KeyboardEffect.await(
            { if (reads++ == 0) throw IllegalStateException("window list unavailable") else true },
            { clock.now },
            clock::sleep,
        )
        assertTrue(opened)
        assertEquals(2, reads)
    }
}
