package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class KeyboardGuardTest {
    private class DismissDevice(vararg visibility: Boolean?) {
        val reads = ArrayDeque(visibility.toList())
        val events = mutableListOf<String>()
        var clock = 0L
        var unchanged = true
        var accepted = true

        fun dismiss() = KeyboardGuard.dismiss(
            shown = { events.add("read"); if (reads.size > 1) reads.removeFirst() else reads.first() },
            sameScreen = { events.add("screen"); unchanged },
            pressBack = { events.add("back"); accepted },
            now = { clock },
            sleep = { clock += it },
        )
    }

    @Test fun hiddenKeyboardNeverPressesBack() {
        val device = DismissDevice(false)
        assertEquals(KeyboardGuard.DismissResult(false, false), device.dismiss())
        assertEquals(listOf("read"), device.events)
    }

    @Test fun shownKeyboardRequiresHiddenReadback() {
        val device = DismissDevice(true, true, true, false)
        assertEquals(KeyboardGuard.DismissResult(true, true), device.dismiss())
        assertEquals(listOf("read", "screen", "read", "back", "read", "screen", "read", "screen"), device.events)
        assertEquals(50L, device.clock)
    }

    @Test fun unknownVisibilityNeverPressesBack() {
        val device = DismissDevice(null)
        val error = assertThrows(KeyboardGuard.DismissRefused::class.java) { device.dismiss() }
        assertEquals("KEYBOARD_VISIBILITY_UNKNOWN", error.code)
        assertFalse(error.backAttempted)
        assertEquals(listOf("read"), device.events)
    }

    @Test fun keyboardClosingBeforeBackIsANoop() {
        val device = DismissDevice(true, false)
        assertEquals(KeyboardGuard.DismissResult(false, false), device.dismiss())
        assertFalse(device.events.contains("back"))
    }

    @Test fun unknownReadbackCannotReportDismissed() {
        val device = DismissDevice(true, true, null)
        val error = assertThrows(KeyboardGuard.DismissRefused::class.java) { device.dismiss() }
        assertEquals("KEYBOARD_VISIBILITY_UNKNOWN", error.code)
        assertTrue(error.backAttempted)
    }

    @Test fun backInjectionFailureCannotReportDismissed() {
        val device = DismissDevice(true, true, false).also { it.accepted = false }
        assertEquals("KEYBOARD_DISMISS_FAILED", assertThrows(KeyboardGuard.DismissRefused::class.java) { device.dismiss() }.code)
    }

    @Test fun keyboardRemainingShownTimesOutWithoutAnotherBack() {
        val device = DismissDevice(true)
        assertEquals("KEYBOARD_DISMISS_FAILED", assertThrows(KeyboardGuard.DismissRefused::class.java) { device.dismiss() }.code)
        assertEquals(1, device.events.count { it == "back" })
        assertEquals(2_000L, device.clock)
    }

    @Test fun changedScreenBeforeBackRefusesWithoutMutation() {
        val device = DismissDevice(true).also { it.unchanged = false }
        val error = assertThrows(KeyboardGuard.DismissRefused::class.java) { device.dismiss() }
        assertEquals("ACTION_CONTEXT_CHANGED", error.code)
        assertFalse(error.backAttempted)
        assertFalse(device.events.contains("back"))
    }

    @Test fun navigationOrExitIsNotKeyboardDismissal() {
        var reads = 0
        val error = assertThrows(KeyboardGuard.DismissRefused::class.java) {
            KeyboardGuard.dismiss(
                shown = { ++reads <= 2 },
                sameScreen = { reads <= 2 },
                pressBack = { true },
                now = { 0L },
                sleep = {},
            )
        }
        assertEquals("ACTION_CONTEXT_CHANGED", error.code)
        assertTrue(error.backAttempted)
    }

    private fun node(label: String, rect: QaHierarchy.Bounds, visible: Boolean, type: String = "android.widget.Button") =
        QaHierarchy.node(
            QaHierarchy.RawNode(
                className = type, text = label, contentDescription = null, viewIdResourceName = null, packageName = "app",
                bounds = rect, enabled = true, visibleToUser = visible, selected = false, checked = false,
                password = false, heading = false, children = emptyList(),
            ),
        )!!

    @Test fun keyboardResizeKeepsScreenContent() {
        val covered = listOf(
            node("Submit", QaHierarchy.Bounds(0, 900, 100, 1000), visible = false),
            node("", QaHierarchy.Bounds(0, 1200, 1080, 1920), visible = true, type = "Keyboard"),
        )
        val revealed = listOf(node("Submit", QaHierarchy.Bounds(0, 1500, 100, 1600), visible = true))
        assertEquals(KeyboardGuard.screenContent(covered), KeyboardGuard.screenContent(revealed))
        assertNotEquals(
            KeyboardGuard.screenContent(covered),
            KeyboardGuard.screenContent(listOf(node("Back", QaHierarchy.Bounds(0, 1500, 100, 1600), visible = true))),
        )
    }

    @Test fun visibilityReadExceptionNeverPressesBack() {
        val error = assertThrows(KeyboardGuard.DismissRefused::class.java) {
            KeyboardGuard.dismiss(
                shown = { throw IllegalStateException("unavailable") },
                sameScreen = { throw AssertionError("unexpected screen read") },
                pressBack = { throw AssertionError("unexpected BACK") },
                now = { 0L },
                sleep = {},
            )
        }
        assertFalse(error.backAttempted)
    }

    @Test fun shownStateParsingDoesNotDependOnImePackageOrDumpLayout() {
        assertEquals(true, KeyboardGuard.inputShown("  mShowRequested=true mInputShown=true\n"))
        assertEquals(false, KeyboardGuard.inputShown("  mInputShown=false\n  mCurId=any.ime/.Keyboard"))
        assertEquals(true, KeyboardGuard.inputShown(" mShowExplicitlyRequested=false mShowForced=false mInputShown=true"))
    }

    @Test fun unsupportedMissingOrAmbiguousShownStateIsUnknown() {
        for (dump in listOf("", "Permission Denial", "mShowRequested=true", "mInputShown=unknown", "mInputShown=true\nmInputShown=false", "mInputShown=true\nmInputShown=true", "mInputShown=trueish", "mInputShown=true mInputShown=false", "mInputShown=true\nmInputShown=unknown")) {
            assertNull(KeyboardGuard.inputShown(dump))
        }
    }

    @Test fun occludedWhenInsideImeRect() = assertTrue(KeyboardGuard.shouldDismiss(0, 1400, 1080, 2400, 540, 1600, 150))
    @Test fun notOccludedAboveIme() = assertFalse(KeyboardGuard.shouldDismiss(0, 1400, 1080, 2400, 540, 1200, 150))
    @Test fun tooShortRectRejected() = assertFalse(KeyboardGuard.shouldDismiss(0, 2360, 1080, 2400, 540, 2380, 150))
    @Test fun emptyRectNeverOccludes() = assertFalse(KeyboardGuard.shouldDismiss(0, 0, 0, 0, 5, 9999, 150))
    @Test fun tapAtImeRightNotContained() = assertFalse(KeyboardGuard.shouldDismiss(0, 1400, 1080, 2400, 1080, 1600, 150))
    @Test fun tapAtImeBottomNotContained() = assertFalse(KeyboardGuard.shouldDismiss(0, 1400, 1080, 2400, 540, 2400, 150))
}
