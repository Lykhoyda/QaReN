/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject

object RunnerRuntime {
    lateinit var dispatcher: CommandDispatcher
    val journal: CommandJournal = CommandJournal()
}

data class RunnerAuthority(
    val capability: String,
    val instanceId: String,
    val sessionId: String,
    val claimEpoch: Long,
    val deviceId: String,
    val appId: String,
)

class CommandServer(
    port: Int,
    private val pluginVersion: String? = null,
    private val authority: RunnerAuthority,
) : NanoHTTPD(port) {
    override fun serve(session: IHTTPSession): Response {
        if (session.headers["authorization"] != "Bearer ${authority.capability}") {
            return json(
                Response.Status.UNAUTHORIZED,
                JSONObject()
                    .put("ok", false)
                    .put("error", JSONObject().put("code", "RUNNER_OWNERSHIP_MISMATCH").put("message", "invalid runner capability"))
            )
        }
        if (session.method == Method.GET && session.uri == "/health") {
            val body = JSONObject()
                .put("ok", true)
                .put("protocolVersion", RunnerProtocol.VERSION)
                .put("capabilities", JSONArray(listOf("WINDOW_UPDATE", "HONEST_HITTABLE", "APP_SCOPED_EXACT_INTERACTION", "QA_READ_ONLY_V1", "FILL_EVIDENCE_V1", "DISPATCH_OCCLUSION_GUARD_V1", "SYSTEM_ALERT_TAP_V1", "A11Y_PRESENCE_V2")))
                .put("commands", JSONArray(CommandDispatcher.SUPPORTED_COMMANDS))
                .put("instanceId", authority.instanceId)
                .put("sessionId", authority.sessionId)
                .put("claimEpoch", authority.claimEpoch)
                .put("deviceId", authority.deviceId)
                .put("appId", authority.appId)
            if (pluginVersion != null) body.put("runnerVersion", pluginVersion)
            return json(Response.Status.OK, body)
        }

        if (session.method != Method.POST || session.uri != "/command") {
            return json(
                Response.Status.NOT_FOUND,
                JSONObject()
                    .put("ok", false)
                    .put("error", JSONObject().put("code", "NOT_FOUND").put("message", "Use POST /command"))
            )
        }

        // Story 14 (#407): hoist the parsed request above the try so every catch
        // can journal the outcome — the "executed-and-failed, response lost" case
        // only recovers if failures journal too. A body that fails to parse stays
        // null and simply skips journaling.
        var command: JSONObject? = null
        return try {
            val files = HashMap<String, String>()
            session.parseBody(files)
            val raw = files["postData"] ?: "{}"
            val parsed = JSONObject(raw)
            command = parsed
            val body = RunnerRuntime.dispatcher.dispatch(parsed)
            record(parsed, body)
            json(Response.Status.OK, body)
        } catch (e: TypedRunnerException) {
            errorResponse(command, e.code, e.message ?: e.code, Response.Status.OK, e.mutation.wire)
        } catch (e: ExactPressException) {
            errorResponse(
                command,
                e.pressCode,
                e.message ?: "exact interaction failed",
                Response.Status.OK,
                mutation = e.mutation,
                reason = e.reason,
            )
        } catch (e: AccessibilityUnavailableException) {
            errorResponse(command, "ACCESSIBILITY_UNAVAILABLE", e.message ?: "accessibility unavailable", Response.Status.OK)
        } catch (t: Throwable) {
            errorResponse(command, "RUNNER_ERROR", t.message ?: t.javaClass.name, Response.Status.INTERNAL_ERROR)
        }
    }

    // Story 14 (#407): every /command outcome — success and failure — is journaled
    // before the response leaves, so a client that lost the reply can probe `status`.
    private fun errorResponse(
        command: JSONObject?,
        code: String,
        message: String,
        status: Response.Status,
        mutation: String? = null,
        reason: String? = null,
    ): Response {
        val error = JSONObject().put("code", code).put("message", message)
        if (mutation != null) error.put("mutation", mutation)
        if (reason != null) error.put("reason", reason)
        val body = JSONObject()
            .put("ok", false)
            .put("error", error)
        record(command, body)
        return json(status, body)
    }

    private fun record(command: JSONObject?, body: JSONObject) {
        val cmd = command ?: return
        RunnerRuntime.journal.record(
            cmd.optString("commandId").ifBlank { null },
            cmd.optString("command").ifBlank { null },
            body.optBoolean("ok", false),
            body.toString(),
        )
    }

    private fun json(status: Response.Status, body: JSONObject): Response {
        if (!body.has("v")) body.put("v", RunnerProtocol.VERSION)
        return newFixedLengthResponse(status, "application/json", body.toString())
    }
}
