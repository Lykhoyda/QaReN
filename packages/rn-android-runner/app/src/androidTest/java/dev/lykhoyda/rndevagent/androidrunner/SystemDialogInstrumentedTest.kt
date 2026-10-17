/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelFileDescriptor
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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

// SYSTEM_ALERT_TAP_V1 against the real notification permission prompt (API 33 and later).
@LargeTest
@RunWith(AndroidJUnit4::class)
class SystemDialogInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val testPackage: String = instrumentation.context.packageName
    private val dispatcher get() = sharedDispatcher

    @Before
    fun resetPermission() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        checkNotNull(dispatcher) // before the fixture launches, so the window list is enabled
        shell("pm revoke $testPackage $PERMISSION")
        shell("pm clear-permission-flags $testPackage $PERMISSION user-set user-fixed")
    }

    @After
    fun leaveFixture() {
        UiDevice.getInstance(instrumentation).pressHome()
    }

    @Test
    fun theNotificationPromptIsDismissedByItsLabelAndProvenClosed() {
        launchFixture(expectPrompt = true)
        val data = dispatcher.dispatch(systemAlertTap(DISMISS)).getJSONObject("data")

        assertTrue(data.getString("tappedLabel") in DISMISS)
        assertTrue(data.getBoolean("alertClosed"))
        assertEquals(PackageManager.PERMISSION_DENIED, instrumentation.context.checkSelfPermission(PERMISSION))
    }

    @Test
    fun theNotificationPromptIsAcceptedByItsLabelAndProvenClosed() {
        launchFixture(expectPrompt = true)
        val data = dispatcher.dispatch(systemAlertTap(listOf("Allow"))).getJSONObject("data")

        assertEquals("Allow", data.getString("tappedLabel"))
        assertTrue(data.getBoolean("alertClosed"))
        assertEquals(PackageManager.PERMISSION_GRANTED, instrumentation.context.checkSelfPermission(PERMISSION))
    }

    @Test
    fun noSystemDialogInFrontRefusesAndTapsNothing() {
        instrumentation.uiAutomation.grantRuntimePermission(testPackage, PERMISSION)
        launchFixture(expectPrompt = false)
        try {
            dispatcher.dispatch(systemAlertTap(DISMISS))
            fail("no system dialog must refuse")
        } catch (refusal: TypedRunnerException) {
            assertEquals("NO_SYSTEM_DIALOG", refusal.code)
            assertEquals(MutationDisposition.NONE, refusal.mutation)
        }
    }

    private fun launchFixture(expectPrompt: Boolean) {
        val intent = Intent()
            .setClassName(testPackage, SystemDialogFixtureActivity::class.java.name)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        instrumentation.context.startActivity(intent)
        val device = UiDevice.getInstance(instrumentation)
        assertTrue(device.wait(Until.hasObject(By.text(SystemDialogFixtureActivity.TITLE)), 10_000))
        if (!expectPrompt) return
        // The prompt's window joins the accessibility window list after the activity draws.
        val deadline = System.currentTimeMillis() + 10_000
        while (frontType() != "Alert" && System.currentTimeMillis() < deadline) Thread.sleep(100)
        assertEquals("Alert", frontType())
    }

    private fun frontType(): String? = dispatcher.dispatch(
        JSONObject().put("command", "snapshot").put("appBundleId", testPackage).put("qaReadOnly", true),
    ).optJSONObject("data")?.optJSONArray("nodes")?.optJSONObject(0)?.optString("type")

    private fun systemAlertTap(labels: List<String>): JSONObject =
        JSONObject()
            .put("command", "systemAlertTap")
            .put("appBundleId", testPackage)
            .put("labels", JSONArray(labels))

    private fun shell(command: String): String {
        val descriptor = instrumentation.uiAutomation.executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor)
            .bufferedReader()
            .use { it.readText() }
    }

    companion object {
        private val sharedDispatcher by lazy { CommandDispatcher(InstrumentationRegistry.getInstrumentation()) }

        const val PERMISSION = Manifest.permission.POST_NOTIFICATIONS
        val DISMISS = listOf("Don’t allow", "Don't allow")
    }
}
