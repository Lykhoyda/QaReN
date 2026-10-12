/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout

// A nested layout whose second button sits under a clickable cover drawn above it.
class QaHierarchyFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val clear = Button(this).apply { contentDescription = CLEAR_IDENTIFIER }
        val covered = Button(this).apply { contentDescription = COVERED_IDENTIFIER }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(clear, LinearLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT))
            addView(covered, LinearLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT))
        }
        val cover = View(this).apply {
            contentDescription = COVER_IDENTIFIER
            isClickable = true
            setBackgroundColor(0xFF336699.toInt())
        }
        // The test APK's own process has no Kotlin stdlib, so no lambda returns Unit here.
        // Rows start below the status bar: an edge-to-edge window draws under it, and a
        // system window over the point is itself an occluder.
        val columnParams = FrameLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT * 2, Gravity.TOP)
        columnParams.topMargin = TOP_OFFSET
        val coverParams = FrameLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT, Gravity.TOP)
        coverParams.topMargin = TOP_OFFSET + ROW_HEIGHT
        val root = FrameLayout(this)
        root.addView(column, columnParams)
        root.addView(cover, coverParams)
        setContentView(root)
    }

    companion object {
        const val CLEAR_IDENTIFIER = "qa-clear"
        const val COVERED_IDENTIFIER = "qa-covered"
        const val COVER_IDENTIFIER = "qa-cover"
        const val ROW_WIDTH = 600
        const val ROW_HEIGHT = 240
        const val TOP_OFFSET = 480
    }
}
