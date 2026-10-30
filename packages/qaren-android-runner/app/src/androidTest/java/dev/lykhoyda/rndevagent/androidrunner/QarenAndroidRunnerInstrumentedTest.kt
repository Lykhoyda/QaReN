/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.Configurator
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL

@LargeTest
@RunWith(AndroidJUnit4::class)
class QarenAndroidRunnerInstrumentedTest {
    private lateinit var server: CommandServer
    private var port: Int = 0

    @Before
    fun startServer() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val port = args.getString("RN_ANDROID_RUNNER_PORT")?.toIntOrNull() ?: 22089
        this.port = port
        val pluginVersion = args.getString("RN_PLUGIN_VERSION")
        val capability = requireNotNull(args.getString("RN_RUNNER_CAPABILITY"))
        val authority = RunnerAuthority(
            capability = capability,
            instanceId = requireNotNull(args.getString("RN_RUNNER_INSTANCE_ID")),
            sessionId = requireNotNull(args.getString("RN_RUNNER_SESSION_ID")),
            claimEpoch = requireNotNull(args.getString("RN_RUNNER_CLAIM_EPOCH")).toLong(),
            deviceId = requireNotNull(args.getString("RN_RUNNER_DEVICE_ID")),
            appId = requireNotNull(args.getString("RN_RUNNER_APP_ID")),
        )

        // Mirrors the iOS `withTemporaryScrollIdleTimeoutIfSupported` shim.
        // RN's main thread never reports quiescence when Reanimated/RAF worklets
        // are active — UIAutomator's `waitForIdle` then blocks until its timeout
        // ceiling and throws even after the action succeeded. We disable the
        // idle-wait entirely (`0` = no wait) and let each command handler add
        // its own minimal `Thread.sleep(50)` only where settle is genuinely
        // needed (focus propagation after `tap`, animation frame after `drag`).
        // Action and scroll acknowledgment timeouts stay at 500ms because those
        // gate the actual gesture synthesis, not idle wait.
        Configurator.getInstance().setWaitForIdleTimeout(0)
        Configurator.getInstance().setActionAcknowledgmentTimeout(500)
        Configurator.getInstance().setScrollAcknowledgmentTimeout(500)

        RunnerRuntime.dispatcher = CommandDispatcher(instrumentation, RunnerRuntime.journal)
        server = CommandServer(port, pluginVersion, authority)
        server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)

        Log.i("QarenAndroidRunner", "RN_ANDROID_RUNNER_LISTENER_READY")
        Log.i("QarenAndroidRunner", "RN_ANDROID_RUNNER_PORT=$port")
    }

    @Test
    fun mainLoop() {
        while (!Thread.currentThread().isInterrupted) {
            try {
                Thread.sleep(1_000)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    // Story 14 (#407): the server MUST journal error outcomes too, so a client
    // that lost the reply can probe `status`. Drive a `type` with no target and
    // no focused input (raises NoTextInputTargetException, GH #581) over the
    // real HTTP path, then read its outcome back through `status`.
    @Test
    fun errorOutcomeIsJournaledAndReadableViaStatus() {
        val id = "journal-err-${System.nanoTime()}"
        val typeResponse = postCommand(
            JSONObject().put("command", "type").put("commandId", id).put("text", "hello")
        )
        assertEquals(false, typeResponse.optBoolean("ok", true))

        val statusResponse = postCommand(
            JSONObject().put("command", "status").put("commandId", id)
        )
        val data = statusResponse.getJSONObject("data")
        assertEquals("failed", data.getString("state"))
        assertEquals(
            "NO_TEXT_INPUT_TARGET",
            data.getJSONObject("result").getJSONObject("error").getString("code"),
        )
    }

    private fun postCommand(command: JSONObject): JSONObject {
        val connection = URL("http://127.0.0.1:$port/command").openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty(
                "Authorization",
                "Bearer ${InstrumentationRegistry.getArguments().getString("RN_RUNNER_CAPABILITY")}",
            )
            connection.outputStream.use { it.write(command.toString().toByteArray(Charsets.UTF_8)) }
            val stream = if (connection.responseCode < 400) connection.inputStream else connection.errorStream
            JSONObject(stream.bufferedReader(Charsets.UTF_8).use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }

    @After
    fun stopServer() {
        if (::server.isInitialized) {
            server.stop()
        }
    }
}
