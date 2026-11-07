package dev.lykhoyda.rndevagent.androidrunner

import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

// AI-489: Fill reaches an input the app keeps at opacity 0 only while that exact
// input holds focus. Failure messages carry counts only, never logcat lines.
@LargeTest
@RunWith(AndroidJUnit4::class)
class FocusedHiddenInputInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val testPackage: String = instrumentation.context.packageName
    private val dispatcher get() = sharedDispatcher
    private val hidden = FocusedHiddenInputFixtureActivity.HIDDEN_IDENTIFIER

    @After
    fun leaveFixture() {
        UiDevice.getInstance(instrumentation).pressHome()
    }

    // Also the device check of what the fix rests on: the alpha-0 input reports
    // isFocused (else the unfocused refusal) and takes ACTION_SET_TEXT (else SET_TEXT_REJECTED).
    @Test
    fun aFocusedTransparentInputIsTypedByIdentifierAndVerifiedByItsToken() {
        launch(FocusedHiddenInputFixtureActivity.MODE_FOCUSED)
        val target = nodes(qaSnapshot(), hidden).single()
        assertFalse(target.toString(), target.getBoolean("visibleToUser"))
        assertTrue(target.toString(), target.optBoolean("focused"))

        shell("logcat -b all -c")
        val canary = "rnhiddencanary489"
        val token = "op-hidden-489"
        val fill = dispatcher.dispatch(fill(target, canary, token))
        assertTrue("the fill succeeds", fill.optBoolean("ok"))
        assertFalse("the fill response echoes no typed value", fill.toString().contains(canary))
        val data = fill.getJSONObject("data")
        assertEquals("identifier-focused-hidden", data.getString("inputResolution"))
        assertEquals("setText", data.getString("method"))
        assertTrue("the hidden input holds the typed value", inputTexts(hidden) == listOf(canary))

        val verify = dispatcher.dispatch(verify(canary, token))
        assertEquals("exact", verify.getJSONObject("data").getString("verifyVerdict"))
        assertFalse("the verify response echoes no typed value", verify.toString().contains(canary))
        val foreign = dispatcher.dispatch(verify(canary, "op-other-489"))
        assertEquals("target-lost", foreign.getJSONObject("data").getString("verifyVerdict"))

        SystemClock.sleep(250)
        val hits = shell("logcat -b all -d -v raw").lines().count { it.contains(canary) }
        assertEquals("logcat lines carrying the canary: $hits", 0, hits)
    }

    @Test
    fun anUnfocusedTransparentInputIsRefusedAndLeftEmpty() {
        launch(FocusedHiddenInputFixtureActivity.MODE_UNFOCUSED)
        val target = nodes(qaSnapshot(), hidden).single()
        assertFalse(target.toString(), target.has("focused"))
        try {
            dispatcher.dispatch(fill(target, "1234", "op-unfocused-489"))
            fail("an unfocused transparent input must refuse")
        } catch (refusal: NoTextInputTargetException) {
            assertTrue(refusal.message!!, refusal.message!!.contains("is not visible to the user and is not focused"))
            assertEquals(MutationDisposition.NONE, refusal.mutation)
        }
        assertEquals(listOf(""), inputTexts(hidden))
        // GH #581: the input that does hold focus is not typed into either.
        assertEquals(listOf(""), inputTexts(FocusedHiddenInputFixtureActivity.VISIBLE_IDENTIFIER))
    }

    @Test
    fun twoTransparentInputsWithOneIdentifierAreRefused() {
        launch(FocusedHiddenInputFixtureActivity.MODE_DUPLICATE)
        val twins = nodes(qaSnapshot(), hidden)
        assertEquals(2, twins.size)
        try {
            dispatcher.dispatch(fill(twins.first(), "1234", "op-duplicate-489"))
            fail("two inputs carrying one identifier must refuse")
        } catch (refusal: NoTextInputTargetException) {
            assertEquals(MutationDisposition.NONE, refusal.mutation)
        }
        assertEquals(listOf("", ""), inputTexts(hidden))
    }

    @Test
    fun aTransparentInputThatIgnoresSetTextIsRefusedWithoutKeyEvents() {
        launch(FocusedHiddenInputFixtureActivity.MODE_REJECTING)
        val target = nodes(qaSnapshot(), hidden).single()
        try {
            dispatcher.dispatch(fill(target, "1234", "op-rejecting-489"))
            fail("a transparent input that ignores ACTION_SET_TEXT must refuse")
        } catch (refusal: SetTextRejectedException) {
            assertEquals(MutationDisposition.NONE, refusal.mutation)
        }
        // No keyevent pass ran: the input is still empty.
        assertEquals(listOf(""), inputTexts(hidden))
    }

    private fun launch(mode: String) {
        checkNotNull(dispatcher) // before the fixture launches, so the window list is enabled
        val intent = Intent()
            .setClassName(testPackage, FocusedHiddenInputFixtureActivity::class.java.name)
            .putExtra(FocusedHiddenInputFixtureActivity.EXTRA_MODE, mode)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        instrumentation.context.startActivity(intent)
        assertTrue(
            UiDevice.getInstance(instrumentation).wait(
                Until.hasObject(By.desc(FocusedHiddenInputFixtureActivity.VISIBLE_IDENTIFIER)),
                10_000,
            ),
        )
        val deadline = System.currentTimeMillis() + 10_000
        while (!fixtureWindowListed() && System.currentTimeMillis() < deadline) Thread.sleep(100)
        assertTrue(fixtureWindowListed())
    }

    private fun fixtureWindowListed(): Boolean = ForegroundGate.hasForegroundWindow(
        instrumentation.uiAutomation.windows.map {
            ForegroundGate.WindowSignature(it.type, it.root?.packageName?.toString())
        },
        testPackage,
        AccessibilityWindowInfo.TYPE_APPLICATION,
    )

    private fun qaSnapshot(): JSONObject = dispatcher.dispatch(
        JSONObject()
            .put("command", "snapshot")
            .put("appBundleId", testPackage)
            .put("qaReadOnly", true),
    ).getJSONObject("data")

    private fun nodes(snapshot: JSONObject, identifier: String): List<JSONObject> {
        val nodes: JSONArray = snapshot.getJSONArray("nodes")
        return (0 until nodes.length()).map { nodes.getJSONObject(it) }
            .filter { it.getString("identifier") == identifier }
    }

    private fun fill(node: JSONObject, text: String, operationToken: String): JSONObject =
        JSONObject()
            .put("command", "fill")
            .put("appBundleId", testPackage)
            .put("text", text)
            .put("snapshotIdentifier", hidden)
            .put("snapshotElementType", EditText::class.java.name)
            .put("targetBounds", node.getJSONObject("rect"))
            .put("operationToken", operationToken)

    private fun verify(text: String, operationToken: String): JSONObject =
        JSONObject()
            .put("command", "verifyInput")
            .put("text", text)
            .put("operationToken", operationToken)

    // UiAutomator never returns a not-visible node, so read every node carrying the identifier directly.
    private fun inputTexts(identifier: String): List<String> {
        val texts = mutableListOf<String>()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        instrumentation.uiAutomation.rootInActiveWindow?.let { stack.addLast(it) }
        while (stack.isNotEmpty()) {
            val node = stack.removeLast()
            if (node.contentDescription?.toString() == identifier) texts.add(node.text?.toString().orEmpty())
            for (index in 0 until node.childCount) node.getChild(index)?.let { stack.addLast(it) }
            node.recycle()
        }
        return texts
    }

    private fun shell(command: String): String {
        val descriptor = instrumentation.uiAutomation.executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor)
            .bufferedReader()
            .use { it.readText() }
    }

    companion object {
        // One dispatcher per run, as a runner session keeps one; its init enables the
        // interactive window list that QA reads gate on.
        private val sharedDispatcher by lazy { CommandDispatcher(InstrumentationRegistry.getInstrumentation()) }
    }
}
