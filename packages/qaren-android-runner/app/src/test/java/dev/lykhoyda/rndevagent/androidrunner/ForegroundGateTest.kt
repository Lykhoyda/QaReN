package dev.lykhoyda.rndevagent.androidrunner

import dev.lykhoyda.rndevagent.androidrunner.ForegroundGate.WindowSignature
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ForegroundGateTest {
    // Plain ints stand in for AccessibilityWindowInfo window-type constants; the
    // gate is framework-free and takes the application type as a parameter, so the
    // exact values are arbitrary as long as they differ (mirrors KeyboardGuardTest).
    private val app = 1
    private val ime = 2
    private val system = 3
    private val pkg = "com.rndevagent.testapp"

    private fun foreground(windows: List<WindowSignature>) =
        ForegroundGate.hasForegroundWindow(windows, pkg, app)

    @Test fun foregroundWhenApplicationWindowPresent() =
        assertTrue(foreground(listOf(WindowSignature(app, pkg))))

    // GH #378 regression: an IME window on top must NOT hide the app's own
    // application window — currentPackageName would report the keyboard here.
    @Test fun imeOnTopDoesNotHideApp() =
        assertTrue(
            foreground(
                listOf(
                    WindowSignature(ime, "com.google.android.inputmethod.latin"),
                    WindowSignature(app, pkg),
                ),
            ),
        )

    @Test fun coldStateWhenNoAppWindow() =
        assertFalse(
            foreground(
                listOf(
                    WindowSignature(app, "com.android.launcher3"),
                    WindowSignature(ime, "com.google.android.inputmethod.latin"),
                ),
            ),
        )

    // The package is on screen but only as a non-application window (e.g. an
    // overlay/toast); that is not a foregrounded activity.
    @Test fun appPackageInNonApplicationWindowIgnored() =
        assertFalse(foreground(listOf(WindowSignature(system, pkg))))

    @Test fun emptyWindowsNeverForeground() =
        assertFalse(foreground(emptyList()))

    @Test fun splitScreenMatchesTargetPackage() =
        assertTrue(
            foreground(
                listOf(
                    WindowSignature(app, "com.android.chrome"),
                    WindowSignature(app, pkg),
                ),
            ),
        )
}
