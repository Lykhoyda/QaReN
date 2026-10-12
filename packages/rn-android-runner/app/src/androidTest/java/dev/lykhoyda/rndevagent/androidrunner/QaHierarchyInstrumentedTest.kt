/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import android.content.Intent
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.Button
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
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@LargeTest
@RunWith(AndroidJUnit4::class)
class QaHierarchyInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val testPackage: String = instrumentation.context.packageName
    private val dispatcher get() = sharedDispatcher

    @Before
    fun launchFixture() {
        checkNotNull(dispatcher) // before the fixture launches, so the window list is enabled
        val intent = Intent()
            .setClassName(testPackage, QaHierarchyFixtureActivity::class.java.name)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        instrumentation.context.startActivity(intent)
        assertTrue(
            UiDevice.getInstance(instrumentation).wait(
                Until.hasObject(By.desc(QaHierarchyFixtureActivity.COVER_IDENTIFIER)),
                10_000,
            ),
        )
        // QA reads gate on the accessibility window list, which can trail the view found above.
        val deadline = System.currentTimeMillis() + 10_000
        while (!fixtureWindowListed() && System.currentTimeMillis() < deadline) Thread.sleep(100)
        assertTrue(fixtureWindowListed())
    }

    // A fill leaves the keyboard up; relaunching over it can leave the window list without the fixture.
    @After
    fun leaveFixture() {
        UiDevice.getInstance(instrumentation).pressHome()
    }

    private fun fixtureWindowListed(): Boolean = ForegroundGate.hasForegroundWindow(
        instrumentation.uiAutomation.windows.map {
            ForegroundGate.WindowSignature(it.type, it.root?.packageName?.toString())
        },
        testPackage,
        AccessibilityWindowInfo.TYPE_APPLICATION,
    )

    @Test
    fun anOccludedExactPressRefusesWithTheOcclusionPrefixAndNoMutation() {
        val covered = node(qaSnapshot(), QaHierarchyFixtureActivity.COVERED_IDENTIFIER)
        try {
            dispatcher.dispatch(press(QaHierarchyFixtureActivity.COVERED_IDENTIFIER, covered))
            fail("a covered exact press must refuse")
        } catch (refusal: FocusTargetOccludedException) {
            assertTrue(refusal.message!!, refusal.message!!.startsWith("FOCUS_TARGET_OCCLUDED:"))
            assertEquals(MutationDisposition.NONE, refusal.mutation)
        }

        val clear = node(qaSnapshot(), QaHierarchyFixtureActivity.CLEAR_IDENTIFIER)
        val tapped = dispatcher.dispatch(press(QaHierarchyFixtureActivity.CLEAR_IDENTIFIER, clear))
        assertTrue(tapped.toString(), tapped.getJSONObject("data").getBoolean("tapped"))
    }

    @Test
    fun aCoveredFillRefusesBeforeItsFocusTapAndLeavesTheInputUnchanged() {
        val covered = node(qaSnapshot(), QaHierarchyFixtureActivity.COVERED_INPUT_IDENTIFIER)
        try {
            dispatcher.dispatch(
                fill(QaHierarchyFixtureActivity.COVERED_INPUT_IDENTIFIER, covered, "after", "op-covered-fill"),
            )
            fail("a fill whose focus tap point is covered must refuse")
        } catch (refusal: FocusTargetOccludedException) {
            assertTrue(refusal.message!!, refusal.message!!.startsWith("FOCUS_TARGET_OCCLUDED:"))
            assertEquals(MutationDisposition.NONE, refusal.mutation)
        }
        assertEquals(
            QaHierarchyFixtureActivity.COVERED_INPUT_TEXT,
            inputText(QaHierarchyFixtureActivity.COVERED_INPUT_IDENTIFIER),
        )
    }

    @Test
    fun anUncoveredFillTapsItsFocusPointAndTypes() {
        val open = node(qaSnapshot(), QaHierarchyFixtureActivity.OPEN_INPUT_IDENTIFIER)
        val typed = dispatcher.dispatch(
            fill(QaHierarchyFixtureActivity.OPEN_INPUT_IDENTIFIER, open, "after", "op-open-fill"),
        ).getJSONObject("data")
        assertEquals(typed.toString(), "performed", typed.getString("focusTap"))
        assertEquals("after", inputText(QaHierarchyFixtureActivity.OPEN_INPUT_IDENTIFIER))
    }

    @Test
    fun aQaSnapshotHasConsistentAncestryAndANewGeneration() {
        val first = qaSnapshot()
        val second = qaSnapshot()
        assertEquals(first.getInt("snapshotGeneration") + 1, second.getInt("snapshotGeneration"))
        assertFalse(first.getBoolean("truncated"))
        assertEquals(0, first.getInt("normalizationDroppedNodes"))
        assertFalse(first.getBoolean("keyboardVisible"))

        val nodes = first.getJSONArray("nodes")
        val root = nodes.getJSONObject(0)
        assertEquals("Application", root.getString("type"))
        assertEquals(0, root.getInt("depth"))
        assertFalse(root.has("parentIndex"))
        for (i in 1 until nodes.length()) {
            val n = nodes.getJSONObject(i)
            assertEquals(i, n.getInt("index"))
            val parent = n.getInt("parentIndex")
            assertTrue(n.toString(), parent < i)
            assertEquals(n.toString(), nodes.getJSONObject(parent).getInt("depth") + 1, n.getInt("depth"))
            assertTrue(n.has("visibleToUser") && n.has("selected"))
        }
        val covered = node(first, QaHierarchyFixtureActivity.COVERED_IDENTIFIER)
        val ancestors = generateSequence(covered.getInt("parentIndex")) { p ->
            nodes.getJSONObject(p).optInt("parentIndex", -1).takeIf { it >= 0 }
        }.map { nodes.getJSONObject(it).getString("type") }.toList()
        assertTrue(ancestors.toString(), "android.widget.LinearLayout" in ancestors)
        assertTrue(ancestors.toString(), "Window" in ancestors)
        assertEquals("Application", ancestors.last())
    }

    @Test
    fun aDeviceToolSnapshotKeepsTheWindowDumpShape() {
        val data = dispatcher.dispatch(
            JSONObject().put("command", "snapshot").put("appBundleId", testPackage),
        ).getJSONObject("data")
        assertFalse(data.has("snapshotGeneration"))
        assertFalse(data.has("keyboardVisible"))
        val nodes = data.getJSONArray("nodes")
        assertTrue(nodes.length() > 0)
        assertFalse(nodes.getJSONObject(0).getString("type") == "Application")
        for (i in 0 until nodes.length()) {
            val n = nodes.getJSONObject(i)
            assertFalse(n.toString(), n.has("depth") || n.has("parentIndex") || n.has("visibleToUser"))
        }
    }

    private fun qaSnapshot(): JSONObject = dispatcher.dispatch(
        JSONObject()
            .put("command", "snapshot")
            .put("appBundleId", testPackage)
            .put("qaReadOnly", true),
    ).getJSONObject("data")

    private fun node(snapshot: JSONObject, identifier: String): JSONObject {
        val nodes: JSONArray = snapshot.getJSONArray("nodes")
        return (0 until nodes.length()).map { nodes.getJSONObject(it) }
            .single { it.getString("identifier") == identifier }
    }

    private fun fill(identifier: String, node: JSONObject, text: String, operationToken: String): JSONObject =
        JSONObject()
            .put("command", "fill")
            .put("appBundleId", testPackage)
            .put("text", text)
            .put("snapshotIdentifier", identifier)
            .put("snapshotElementType", EditText::class.java.name)
            .put("targetBounds", node.getJSONObject("rect"))
            .put("operationToken", operationToken)

    private fun inputText(identifier: String): String? =
        UiDevice.getInstance(instrumentation).findObject(By.desc(identifier))?.text

    private fun press(identifier: String, node: JSONObject): JSONObject {
        val rect = node.getJSONObject("rect")
        return JSONObject()
            .put("command", "tap")
            .put("appBundleId", testPackage)
            .put("exactIdentifier", identifier)
            .put("exactType", Button::class.java.name)
            .put("x", rect.getInt("x") + rect.getInt("width") / 2)
            .put("y", rect.getInt("y") + rect.getInt("height") / 2)
    }

    companion object {
        // One dispatcher per run, as a runner session keeps one; its init enables the
        // interactive window list that QA reads gate on.
        private val sharedDispatcher by lazy { CommandDispatcher(InstrumentationRegistry.getInstrumentation()) }
    }
}
