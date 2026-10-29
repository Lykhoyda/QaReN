/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */

package dev.lykhoyda.rndevagent.androidrunner

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@LargeTest
@RunWith(AndroidJUnit4::class)
class SnapshotForegroundRegressionTest {
    @Test
    fun snapshotOfTargetApp_returnsTargetTree_afterForegroundActivation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(instrumentation)
        val targetPackage = "com.rndevagent.testapp"

        val intent = instrumentation.targetContext.packageManager.getLaunchIntentForPackage(targetPackage)
            ?: throw AssertionError("No launch intent for $targetPackage")
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        instrumentation.targetContext.startActivity(intent)

        assertTrue(
            "target app did not foreground",
            device.wait(Until.hasObject(By.pkg(targetPackage)), 10_000)
        )

        val roots = device.findObjects(By.depth(0))
        assertTrue("expected at least one depth-0 UIAutomator root", roots.isNotEmpty())

        val dispatcher = CommandDispatcher(instrumentation)
        val response = dispatcher.dispatch(
            JSONObject()
                .put("command", "snapshot")
                .put("appBundleId", targetPackage)
                .put("interactiveOnly", true)
        )

        val json = response.toString()
        assertTrue("expected target testID tab-home in snapshot: $json", json.contains("tab-home"))
        assertFalse("snapshot captured runner or launcher instead of target app: $json", json.contains("QaReN Android Runner"))
    }
}
