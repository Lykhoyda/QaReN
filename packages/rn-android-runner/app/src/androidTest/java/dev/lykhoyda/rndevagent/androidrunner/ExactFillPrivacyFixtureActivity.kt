package dev.lykhoyda.rndevagent.androidrunner

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView

class ExactFillPrivacyFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The test APK's own process has no Kotlin stdlib: nothing here may
        // call kotlin.jvm.internal (no `==` on strings, no non-null parameters).
        if (LAYOUT_SCROLL.equals(intent.getStringExtra(EXTRA_LAYOUT))) {
            setContentView(scrollLayout())
            return
        }
        val privacyInput = EditText(this).apply {
            contentDescription = FIELD_IDENTIFIER
            hint = "Placeholder"
            showSoftInputOnFocus = false
        }
        val placeholderClearInput = EditText(this).apply {
            contentDescription = PLACEHOLDER_CLEAR_IDENTIFIER
            hint = "Placeholder"
            setText("existing")
            showSoftInputOnFocus = false
        }
        val plainClearInput = EditText(this).apply {
            contentDescription = PLAIN_CLEAR_IDENTIFIER
            setText("existing")
            showSoftInputOnFocus = false
        }
        val keyEventInput = SetTextRejectingEditText(this).apply {
            contentDescription = KEY_EVENT_IDENTIFIER
            setText("existing")
            showSoftInputOnFocus = false
        }
        val inputLayout = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(privacyInput, inputLayout)
            addView(placeholderClearInput, inputLayout)
            addView(plainClearInput, inputLayout)
            addView(keyEventInput, inputLayout)
        }
        setContentView(container)
        privacyInput.requestFocus()
    }

    // A field at the top of a tall scroll view, so a test can fill it and then
    // scroll it out of view before a snapshot.
    private fun scrollLayout(): View {
        val offscreenInput = EditText(this).apply {
            contentDescription = OFFSCREEN_IDENTIFIER
            showSoftInputOnFocus = false
        }
        val spacer = View(this).apply { contentDescription = SCROLL_SPACER_IDENTIFIER }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            // Below the status bar the window draws under, so the field starts on screen.
            setPadding(0, resources.displayMetrics.heightPixels / 4, 0, 0)
            addView(
                offscreenInput,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
            addView(
                spacer,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    resources.displayMetrics.heightPixels * 3,
                ),
            )
        }
        return ScrollView(this).apply {
            contentDescription = SCROLL_IDENTIFIER
            addView(content)
        }
    }

    // Ignores ACTION_SET_TEXT so the runner descends to its key-event tier.
    class SetTextRejectingEditText(context: Context?) : EditText(context) {
        override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean =
            if (action == AccessibilityNodeInfo.ACTION_SET_TEXT) {
                false
            } else {
                super.performAccessibilityAction(action, arguments)
            }
    }

    companion object {
        const val EXTRA_LAYOUT = "layout"
        const val LAYOUT_SCROLL = "scroll"
        const val FIELD_IDENTIFIER = "rn-fill-privacy-field"
        const val PLACEHOLDER_CLEAR_IDENTIFIER = "rn-fill-placeholder-clear-field"
        const val PLAIN_CLEAR_IDENTIFIER = "rn-fill-plain-clear-field"
        const val KEY_EVENT_IDENTIFIER = "rn-fill-key-event-field"
        const val OFFSCREEN_IDENTIFIER = "rn-fill-offscreen-field"
        const val SCROLL_IDENTIFIER = "rn-fill-scroll"
        const val SCROLL_SPACER_IDENTIFIER = "rn-fill-scroll-spacer"
    }
}
