package dev.lykhoyda.rndevagent.androidrunner

import android.content.Intent
import android.graphics.Rect
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.ByteArrayOutputStream

// The device-tool snapshot reads the windows itself instead of through
// UiDevice.dumpWindowHierarchy. These cases pin its output to what the XML
// dump produced for the same screen: node order, indices, rects, labels,
// identifiers, flags and the dropped-node count. The fixtures hold no
// private text, so the dump's own logging here is harmless.
@LargeTest
@RunWith(AndroidJUnit4::class)
class DeviceSnapshotParityInstrumentedTest {
    @Test
    fun snapshotMatchesTheWindowHierarchyDump() {
        launchFixture(ExactFillPrivacyFixtureActivity.FIELD_IDENTIFIER, null)
        assertParity()
    }

    @Test
    fun snapshotMatchesTheWindowHierarchyDumpWithAnOffScreenField() {
        launchFixture(
            ExactFillPrivacyFixtureActivity.OFFSCREEN_IDENTIFIER,
            ExactFillPrivacyFixtureActivity.LAYOUT_SCROLL,
        )
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        device.findObject(By.desc(ExactFillPrivacyFixtureActivity.SCROLL_IDENTIFIER))
            .scroll(Direction.DOWN, 1.0f)
        assertParity()
    }

    private fun assertParity() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val dispatcher = CommandDispatcher(InstrumentationRegistry.getInstrumentation())
        val appPackage = InstrumentationRegistry.getInstrumentation().context.packageName
        var expected = ""
        var actual = ""
        // A frame can change between the two reads; agreement on any of a few
        // back-to-back attempts proves the shapes match.
        repeat(3) {
            device.waitForIdle()
            expected = dumpSnapshot(device).toString()
            val response = dispatcher.dispatch(
                JSONObject().put("command", "snapshot").put("appBundleId", appPackage),
            )
            assertTrue(response.toString(), response.optBoolean("ok"))
            actual = response.getJSONObject("data").toString()
            if (expected == actual) return
        }
        assertEquals(expected, actual)
    }

    private fun launchFixture(identifier: String, layout: String?) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val intent = Intent()
            .setClassName(
                instrumentation.context.packageName,
                ExactFillPrivacyFixtureActivity::class.java.name,
            )
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        layout?.let { intent.putExtra(ExactFillPrivacyFixtureActivity.EXTRA_LAYOUT, it) }
        instrumentation.context.startActivity(intent)
        assertTrue(
            UiDevice.getInstance(instrumentation).wait(Until.hasObject(By.desc(identifier)), 10_000),
        )
    }

    // The snapshot as the runner built it from the XML dump before it read the
    // windows itself.
    private fun dumpSnapshot(device: UiDevice): JSONObject {
        val bytes = ByteArrayOutputStream()
        device.dumpWindowHierarchy(bytes)
        val parser = XmlPullParserFactory.newInstance().newPullParser()
        parser.setInput(bytes.toString("UTF-8").reader())
        val nodes = JSONArray()
        var dropped = 0
        var index = 0
        while (parser.eventType != XmlPullParser.END_DOCUMENT) {
            if (parser.eventType == XmlPullParser.START_TAG && parser.name == "node") {
                val bounds = parseBounds(parser.getAttributeValue(null, "bounds"))
                if (bounds != null) {
                    val resourceId = parser.getAttributeValue(null, "resource-id").orEmpty()
                    val text = parser.getAttributeValue(null, "text").orEmpty()
                    val desc = parser.getAttributeValue(null, "content-desc").orEmpty()
                    val visible = parser.getAttributeValue(null, "visible-to-user") != "false"
                    val enabled = parser.getAttributeValue(null, "enabled") != "false"
                    val identifier = resourceId.substringAfter(":id/", resourceId)
                        .substringAfterLast("/")
                        .ifBlank { desc }
                    val node = JSONObject()
                        .put("index", index)
                        .put("type", parser.getAttributeValue(null, "class").orEmpty())
                        .put("label", text.ifBlank { desc })
                        .put("identifier", identifier)
                        .put("packageName", parser.getAttributeValue(null, "package").orEmpty())
                        .put("checked", parser.getAttributeValue(null, "checked") == "true")
                        .put(
                            "rect",
                            JSONObject()
                                .put("x", bounds.left)
                                .put("y", bounds.top)
                                .put("width", bounds.width())
                                .put("height", bounds.height()),
                        )
                        .put("hittable", HittableSemantics.fromSnapshotNode(enabled, visible))
                        .put("enabled", enabled)
                    if (parser.getAttributeValue(null, "password") == "true") node.put("secure", true)
                    nodes.put(node)
                    index += 1
                } else {
                    dropped += 1
                }
            }
            parser.next()
        }
        return JSONObject()
            .put("nodes", nodes)
            .put("truncated", false)
            .put("normalizationDroppedNodes", dropped)
    }

    private fun parseBounds(raw: String?): Rect? {
        if (raw.isNullOrBlank()) return null
        val match = Regex("""\[(\d+),(\d+)]\[(\d+),(\d+)]""").find(raw) ?: return null
        val (l, t, r, b) = match.destructured
        return Rect(l.toInt(), t.toInt(), r.toInt(), b.toInt())
    }
}
