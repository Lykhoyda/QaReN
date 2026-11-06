package dev.lykhoyda.rndevagent.androidrunner

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout

// AI-489: a one-time-code field keeps its real input at opacity 0, so Android
// reports it not visible to the user while it holds input focus.
class FocusedHiddenInputFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The test APK's own process has no Kotlin stdlib: nothing here may
        // call kotlin.jvm.internal (no `==` on strings, no non-null parameters).
        val mode = intent.getStringExtra(EXTRA_MODE)
        val visibleInput = EditText(this).apply {
            contentDescription = VISIBLE_IDENTIFIER
            showSoftInputOnFocus = false
        }
        val hiddenInput = if (MODE_REJECTING.equals(mode)) {
            ExactFillPrivacyFixtureActivity.SetTextRejectingEditText(this)
        } else {
            EditText(this)
        }
        hiddenInput.contentDescription = HIDDEN_IDENTIFIER
        hiddenInput.showSoftInputOnFocus = false
        hiddenInput.alpha = 0f
        val inputLayout = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, resources.displayMetrics.heightPixels / 4, 0, 0)
            addView(visibleInput, inputLayout)
            addView(hiddenInput, inputLayout)
        }
        if (MODE_DUPLICATE.equals(mode)) {
            val twin = EditText(this)
            twin.contentDescription = HIDDEN_IDENTIFIER
            twin.showSoftInputOnFocus = false
            twin.alpha = 0f
            container.addView(twin, inputLayout)
        }
        setContentView(container)
        if (MODE_UNFOCUSED.equals(mode)) visibleInput.requestFocus() else hiddenInput.requestFocus()
    }

    companion object {
        const val EXTRA_MODE = "mode"
        const val MODE_FOCUSED = "focused"
        const val MODE_UNFOCUSED = "unfocused"
        const val MODE_DUPLICATE = "duplicate"
        const val MODE_REJECTING = "rejecting"
        const val VISIBLE_IDENTIFIER = "rn-hidden-fixture-visible-field"
        const val HIDDEN_IDENTIFIER = "rn-hidden-fixture-code-field"
    }
}
