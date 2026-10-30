/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

/** Pure display-bounds decision for coordinate gestures. */
object CoordinateBounds {
    fun contains(displayWidth: Int, displayHeight: Int, x: Int, y: Int): Boolean =
        x >= 0 && y >= 0 && x < displayWidth && y < displayHeight
}
