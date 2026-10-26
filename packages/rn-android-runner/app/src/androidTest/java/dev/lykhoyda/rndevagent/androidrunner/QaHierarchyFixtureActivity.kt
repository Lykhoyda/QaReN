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
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView

// A nested layout whose second button and second input sit under clickable covers drawn above them,
// and a one-row scroll view whose second button is scrolled out of view.
class QaHierarchyFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val clear = Button(this).apply { contentDescription = CLEAR_IDENTIFIER }
        val covered = Button(this).apply { contentDescription = COVERED_IDENTIFIER }
        val openInput = EditText(this).apply {
            contentDescription = OPEN_INPUT_IDENTIFIER
            showSoftInputOnFocus = false
        }
        val coveredInput = EditText(this).apply {
            contentDescription = COVERED_INPUT_IDENTIFIER
            showSoftInputOnFocus = false
        }
        coveredInput.setText(COVERED_INPUT_TEXT)
        // The one input that opens the soft keyboard when it takes focus.
        val keyboardInput = EditText(this).apply { contentDescription = KEYBOARD_INPUT_IDENTIFIER }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(clear, LinearLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT))
            addView(covered, LinearLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT))
            addView(openInput, LinearLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT))
            addView(coveredInput, LinearLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT))
            addView(keyboardInput, LinearLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT))
        }
        val cover = clickableCover(COVER_IDENTIFIER)
        val inputCover = clickableCover(INPUT_COVER_IDENTIFIER)
        // The test APK's own process has no Kotlin stdlib, so no lambda returns Unit here.
        // Rows start below the status bar: an edge-to-edge window draws under it, and a
        // system window over the point is itself an occluder.
        val columnParams = FrameLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT * 5, Gravity.TOP)
        columnParams.topMargin = TOP_OFFSET
        val coverParams = FrameLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT, Gravity.TOP)
        coverParams.topMargin = TOP_OFFSET + ROW_HEIGHT
        val inputCoverParams = FrameLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT, Gravity.TOP)
        inputCoverParams.topMargin = TOP_OFFSET + ROW_HEIGHT * 3
        val scroll = ScrollView(this)
        scroll.addView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                addView(Button(this@QaHierarchyFixtureActivity), LinearLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT))
                addView(
                    Button(this@QaHierarchyFixtureActivity).apply { contentDescription = SCROLLED_OUT_IDENTIFIER },
                    LinearLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT),
                )
            },
        )
        val scrollParams = FrameLayout.LayoutParams(ROW_WIDTH, ROW_HEIGHT, Gravity.TOP)
        scrollParams.topMargin = TOP_OFFSET + ROW_HEIGHT * 5 + ROW_HEIGHT / 4
        val root = FrameLayout(this)
        root.addView(column, columnParams)
        root.addView(scroll, scrollParams)
        root.addView(cover, coverParams)
        root.addView(inputCover, inputCoverParams)
        // Neither input starts focused, so every fill needs its focus tap.
        root.isFocusableInTouchMode = true
        setContentView(root)
        root.requestFocus()
    }

    private fun clickableCover(identifier: String): View {
        val cover = View(this)
        cover.contentDescription = identifier
        cover.isClickable = true
        cover.setBackgroundColor(0xFF336699.toInt())
        return cover
    }

    companion object {
        const val CLEAR_IDENTIFIER = "qa-clear"
        const val COVERED_IDENTIFIER = "qa-covered"
        const val COVER_IDENTIFIER = "qa-cover"
        const val OPEN_INPUT_IDENTIFIER = "qa-open-input"
        const val COVERED_INPUT_IDENTIFIER = "qa-covered-input"
        const val INPUT_COVER_IDENTIFIER = "qa-input-cover"
        const val KEYBOARD_INPUT_IDENTIFIER = "qa-keyboard-input"
        const val SCROLLED_OUT_IDENTIFIER = "qa-scrolled-out"
        const val COVERED_INPUT_TEXT = "before"
        const val ROW_WIDTH = 600
        const val ROW_HEIGHT = 240
        const val TOP_OFFSET = 480
    }
}
