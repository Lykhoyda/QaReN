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

    // The bound the core passes: its post-act settle budget for the tap.
    private val budget = 6_000L

    @Test fun aKeyboardAlreadyShownReturnsWithoutSleeping() {
        val clock = Clock()
        assertTrue(KeyboardEffect.await({ true }, budget, { clock.now }, clock::sleep))
        assertEquals(emptyList<Long>(), clock.sleeps)
    }

    @Test fun aKeyboardThatOpensLaterEndsTheWaitAtItsFirstSighting() {
        val clock = Clock()
        val opensAt = clock.now + 420
        assertTrue(KeyboardEffect.await({ clock.now >= opensAt }, budget, { clock.now }, clock::sleep))
        assertTrue(clock.now - 1_000L in 420L until 420L + KeyboardEffect.POLL_MS)
    }

    @Test fun aKeyboardThatNeverOpensEndsTheWaitAtTheGivenBound() {
        for (bound in listOf(budget, 1_234L)) {
            val clock = Clock()
            assertFalse(KeyboardEffect.await({ false }, bound, { clock.now }, clock::sleep))
            assertEquals(bound, clock.now - 1_000L)
            assertTrue(clock.sleeps.all { it in 1..KeyboardEffect.POLL_MS })
        }
    }

    // No bound from the caller (settle off, or a caller that passes none) means no wait at all.
    @Test fun aZeroBoundReadsOnceAndNeverSleeps() {
        val clock = Clock()
        var reads = 0
        assertFalse(KeyboardEffect.await({ reads++; false }, 0L, { clock.now }, clock::sleep))
        assertEquals(1, reads)
        assertEquals(emptyList<Long>(), clock.sleeps)
    }

    @Test fun aFailedReadCountsAsNotYetShown() {
        val clock = Clock()
        var reads = 0
        val opened = KeyboardEffect.await(
            { if (reads++ == 0) throw IllegalStateException("window list unavailable") else true },
            budget,
            { clock.now },
            clock::sleep,
        )
        assertTrue(opened)
        assertEquals(2, reads)
    }
}
