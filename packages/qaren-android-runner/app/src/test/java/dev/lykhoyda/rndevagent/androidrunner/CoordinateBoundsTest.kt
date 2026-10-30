/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CoordinateBoundsTest {
    @Test fun pointInsideTheDisplayIsInjectable() =
        assertTrue(CoordinateBounds.contains(1080, 2400, 960, 430))

    @Test fun originIsInjectable() =
        assertTrue(CoordinateBounds.contains(1080, 2400, 0, 0))

    @Test fun theExclusiveRightEdgeIsRejected() =
        assertFalse(CoordinateBounds.contains(1080, 2400, 1080, 430))

    @Test fun theExclusiveBottomEdgeIsRejected() =
        assertFalse(CoordinateBounds.contains(1080, 2400, 960, 2400))

    @Test fun negativeCoordinatesAreRejected() {
        assertFalse(CoordinateBounds.contains(1080, 2400, -1, 430))
        assertFalse(CoordinateBounds.contains(1080, 2400, 960, -1))
    }
}
