package dev.lykhoyda.rndevagent.androidrunner

import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.SystemClock
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// Failure messages carry counts only, never logcat lines: a failing run must
// not copy the canary into the test report.
@LargeTest
@RunWith(AndroidJUnit4::class)
class ExactFillPrivacyInstrumentedTest {
    @Test
    fun exactAccessibilityFillKeepsCanaryOutOfLogcat() {
        launchFixture(ExactFillPrivacyFixtureActivity.FIELD_IDENTIFIER)

        shell("logcat -b all -c")
        val canary = "RN_FILL_LOGCAT_PRIVACY_CANARY_581"
        val token = "op-privacy-581"
        val fill = dispatchFill(ExactFillPrivacyFixtureActivity.FIELD_IDENTIFIER, canary, token)
        assertTrue(fill.toString(), fill.optBoolean("ok"))
        assertFalse(fill.toString().contains(canary))

        val verify = dispatchVerify(canary, token)
        assertEquals(verify.toString(), "exact", verifyVerdict(verify))
        assertFalse(verify.toString().contains(canary))

        assertLogcatFree(canary)
    }

    // GH #581: a plain empty clear proves exact; a placeholder-bearing field
    // reads back its hint after the clear, which the recipe deliberately
    // refuses as "ambiguous" so a hint can never false-succeed as field text.
    @Test
    fun exactAccessibilityFillArbitratesEmptyClearsTruthfully() {
        launchFixture(ExactFillPrivacyFixtureActivity.PLACEHOLDER_CLEAR_IDENTIFIER)

        val plainToken = "op-plain-clear-581"
        val plainFill = dispatchFill(
            ExactFillPrivacyFixtureActivity.PLAIN_CLEAR_IDENTIFIER,
            "",
            plainToken,
        )
        assertTrue(plainFill.toString(), plainFill.optBoolean("ok"))
        assertEquals("exact", verifyVerdict(dispatchVerify("", plainToken)))

        val placeholderToken = "op-placeholder-clear-581"
        val placeholderFill = dispatchFill(
            ExactFillPrivacyFixtureActivity.PLACEHOLDER_CLEAR_IDENTIFIER,
            "",
            placeholderToken,
        )
        assertTrue(placeholderFill.toString(), placeholderFill.optBoolean("ok"))
        assertEquals("ambiguous", verifyVerdict(dispatchVerify("", placeholderToken)))
    }

    // The field ignores ACTION_SET_TEXT, so the value is typed key by key over
    // its existing text. No keystroke of it may reach logcat.
    @Test
    fun keyEventFallbackKeepsKeystrokesOutOfLogcat() {
        launchFixture(ExactFillPrivacyFixtureActivity.KEY_EVENT_IDENTIFIER)

        shell("logcat -b all -c")
        val canary = "rnkeycanary581"
        val token = "op-key-event-581"
        val fill = dispatchFill(ExactFillPrivacyFixtureActivity.KEY_EVENT_IDENTIFIER, canary, token)
        assertTrue(fill.toString(), fill.optBoolean("ok"))
        assertEquals(fill.toString(), "keyevents", fill.optJSONObject("data")?.optString("method"))
        assertEquals("exact", verifyVerdict(dispatchVerify(canary, token)))

        SystemClock.sleep(250)
        val canaryLines = shell("logcat -b all -d -v raw").lines().count { it.contains(canary) }
        val keyLines = shell("logcat -b all -d -v raw --pid=${Process.myPid()}")
            .lines()
            .count { it.contains("keycode", ignoreCase = true) }
        assertEquals(
            "logcat lines carrying the canary: $canaryLines; runner lines naming a keycode: $keyLines",
            0,
            canaryLines + keyLines,
        )
    }

    // A snapshot taken while a filled field sits off screen must not log the
    // off-screen node's text.
    @Test
    fun snapshotWithFilledFieldOffScreenKeepsCanaryOutOfLogcat() {
        launchFixture(
            ExactFillPrivacyFixtureActivity.OFFSCREEN_IDENTIFIER,
            ExactFillPrivacyFixtureActivity.LAYOUT_SCROLL,
        )
        val canary = "RN_SNAPSHOT_LOGCAT_PRIVACY_CANARY_581"
        val token = "op-offscreen-581"
        val fill = dispatchFill(ExactFillPrivacyFixtureActivity.OFFSCREEN_IDENTIFIER, canary, token)
        assertTrue(fill.toString(), fill.optBoolean("ok"))
        assertEquals("exact", verifyVerdict(dispatchVerify(canary, token)))

        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val scroll = device.findObject(By.desc(ExactFillPrivacyFixtureActivity.SCROLL_IDENTIFIER))
        var attempts = 0
        while (device.hasObject(By.desc(ExactFillPrivacyFixtureActivity.OFFSCREEN_IDENTIFIER)) && attempts++ < 5) {
            scroll.scroll(Direction.DOWN, 1.0f)
        }
        assertFalse(
            "the filled field must be off screen before the snapshot",
            device.hasObject(By.desc(ExactFillPrivacyFixtureActivity.OFFSCREEN_IDENTIFIER)),
        )

        shell("logcat -b all -c")
        val snapshot = dispatcher.dispatch(
            JSONObject()
                .put("command", "snapshot")
                .put("appBundleId", InstrumentationRegistry.getInstrumentation().context.packageName),
        )
        assertTrue(snapshot.optBoolean("ok"))
        assertTrue(
            "the snapshot must still read the visible scroll content",
            snapshot.toString().contains(ExactFillPrivacyFixtureActivity.SCROLL_SPACER_IDENTIFIER),
        )
        assertFalse(snapshot.toString().contains(canary))
        assertLogcatFree(canary)

        // The QA read is its own live traversal and keeps off-screen nodes as
        // visibleToUser false; it must not log their text either.
        shell("logcat -b all -c")
        val qaSnapshot = dispatcher.dispatch(
            JSONObject()
                .put("command", "snapshot")
                .put("qaReadOnly", true)
                .put("appBundleId", InstrumentationRegistry.getInstrumentation().context.packageName),
        )
        assertTrue(qaSnapshot.optBoolean("ok"))
        assertLogcatFree(canary)
    }

    private fun assertLogcatFree(canary: String) {
        SystemClock.sleep(250)
        val hits = shell("logcat -b all -d -v raw").lines().count { it.contains(canary) }
        assertEquals("logcat lines carrying the canary: $hits", 0, hits)
    }

    private fun launchFixture(identifier: String, layout: String? = null) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val testPackage = instrumentation.context.packageName
        val intent = Intent()
            .setClassName(testPackage, ExactFillPrivacyFixtureActivity::class.java.name)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        layout?.let { intent.putExtra(ExactFillPrivacyFixtureActivity.EXTRA_LAYOUT, it) }
        instrumentation.context.startActivity(intent)
        assertTrue(
            UiDevice.getInstance(instrumentation).wait(
                Until.hasObject(By.desc(identifier)),
                10_000,
            ),
        )
    }

    private val dispatcher: CommandDispatcher by lazy {
        CommandDispatcher(InstrumentationRegistry.getInstrumentation())
    }

    private fun dispatchFill(identifier: String, text: String, operationToken: String): JSONObject {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(instrumentation)
        val field = device.findObject(By.desc(identifier))
        assertTrue("fixture field $identifier must be on screen", field != null)
        val bounds = field.visibleBounds
        return dispatcher.dispatch(
            JSONObject()
                .put("command", "fill")
                .put("appBundleId", instrumentation.context.packageName)
                .put("text", text)
                .put("snapshotIdentifier", identifier)
                .put("snapshotElementType", EditText::class.java.name)
                .put(
                    "targetBounds",
                    JSONObject()
                        .put("x", bounds.left)
                        .put("y", bounds.top)
                        .put("width", bounds.width())
                        .put("height", bounds.height()),
                )
                .put("operationToken", operationToken),
        )
    }

    private fun dispatchVerify(text: String, operationToken: String): JSONObject =
        dispatcher.dispatch(
            JSONObject()
                .put("command", "verifyInput")
                .put("text", text)
                .put("operationToken", operationToken),
        )

    private fun verifyVerdict(response: JSONObject): String? =
        response.optJSONObject("data")?.optString("verifyVerdict")

    private fun shell(command: String): String {
        val descriptor = InstrumentationRegistry.getInstrumentation()
            .uiAutomation
            .executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor)
            .bufferedReader()
            .use { it.readText() }
    }
}
