/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import android.Manifest
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.widget.TextView

// Raises the notification permission prompt over itself on API 33 and later.
class SystemDialogFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val title = TextView(this)
        title.text = TITLE
        setContentView(title)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
        }
    }

    companion object {
        const val TITLE = "qa-system-dialog"
    }
}
