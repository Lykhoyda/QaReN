package dev.lykhoyda.rndevagent.androidrunner

/**
 * GH #378: decides whether the target app is already frontmost from the
 * interactive-windows list instead of `UiDevice.currentPackageName`, which
 * reports the IME/launcher package during keyboard transitions and made the
 * dispatcher fire a needless relaunch intent + ~10s `By.pkg` wait.
 *
 * Framework-free (like [KeyboardGuard]) so it is unit-testable on the JVM: the
 * caller flattens each `AccessibilityWindowInfo` to a [WindowSignature] and
 * passes `AccessibilityWindowInfo.TYPE_APPLICATION` as [applicationWindowType].
 */
object ForegroundGate {
    data class WindowSignature(val type: Int, val packageName: String?)

    /**
     * True when an application-type window belongs to [appPackage]. An IME or
     * system window sitting on top does not hide the app's own window, so the
     * keyboard being up no longer reads as "not foreground".
     */
    fun hasForegroundWindow(
        windows: List<WindowSignature>,
        appPackage: String,
        applicationWindowType: Int,
    ): Boolean {
        return windows.any { it.type == applicationWindowType && it.packageName == appPackage }
    }
}
