/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.graphics.Point
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.uiautomator.By
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.regex.Pattern
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

// GH #581: "none" requires read-back proof the field is unchanged; any
// clear/keyevent pass promotes to "observed"; unprovable states are "possible".
enum class MutationDisposition(val wire: String) {
    NONE("none"),
    OBSERVED("observed"),
    POSSIBLE("possible"),
}

open class TypedRunnerException(
    val code: String,
    message: String,
    val mutation: MutationDisposition,
) : IllegalStateException(message)

class NoTextInputTargetException(message: String) :
    TypedRunnerException("NO_TEXT_INPUT_TARGET", message, MutationDisposition.NONE)

class TextTargetFocusFailedException(message: String) :
    TypedRunnerException("TEXT_TARGET_FOCUS_FAILED", message, MutationDisposition.NONE)

class FocusTargetOccludedException(message: String) :
    TypedRunnerException("FOCUS_TARGET_OCCLUDED", message, MutationDisposition.NONE)

// Story 10 (#391): distinct from "no target" so the bridge descends to its
// clear-first Maestro tier instead of re-tapping a healthy focus.
class SetTextRejectedException(message: String, mutation: MutationDisposition) :
    TypedRunnerException("SET_TEXT_REJECTED", message, mutation)

class AccessibilityUnavailableException(message: String) : IllegalStateException(message)
class ExactPressException(
    val pressCode: String,
    val mutation: String,
    val reason: String,
    message: String,
) : IllegalStateException(message)

class CommandDispatcher(
    private val instrumentation: Instrumentation,
    private val journal: CommandJournal = CommandJournal(),
) {
    private val device: UiDevice = UiDevice.getInstance(instrumentation)

    companion object {
        // GH #418: advertised in /health.commands. The Node sync test
        // (cdp-bridge test/unit/gh-418-command-surface-sync.test.js) enforces
        // that this list exactly matches the dispatch when-branches below.
        val SUPPORTED_COMMANDS = listOf(
            "snapshot", "tap", "press", "type", "fill", "verifyInput", "drag", "swipe",
            "scroll", "screenshot", "back", "dismissKeyboard", "keyboard", "longPress",
            "pinch", "findText", "isWindowUpdating", "status", "systemAlertTap",
        )

        // GH #378: cold-start-only relaunch wait. The windows-based fast-path below
        // means this is reached only on a confirmed cold state (no app window, hence
        // no IME to stall By.pkg), so it no longer needs shortening to dodge the IME
        // stall. Kept at the original 10s: a genuinely cold RN/debug app can take
        // several seconds to expose its first By.pkg node, and slow verbs
        // (snapshot/type) get 35s client-side — a tighter cap would regress
        // cold-launch success without helping the stall the windows check already ends.
        const val FOREGROUND_READY_TIMEOUT_MS = 10_000L

        // Within the client's 10s command budget: the dialog animates out and the app's window returns.
        const val SYSTEM_ALERT_CLOSE_TIMEOUT_MS = 3_000L

        // GH #581: actual Android input class spellings — fully qualified only
        // (RN TextInput reports android.widget.EditText; bare names never match).
        val INPUT_CLASS_PATTERN: Pattern =
            Pattern.compile(".+\\.(\\w*EditText|\\w*AutoCompleteTextView)$")

        const val CLICKABLE_ANCESTOR_MAX_DEPTH = 16

        const val OCCLUDED_MESSAGE =
            "FOCUS_TARGET_OCCLUDED: the tap point is covered by another element; no tap was performed"

        const val SYSTEM_UI_OPT_IN_HINT =
            "For system UI outside the app, call device_find with includeSystemUi=true " +
                "and action=\"click\"."
    }

    init {
        val ua = instrumentation.uiAutomation
        val info = ua.serviceInfo
        if (info != null) {
            info.flags = info.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            ua.serviceInfo = info
        }
    }

    fun dispatch(cmd: JSONObject): JSONObject {
        val command = cmd.getString("command")
        val appPackage = cmd.optString("appBundleId").ifBlank { null }

        if (cmd.has("qaReadOnly") && cmd.opt("qaReadOnly") !is Boolean) {
            return error("INVALID_ARGUMENT", "qaReadOnly must be a boolean")
        }
        if (cmd.has("platformPresence")) {
            val budget = cmd.opt("presenceBudgetMs")
            if (cmd.opt("platformPresence") != true || command != "snapshot" || !cmd.optBoolean("qaReadOnly", false) ||
                budget !is Int || budget <= 0
            ) {
                return error("INVALID_ARGUMENT", "platformPresence needs a QA snapshot with a positive integer presenceBudgetMs")
            }
        }
        if (cmd.optBoolean("qaReadOnly", false)) {
            if (command !in setOf("snapshot", "verifyInput", "isWindowUpdating", "findText", "screenshot", "status") ||
                appPackage == null || QaHierarchy.front(liveWindows(), appPackage) == null
            ) {
                return error("ACTION_CONTEXT_CHANGED", "QA read requires the unchanged foreground target; no recovery attempted")
            }
        } else if (appPackage != null && command in setOf(
                "snapshot", "findText", "tap", "press", "type", "fill",
                "longPress", "drag", "swipe", "scroll", "pinch",
            )
        ) {
            foreground(appPackage)
        }

        // GH #581: the recorded type target is only valid until the screen can
        // change under it — any verb other than the type/verify pair drops it.
        if (command !in setOf("type", "fill", "verifyInput", "snapshot", "status", "isWindowUpdating", "screenshot")) {
            recordedTypeTarget = null
        }

        val data = when (command) {
            // Fork A: QA reads take one live traversal of the windows; device tools keep the XML dump.
            "snapshot" -> if (cmd.optBoolean("qaReadOnly", false)) {
                if (cmd.has("labelProvenance")) {
                    qaLabelProvenance(appPackage!!, cmd)
                } else {
                    qaSnapshot(appPackage!!, if (cmd.has("platformPresence")) cmd.getInt("presenceBudgetMs") else null)
                }
            } else {
                snapshot(appPackage)
            }
            "tap", "press" -> tap(cmd)
            "type", "fill" -> type(cmd)
            "verifyInput" -> verifyInput(cmd)
            "drag", "swipe", "scroll" -> drag(cmd)
            "screenshot" -> screenshot()
            "back" -> JSONObject().put("pressed", device.pressBack())
            "dismissKeyboard", "keyboard" -> dismissKeyboard(appPackage)
            // Settle probe (#385): read-only window-gate, deliberately absent from
            // the foregrounding whitelist above — it must never steal foreground,
            // and it IS the settle primitive so it adds no sleep of its own.
            "isWindowUpdating" -> {
                val timeoutMs = cmd.optLong("timeoutMs", 500L).coerceIn(0L, 2_000L)
                JSONObject().put("updating", device.waitForWindowUpdate(appPackage, timeoutMs))
            }
            "longPress" -> longPress(cmd)
            "pinch" -> pinch(cmd)
            "systemAlertTap" -> systemAlertTap(cmd, appPackage)
            // GH #444: optString defaults missing text to "" and By.textContains("")
            // matches an arbitrary node — refuse malformed requests instead.
            "findText" -> {
                if (cmd.optString("text").isBlank()) {
                    return error("INVALID_ARGUMENT", "findText requires a non-blank 'text' argument")
                }
                findText(cmd)
            }
            // Story 14 (#407): read-only outcome probe — answers from the journal,
            // never touches the device.
            "status" -> {
                val id = cmd.optString("commandId")
                if (id.isBlank()) return error("INVALID_ARGUMENT", "status requires a non-blank 'commandId'")
                val entry = journal.lookup(id)
                JSONObject()
                    .put("commandId", id)
                    .put("state", entry?.state ?: "unknown")
                    .apply { entry?.body?.let { put("result", JSONObject(it)) } }
            }
            // Note: TS-side `device_find` is a snapshot-based orchestrator (mirrors iOS).
            // The runner exposes `findText` only as an opt-in fast-path for existence checks.
            else -> return error("UNSUPPORTED_COMMAND", "Unsupported Android runner command: $command")
        }

        return JSONObject().put("ok", true).put("data", data)
    }

    private fun dismissKeyboard(appPackage: String?): JSONObject {
        var baseline: Pair<List<Int>, List<QaHierarchy.QaNode>>? = null
        fun screen(): Pair<List<Int>, List<QaHierarchy.QaNode>>? {
            if (appPackage == null) return null
            val read = enumerateQa(appPackage, null) ?: return null
            val front = QaHierarchy.front(read.windows, appPackage) as? QaHierarchy.Front.App ?: return null
            if (read.exhausted || read.assembled.truncated || read.assembled.droppedNodes != 0) return null
            return front.windows.map { it.id } to KeyboardGuard.screenContent(read.assembled.nodes)
        }
        val result = try {
            KeyboardGuard.dismiss(
                shown = { KeyboardGuard.inputShown(device.executeShellCommand("dumpsys input_method")) },
                sameScreen = {
                    val current = screen()
                    if (baseline == null) baseline = current
                    current != null && current == baseline
                },
                pressBack = { device.pressBack() },
                now = { SystemClock.uptimeMillis() },
                sleep = { SystemClock.sleep(it) },
            )
        } catch (e: KeyboardGuard.DismissRefused) {
            throw TypedRunnerException(
                e.code,
                "Keyboard dismissal could not prove an unchanged foreground screen and hidden input method",
                if (e.backAttempted) MutationDisposition.POSSIBLE else MutationDisposition.NONE,
            )
        }
        return JSONObject().put("wasVisible", result.wasVisible).put("dismissed", result.dismissed).put("visible", false)
    }

    private fun foreground(appPackage: String) {
        // GH #378: `currentPackageName` reports the IME/launcher package during
        // keyboard transitions, so the old equality-only fast-path missed and fired
        // a relaunch intent + a ~10s `By.pkg` wait that itself stalled behind the IME
        // window — breaching the client's 10s HTTP budget with the work already done.
        // An application window of the package existing is the robust "already
        // foreground" signal (not fooled by an IME/system window on top); only a
        // confirmed cold state warrants the relaunch.
        if (isPackageForeground(appPackage) || device.currentPackageName == appPackage) return
        val context = instrumentation.targetContext
        val intent = context.packageManager.getLaunchIntentForPackage(appPackage)
            ?: throw IllegalStateException("No launch intent for package $appPackage")
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        val ready = device.wait(Until.hasObject(By.pkg(appPackage)), FOREGROUND_READY_TIMEOUT_MS)
        if (!ready) {
            throw IllegalStateException("Package $appPackage did not foreground within ${FOREGROUND_READY_TIMEOUT_MS}ms")
        }
    }

    // GH #378: windows-based foreground probe. FLAG_RETRIEVE_INTERACTIVE_WINDOWS
    // (set in init) makes the app's own application window visible in the list even
    // while an IME window sits on top; the pure decision lives in ForegroundGate.
    private fun isPackageForeground(appPackage: String): Boolean {
        val windows = instrumentation.uiAutomation.windows.map {
            ForegroundGate.WindowSignature(it.type, it.root?.packageName?.toString())
        }
        return ForegroundGate.hasForegroundWindow(
            windows,
            appPackage,
            AccessibilityWindowInfo.TYPE_APPLICATION,
        )
    }

    private fun snapshot(appPackage: String?): JSONObject {
        if (appPackage != null) {
            val accessible = device.wait(Until.hasObject(By.pkg(appPackage)), 10_000)
            if (!accessible) {
                throw AccessibilityUnavailableException(
                    "App $appPackage is foreground but absent from UIAutomator accessibility after 10000ms; restart the rn-android-runner session or fix the app's accessibility exposure"
                )
            }
        }

        // The runner reads the windows itself: UiDevice.dumpWindowHierarchy logs
        // every off-screen child with its text. This keeps that dump's roots,
        // pre-order, visible-children rule, bounds and node fields.
        device.waitForIdle()
        val roots = windowRoots()
        val display = Rect(0, 0, device.displayWidth, device.displayHeight)
        val nodes = JSONArray()
        var normalizationDroppedNodes = 0

        fun visit(node: AccessibilityNodeInfo) {
            // The dump wrote bounds as Rect.toShortString() and the parser
            // dropped what it could not read back (negative coordinates).
            val bounds = parseBounds(visibleBoundsInScreen(node, display, trimScrollableParent = false).toShortString())
            if (bounds != null) {
                nodes.put(snapshotNode(node, nodes.length(), bounds))
            } else {
                normalizationDroppedNodes += 1
            }
            for (index in 0 until node.childCount) {
                val child = node.getChild(index) ?: continue
                if (child.isVisibleToUser) visit(child)
                child.recycle()
            }
        }
        roots.forEach { visit(it) }

        return JSONObject()
            .put("nodes", nodes)
            .put("truncated", false)
            .put("normalizationDroppedNodes", normalizationDroppedNodes)
    }

    private var qaSnapshotGeneration = 0
    private var qaSnapshotNodes: List<QaHierarchy.QaNode> = emptyList()

    private fun qaLabelProvenance(appPackage: String, cmd: JSONObject): JSONObject {
        val result = JSONObject()
        val requested = cmd.optJSONArray("labelProvenance") ?: return result
        val indices = (0 until requested.length()).map { requested.optInt(it, -1) }
        if (!cmd.optBoolean("platformPresence") || cmd.optInt("snapshotGeneration", -1) != qaSnapshotGeneration ||
            indices.isEmpty() || indices.size > 64 || indices.distinct().size != indices.size ||
            indices.any { it !in qaSnapshotNodes.indices }) return result
        val baseline = indices.map { qaSnapshotNodes[it] }
        val budget = cmd.optInt("presenceBudgetMs", 0)
        val started = SystemClock.uptimeMillis()
        var previous: List<QaHierarchy.QaNode>? = null
        var previousSources: List<String>? = null
        while (SystemClock.uptimeMillis() - started < budget) {
            val handles = mutableListOf<AccessibilityNodeInfo>()
            try {
                val enumerated = enumerateQa(appPackage, handles) ?: return result
                val (windows, assembled, exhausted) = enumerated
                if (!assembled.eligible || assembled.truncated || exhausted ||
                    indices.any { it !in assembled.nodes.indices }) return result
                val selected = indices.map { assembled.nodes[it] }
                val pass = PresencePass(appPackage, qaSnapshotGeneration, started, budget,
                    windows, assembled, exhausted, indices.toSet()).run()
                val sources = indices.map { pass.node(it).optString("labelSource") }
                val observed = indices.all { pass.node(it).optString("status") == "observed" }
                if (observed && PresenceRules.sameEnumeration(baseline, selected)) {
                    if (previous != null && PresenceRules.sameEnumeration(previous, selected) && previousSources == sources) {
                        return result.put("labelProvenance", JSONArray().apply {
                            indices.forEachIndexed { offset, index -> put(JSONObject().put("index", index).put("labelSource", sources[offset])) }
                        })
                    }
                    previous = selected.map { it.copy(source = null) }
                    previousSources = sources
                } else {
                    previous = null
                    previousSources = null
                }
            } finally {
                if (Build.VERSION.SDK_INT < 33) handles.forEach { it.recycle() }
            }
            val remaining = budget - (SystemClock.uptimeMillis() - started)
            if (remaining <= 0) break
            SystemClock.sleep(minOf(100L, remaining))
        }
        return result
    }

    // presenceBudgetMs: when set, the A11Y_PRESENCE_V2 pass runs after enumeration within that budget.
    private fun qaSnapshot(appPackage: String, presenceBudgetMs: Int?): JSONObject {
        val started = SystemClock.uptimeMillis()
        val deadline = started + 10_000
        while (QaHierarchy.front(liveWindows(), appPackage) == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(100)
        }
        val handles = if (presenceBudgetMs != null) mutableListOf<AccessibilityNodeInfo>() else null
        try {
            val enumerated = enumerateQa(appPackage, handles)
                ?: throw AccessibilityUnavailableException(
                    "App $appPackage is foreground but absent from UIAutomator accessibility after 10000ms; restart the rn-android-runner session or fix the app's accessibility exposure"
                )
            val (windows, assembled, exhausted) = enumerated
            qaSnapshotGeneration += 1
            qaSnapshotNodes = assembled.nodes.map { it.copy(source = null) }
            val presence = presenceBudgetMs?.let {
                PresencePass(appPackage, qaSnapshotGeneration, started, it, windows, assembled, exhausted).run()
            }
            val nodes = JSONArray()
            assembled.nodes.forEachIndexed { index, node ->
                val json = qaNodeJson(node)
                presence?.let { json.put("presence", it.node(index)) }
                nodes.put(json)
            }
            return JSONObject()
                .put("nodes", nodes)
                .put("truncated", assembled.truncated || exhausted)
                .put("normalizationDroppedNodes", assembled.droppedNodes)
                .put("snapshotGeneration", qaSnapshotGeneration)
                .put("keyboardVisible", assembled.keyboardVisible)
                .put("pointScale", instrumentation.targetContext.resources.displayMetrics.density.toDouble())
                .apply { presence?.let { put("presenceCapture", it.capture()) } }
        } finally {
            if (Build.VERSION.SDK_INT < 33) handles?.forEach { it.recycle() }
        }
    }

    private data class Enumerated(
        val windows: List<QaHierarchy.RawWindow>,
        val assembled: QaHierarchy.Assembled,
        val exhausted: Boolean,
    )

    // One live traversal of the front windows; with handles, every live node is kept for the presence pass.
    private fun enumerateQa(appPackage: String, handles: MutableList<AccessibilityNodeInfo>?): Enumerated? {
        val live = instrumentation.uiAutomation.windows.map { info ->
            val root = info.root
            rawWindow(info, root?.packageName?.toString()) to root
        }
        val front = QaHierarchy.front(live.map { it.first }, appPackage) ?: return null
        val read = when (front) {
            is QaHierarchy.Front.App -> front.windows.map { it.id }.toSet()
            is QaHierarchy.Front.Alert -> setOf(front.window.id)
        }
        val budget = CopyBudget(QaHierarchy.MAX_NODES + 1)
        val windows = live.map { (window, root) ->
            if (window.id in read && root != null) window.copy(root = copyNode(root, budget, handles)) else window
        }
        return Enumerated(windows, QaHierarchy.assemble(windows, appPackage, displayBounds()), budget.exhausted)
    }

    /**
     * The A11Y_PRESENCE_V2 pass over one QA enumeration: initial eligibility, per-node
     * observation, final eligibility and revalidation, each read checked against the budget.
     * Any failure leaves the capture incomplete and every node unknown.
     */
    private inner class PresencePass(
        private val appPackage: String,
        private val generation: Int,
        private val started: Long,
        private val budgetMs: Int,
        private val windows: List<QaHierarchy.RawWindow>,
        private val assembled: QaHierarchy.Assembled,
        private val exhausted: Boolean,
        private val candidateIndices: Set<Int>? = null,
    ) {
        private val captureId = "android-${java.util.UUID.randomUUID()}"
        private val phaseMs = JSONObject()
        private var failure: JSONObject? = null
        private var deadline: JSONObject? = null
        private var observations: List<PresenceRules.Observation> = emptyList()
        private var observedAt: LongArray = LongArray(0)
        private var ended = started

        private fun expired(phase: String, read: String): Boolean {
            if (SystemClock.uptimeMillis() - started < budgetMs) return false
            fail(phase, "deadline")
            deadline = JSONObject().put("phase", phase).put("read", read).put("edge", "before")
            return true
        }

        private fun fail(phase: String, reason: String) {
            if (failure == null) failure = JSONObject().put("phase", phase).put("reason", reason)
        }

        private inline fun phase(name: String, block: () -> Unit) {
            val at = SystemClock.uptimeMillis()
            if (failure == null) block()
            phaseMs.put(name, SystemClock.uptimeMillis() - at)
        }

        private fun eligible(assembled: QaHierarchy.Assembled): Boolean =
            assembled.eligible && !assembled.truncated && !exhausted && isPackageForeground(appPackage)

        fun run(): PresencePass {
            val nodes = assembled.nodes
            val labelSources = PresenceRules.labelSources(nodes)
            observations = labelSources.map { PresenceRules.Observation(false, it) }
            observedAt = LongArray(nodes.size)
            phase("initial-eligibility") { if (!eligible(assembled)) fail("initial-eligibility", "ineligible") }
            phase("observation") {
                val groups = PresenceRules.descriptorGroups(nodes)
                val keyboard = nodes.firstOrNull { it.type == "Keyboard" && it.source == null }?.rect
                observations = nodes.mapIndexed { index, node ->
                    if (candidateIndices != null && index !in candidateIndices) return@mapIndexed observations[index]
                    if (failure != null || expired("observation", "observation")) return@mapIndexed observations[index]
                    PresenceRules.observe(node, labelSources[index], groups[index], keyboard) { live(nodes, index) }
                        .also { if (it.observed) observedAt[index] = SystemClock.uptimeMillis() }
                }
            }
            phase("final-eligibility") {
                if (!expired("final-eligibility", "app-state")) {
                    val again = QaHierarchy.front(liveWindows(), appPackage)
                    val same = again is QaHierarchy.Front.App &&
                        again.windows.map { it.id } == windows.filter { it.root != null }.map { it.id }
                    if (!same || !isPackageForeground(appPackage)) fail("final-eligibility", "ineligible")
                }
            }
            phase("revalidation") {
                if (candidateIndices == null && !expired("revalidation", "revalidation")) {
                    val handles = mutableListOf<AccessibilityNodeInfo>()
                    try {
                        val again = enumerateQa(appPackage, handles)
                        if (again == null || again.exhausted ||
                            !PresenceRules.sameEnumeration(nodes, again.assembled.nodes)
                        ) {
                            fail("revalidation", "enumeration-changed")
                        }
                    } finally {
                        if (Build.VERSION.SDK_INT < 33) handles.forEach { it.recycle() }
                    }
                }
            }
            ended = SystemClock.uptimeMillis()
            if (ended - started >= budgetMs) fail("finalization", "deadline")
            return this
        }

        // The refresh, hit check and re-read of one node; null when the live node cannot be refreshed.
        private fun live(nodes: List<QaHierarchy.QaNode>, index: Int): PresenceRules.Live? {
            val handle = nodes[index].source?.handle as? AccessibilityNodeInfo ?: return null
            val refreshed = try {
                handle.refresh()
            } catch (e: RuntimeException) {
                false
            }
            if (!refreshed) return null
            val hit = PresenceRules.hit(nodes, index, windows)
            val reread = try {
                QaHierarchy.node(rawNode(handle, emptyList(), null))
            } catch (e: RuntimeException) {
                null
            }
            return PresenceRules.Live(hit, reread)
        }

        fun node(index: Int): JSONObject {
            val observation = observations[index]
            val complete = failure == null
            val json = JSONObject()
                .put("captureId", captureId)
                .put("generation", generation)
                .put("nodeIndex", index)
                .put("status", if (complete && observation.observed) "observed" else "unknown")
                .put("labelSource", observation.labelSource.wire)
            if (complete && observation.observed) json.put("observedUptimeMs", observedAt[index])
            if (complete) observation.reason?.let { json.put("unknownReason", it.wire) }
            return json
        }

        fun capture(): JSONObject {
            val diagnostics = JSONObject().put("phaseMs", phaseMs)
            failure?.let { diagnostics.put("failure", it) }
            deadline?.let { diagnostics.put("deadline", it) }
            return JSONObject()
                .put("version", 2)
                .put("source", "android-a11y-live")
                .put("enumeration", "app-windows")
                .put("captureId", captureId)
                .put("appId", appPackage)
                .put("generation", generation)
                .put("startedUptimeMs", started)
                .put("endedUptimeMs", ended)
                .put("complete", failure == null)
                .put("appliedBudgetMs", budgetMs)
                .put("pointScale", instrumentation.targetContext.resources.displayMetrics.density.toDouble())
                .put("diagnostics", diagnostics)
        }
    }

    private class CopyBudget(private val limit: Int) {
        private var used = 0
        var exhausted = false
            private set

        fun take(): Boolean {
            if (used >= limit) {
                exhausted = true
                return false
            }
            used += 1
            return true
        }
    }

    // A node that cannot be read is null, which the assembly counts as dropped. With
    // handles, the live children are kept (and recycled by the caller) for the presence pass.
    private fun copyNode(
        node: AccessibilityNodeInfo,
        budget: CopyBudget,
        handles: MutableList<AccessibilityNodeInfo>? = null,
    ): QaHierarchy.RawNode? = try {
        val children = mutableListOf<QaHierarchy.RawNode?>()
        for (index in 0 until node.childCount) {
            if (!budget.take()) break
            val child = node.getChild(index)
            children.add(
                child?.let {
                    if (handles != null) {
                        handles.add(it)
                        copyNode(it, budget, handles)
                    } else {
                        try {
                            copyNode(it, budget)
                        } finally {
                            it.recycle()
                        }
                    }
                },
            )
        }
        rawNode(node, children, if (handles != null) node else null)
    } catch (e: RuntimeException) {
        null
    }

    private fun rawNode(
        node: AccessibilityNodeInfo,
        children: List<QaHierarchy.RawNode?>,
        handle: AccessibilityNodeInfo?,
    ): QaHierarchy.RawNode {
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        return QaHierarchy.RawNode(
            className = node.className?.toString(),
            text = node.text?.toString(),
            contentDescription = node.contentDescription?.toString(),
            viewIdResourceName = node.viewIdResourceName,
            packageName = node.packageName?.toString(),
            bounds = QaHierarchy.Bounds(bounds.left, bounds.top, bounds.right, bounds.bottom),
            enabled = node.isEnabled,
            visibleToUser = node.isVisibleToUser,
            selected = node.isSelected,
            checked = node.isChecked,
            password = node.isPassword,
            heading = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && node.isHeading,
            children = children,
            editable = node.isEditable,
            drawingOrder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) node.drawingOrder else null,
            clickable = node.isClickable,
            handle = handle,
        )
    }

    private fun rawWindow(info: AccessibilityWindowInfo, packageName: String?): QaHierarchy.RawWindow {
        val bounds = Rect().also { info.getBoundsInScreen(it) }
        return QaHierarchy.RawWindow(
            id = info.id,
            kind = when (info.type) {
                AccessibilityWindowInfo.TYPE_APPLICATION -> QaHierarchy.WindowKind.APPLICATION
                AccessibilityWindowInfo.TYPE_INPUT_METHOD -> QaHierarchy.WindowKind.INPUT_METHOD
                AccessibilityWindowInfo.TYPE_SYSTEM -> QaHierarchy.WindowKind.SYSTEM
                else -> QaHierarchy.WindowKind.OTHER
            },
            layer = info.layer,
            packageName = packageName,
            bounds = QaHierarchy.Bounds(bounds.left, bounds.top, bounds.right, bounds.bottom),
        )
    }

    private fun liveWindows(): List<QaHierarchy.RawWindow> =
        instrumentation.uiAutomation.windows.map { rawWindow(it, it.root?.packageName?.toString()) }

    private fun displayBounds(): QaHierarchy.Bounds {
        val size = Point()
        val windowManager = instrumentation.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay.getRealSize(size)
        return QaHierarchy.Bounds(0, 0, size.x, size.y)
    }

    private fun qaNodeJson(node: QaHierarchy.QaNode): JSONObject {
        val json = JSONObject()
            .put("index", node.index)
            .put("depth", node.depth)
        node.parentIndex?.let { json.put("parentIndex", it) }
        json
            .put("type", node.type)
            .put("label", node.label)
            .put("identifier", node.identifier)
            .put("packageName", node.packageName)
            .put("checked", node.checked)
            .put(
                "rect",
                JSONObject()
                    .put("x", node.rect.left)
                    .put("y", node.rect.top)
                    .put("width", node.rect.right - node.rect.left)
                    .put("height", node.rect.bottom - node.rect.top),
            )
            .put("hittable", node.hittable)
            .put("enabled", node.enabled)
            .put("selected", node.selected)
            .put("visibleToUser", node.visibleToUser)
        if (node.secure) json.put("secure", true)
        if (node.heading) json.put("heading", true)
        return json
    }

    private fun snapshotNode(node: AccessibilityNodeInfo, index: Int, bounds: Rect): JSONObject {
        val text = xmlSafe(node.text)
        val desc = xmlSafe(node.contentDescription)
        val visible = node.isVisibleToUser
        val enabled = node.isEnabled
        val json = JSONObject()
            .put("index", index)
            .put("type", xmlSafe(node.className))
            .put("label", text.ifBlank { desc })
            .put("identifier", normalizeIdentifier(xmlSafe(node.viewIdResourceName)).ifBlank { desc })
            .put("packageName", xmlSafe(node.packageName))
            .put("checked", node.isChecked)
            .put("rect", JSONObject().put("x", bounds.left).put("y", bounds.top).put("width", bounds.width()).put("height", bounds.height()))
            .put("hittable", HittableSemantics.fromSnapshotNode(enabled, visible))
            .put("enabled", enabled)
        if (node.isPassword) json.put("secure", true)
        return json
    }

    // The dump's roots: the active window's root plus every window's root (on
    // every display from API 30), collected in a HashSet as UiDevice does, so
    // the iteration order, and with it each node's index, is the same.
    private fun windowRoots(): Array<AccessibilityNodeInfo> {
        val automation = instrumentation.uiAutomation
        val roots = HashSet<AccessibilityNodeInfo>()
        automation.rootInActiveWindow?.let { roots.add(it) }
        val windows = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val byDisplay = automation.windowsOnAllDisplays
            (0 until byDisplay.size()).flatMap { byDisplay.valueAt(it) }
        } else {
            automation.windows
        }
        windows.forEach { window -> window.root?.let { roots.add(it) } }
        return roots.toTypedArray()
    }

    // UiAutomator's visible-bounds rule: screen bounds clipped to the display
    // and the node's window (a disjoint clip is ignored, as Rect.intersect
    // leaves the rect unchanged), then optionally to the first scrollable
    // ancestor's own visible bounds. UiObject2.visibleBounds trims; the
    // window dump does not.
    private fun visibleBoundsInScreen(
        node: AccessibilityNodeInfo,
        display: Rect,
        trimScrollableParent: Boolean,
    ): Rect {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        bounds.intersect(display)
        node.window?.let { window ->
            val windowBounds = Rect()
            window.getBoundsInScreen(windowBounds)
            bounds.intersect(windowBounds)
        }
        if (trimScrollableParent) {
            var ancestor = node.parent
            while (ancestor != null) {
                if (ancestor.isScrollable) {
                    bounds.intersect(visibleBoundsInScreen(ancestor, display, trimScrollableParent = true))
                    break
                }
                ancestor = ancestor.parent
            }
        }
        return bounds
    }

    // The dump replaced characters XML cannot carry with '.'; null read as "".
    private fun xmlSafe(value: CharSequence?): String {
        if (value == null) return ""
        val out = StringBuilder(value.length)
        for (ch in value) {
            val invalid = ch in '\u0001'..'\u0008' || ch in '\u000B'..'\u000C' ||
                ch in '\u000E'..'\u001F' || ch in '\u007F'..'\u0084' ||
                ch in '\u0086'..'\u009F' || ch in '\uFDD0'..'\uFDDF'
            if (invalid) out.append('.') else out.append(ch)
        }
        return out.toString()
    }

    private fun tap(cmd: JSONObject): JSONObject {
        val exactIdentifier = cmd.optString("exactIdentifier").ifBlank { null }
        val exactType = cmd.optString("exactType").ifBlank { null }
        if (exactIdentifier != null && exactType != null) {
            val appPackage = cmd.optString("appBundleId").ifBlank { null }
            val includeSystemUi = cmd.optBoolean("includeSystemUi", false)
            val target = resolveExactPressNode(
                exactIdentifier,
                exactType,
                appPackage,
                includeSystemUi,
                requestedPoint(cmd),
            )
            val editable = target.isEditable
            val dispatched = try {
                target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            } finally {
                target.recycle()
            }
            if (!dispatched) {
                throw ExactPressException(
                    "INTERACTION_NOT_ACTUATED",
                    "none",
                    "accessibility-action-rejected",
                    "The exact accessibility target rejected ACTION_CLICK; no coordinate fallback was attempted.",
                )
            }
            val result = JSONObject()
                .put("tapped", true)
                .put("method", "accessibility-action")
                .put("identifier", exactIdentifier)
            // The core passes the post-act settle budget of this tap; without one the tap does not wait.
            if (editable && cmd.has("keyboardWaitMs")) {
                val shown = KeyboardEffect.await(
                    { imeBoundsInScreen() != null },
                    cmd.optLong("keyboardWaitMs", 0L).coerceAtLeast(0L),
                    SystemClock::uptimeMillis,
                    SystemClock::sleep,
                )
                result.put("keyboardShown", shown)
            }
            return result
        }

        val x = cmd.getDouble("x").roundToInt()
        val y = cmd.getDouble("y").roundToInt()
        if (!CoordinateBounds.contains(device.displayWidth, device.displayHeight, x, y)) {
            throw ExactPressException(
                "INTERACTION_NOT_ACTUATED",
                "none",
                "coordinate-out-of-bounds",
                "Requested tap point ($x, $y) lies outside the " +
                    "${device.displayWidth}x${device.displayHeight} display; nothing was injected.",
            )
        }
        val kbStart = SystemClock.uptimeMillis()
        val kb = applyKeyboardGuard(cmd, x, y)
        val kbMs = SystemClock.uptimeMillis() - kbStart
        return JSONObject().put("x", x).put("y", y).put("tapped", device.click(x, y))
            .put("keyboardGuard", kb).put("keyboardGuardMs", kbMs)
    }

    // SYSTEM_ALERT_TAP_V1: one labelled button of a system dialog above the app, by accessibility action only.
    private fun systemAlertTap(cmd: JSONObject, appPackage: String?): JSONObject {
        val refuse = { code: String, message: String ->
            TypedRunnerException(code, "$code: $message; nothing was tapped", MutationDisposition.NONE)
        }
        val requested = cmd.optJSONArray("labels")
        val labels = (0 until (requested?.length() ?: 0)).map { requested!!.opt(it) as? String ?: "" }
        if (appPackage == null || labels.isEmpty() || labels.any { it.isEmpty() }) {
            throw refuse("INVALID_ARGUMENT", "systemAlertTap requires appBundleId and non-empty labels")
        }
        val live = instrumentation.uiAutomation.windows.map { info ->
            val root = info.root
            rawWindow(info, root?.packageName?.toString()) to root
        }
        val front = QaHierarchy.front(live.map { it.first }, appPackage)
        val alertRoot = (front as? QaHierarchy.Front.Alert)?.let { alert -> live.first { it.first.id == alert.window.id }.second }
        val copied = when (front) {
            is QaHierarchy.Front.Alert ->
                front.copy(window = front.window.copy(root = alertRoot?.let { copyNode(it, CopyBudget(QaHierarchy.MAX_NODES + 1)) }))
            else -> front
        }
        val button = when (val match = QaHierarchy.dialogMatch(copied, labels, QaHierarchy.SYSTEM_DIALOG_OWNERS)) {
            is QaHierarchy.DialogMatch.Refused -> throw refuse(match.code, match.message)
            is QaHierarchy.DialogMatch.Button -> match
        }
        val target = button.path.fold(alertRoot) { node, index -> node?.getChild(index) }
        if (target == null || !target.isEnabled || target.text?.toString() != button.label) {
            throw refuse("SYSTEM_ALERT_CHANGED", "the system dialog or its button changed before the tap")
        }
        val rect = Rect().also { target.getBoundsInScreen(it) }
        if (!target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            throw refuse("SYSTEM_ALERT_TAP_FAILED", "the system dialog button rejected ACTION_CLICK")
        }
        // Only an alert window yields a match.
        val alert = copied as QaHierarchy.Front.Alert
        val deadline = SystemClock.uptimeMillis() + SYSTEM_ALERT_CLOSE_TIMEOUT_MS
        var closed = QaHierarchy.closed(alert, liveWindows(), appPackage)
        while (!closed && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(100)
            closed = QaHierarchy.closed(alert, liveWindows(), appPackage)
        }
        return JSONObject()
            .put("tappedLabel", button.label)
            .put(
                "tappedRect",
                JSONObject().put("x", rect.left).put("y", rect.top).put("width", rect.width()).put("height", rect.height()),
            )
            .put("alertClosed", closed)
    }

    private fun requestedPoint(cmd: JSONObject): Point? {
        val x = cmd.optDouble("x", Double.NaN)
        val y = cmd.optDouble("y", Double.NaN)
        return if (x.isNaN() || y.isNaN()) null else Point(x.roundToInt(), y.roundToInt())
    }

    private fun resolveExactPressNode(
        identifier: String,
        type: String,
        appPackage: String?,
        includeSystemUi: Boolean,
        requested: Point?,
    ): AccessibilityNodeInfo {
        if (!includeSystemUi && appPackage == null) {
            throw ExactPressException(
                "INTERACTION_NOT_ACTUATED",
                "none",
                "app-window-unavailable",
                "Exact Android interaction requires the owned app package. $SYSTEM_UI_OPT_IN_HINT",
            )
        }
        val matches = mutableListOf<AccessibilityNodeInfo>()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        instrumentation.uiAutomation.windows.forEach { window ->
            val root = window.root ?: return@forEach
            val packageName = root.packageName?.toString()
            if (includeSystemUi || packageName == appPackage) {
                stack.addLast(AccessibilityNodeInfo.obtain(root))
            }
        }
        var visited = 0
        while (stack.isNotEmpty() && visited++ < 20_000) {
            val node = stack.removeLast()
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let { stack.addLast(it) }
            }
            val nodeIdentifier = normalizeIdentifier(node.viewIdResourceName.orEmpty())
                .ifBlank { node.contentDescription?.toString().orEmpty() }
            val nodeType = node.className?.toString().orEmpty()
            if (nodeIdentifier == identifier && nodeType == type) matches.add(node) else node.recycle()
        }
        val traversalComplete = ExactPressSafety.traversalComplete(stack.size)
        while (stack.isNotEmpty()) stack.removeLast().recycle()
        if (!traversalComplete) {
            matches.forEach { it.recycle() }
            throw ExactPressException(
                "INTERACTION_NOT_ACTUATED",
                "none",
                "exact-target-unresolved",
                "Exact Android interaction exhausted its traversal budget; refusing partial evidence.",
            )
        }
        if (requested == null) {
            matches.forEach { it.recycle() }
            throw ExactPressException(
                "INTERACTION_NOT_ACTUATED",
                "none",
                "exact-target-point-unavailable",
                "Exact Android interaction has no owned snapshot point; refusing to guess.",
            )
        }
        val chosen = nodeContaining(matches, requested)
        if (chosen == null) {
            val found = matches.size
            matches.forEach { it.recycle() }
            throw ExactPressException(
                "INTERACTION_NOT_ACTUATED",
                "none",
                if (found == 0) "exact-target-missing" else "exact-target-ambiguous",
                if (found == 0) {
                    "Exact Android interaction resolved no matching target " +
                        (if (includeSystemUi) "on screen" else "inside the owned app window") +
                        "; refusing to guess." +
                        (if (includeSystemUi) "" else " $SYSTEM_UI_OPT_IN_HINT")
                } else {
                    "Exact Android interaction resolved $found matching targets and none " +
                        "uniquely contains the requested point; refusing to guess."
                },
            )
        }
        matches.forEach { if (it !== chosen) it.recycle() }
        return clickableAncestorOrSelf(chosen, requested)
    }

    private fun nodeContaining(
        matches: List<AccessibilityNodeInfo>,
        requested: Point?,
    ): AccessibilityNodeInfo? {
        if (requested == null) return null
        val bounds = Rect()
        return matches
            .filter { node ->
                node.getBoundsInScreen(bounds)
                bounds.contains(requested.x, requested.y)
            }
            .singleOrNull()
    }

    // A labelled RN node (accessibilityLabel on a Text/Image inside a Pressable)
    // is not itself clickable, so ACTION_CLICK would be rejected on a target a
    // coordinate tap used to hit through its ancestor.
    private fun clickableAncestorOrSelf(
        node: AccessibilityNodeInfo,
        requested: Point,
    ): AccessibilityNodeInfo {
        if (!liveTargetContains(node, requested)) {
            node.recycle()
            throw exactTargetNotHittable()
        }
        val clickable = if (node.isClickable) {
            node
        } else {
            var current: AccessibilityNodeInfo? = node.parent
            var depth = 0
            var owner: AccessibilityNodeInfo? = null
            while (current != null && depth++ < CLICKABLE_ANCESTOR_MAX_DEPTH) {
                if (current.isClickable) {
                    owner = current
                    break
                }
                val next = current.parent
                current.recycle()
                current = next
            }
            if (owner == null) {
                current?.recycle()
                node.recycle()
                throw ExactPressException(
                    "INTERACTION_NOT_ACTUATED",
                    "none",
                    "exact-target-not-clickable",
                    "Exact Android target has no live clickable owner; no coordinate fallback was attempted.",
                )
            }
            if (!liveTargetContains(owner, requested)) {
                owner.recycle()
                node.recycle()
                throw exactTargetNotHittable()
            }
            node.recycle()
            owner
        }
        try {
            requireUnoccluded(clickable, requested)
            return clickable
        } catch (error: Throwable) {
            clickable.recycle()
            throw error
        }
    }

    // DISPATCH_OCCLUSION_GUARD_V1: an enabled clickable node of the target's window
    // drawn above it, or a window above it, at the point refuses the tap.
    private fun requireUnoccluded(
        target: AccessibilityNodeInfo,
        requested: Point,
    ) {
        val targetPath = zOrderPath(target) ?: throw exactTargetZOrderUnresolved()
        val window = instrumentation.uiAutomation.windows.firstOrNull { it.id == target.windowId }
            ?: throw exactTargetNotHittable()
        val root = window.root ?: throw exactTargetNotHittable()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(AccessibilityNodeInfo.obtain(root))
        var visited = 0
        var sameWindow = ExactPressSafety.OcclusionVerdict.CLEAR
        val bounds = Rect()
        while (stack.isNotEmpty() && visited++ < 20_000) {
            val candidate = stack.removeLast()
            for (index in 0 until candidate.childCount) {
                candidate.getChild(index)?.let { stack.addLast(it) }
            }
            candidate.getBoundsInScreen(bounds)
            val actionableAtPoint = candidate.isEnabled && candidate.isVisibleToUser &&
                candidate.isClickable && !bounds.isEmpty &&
                bounds.contains(requested.x, requested.y)
            if (actionableAtPoint) {
                sameWindow = zOrderPath(candidate)?.let {
                    ExactPressSafety.sameWindowOcclusion(targetPath, it)
                } ?: ExactPressSafety.OcclusionVerdict.UNKNOWN
            }
            candidate.recycle()
            if (sameWindow != ExactPressSafety.OcclusionVerdict.CLEAR) break
        }
        val traversalComplete = ExactPressSafety.traversalComplete(stack.size)
        while (stack.isNotEmpty()) stack.removeLast().recycle()
        val otherWindows = ExactPressSafety.coveredByOtherWindow(
            liveWindows(),
            target.windowId,
            requested.x,
            requested.y,
        )
        when (ExactPressSafety.occlusionOutcome(sameWindow, otherWindows)) {
            ExactPressSafety.Outcome.OCCLUDED -> throw FocusTargetOccludedException(OCCLUDED_MESSAGE)
            ExactPressSafety.Outcome.UNRESOLVED -> throw exactTargetZOrderUnresolved()
            ExactPressSafety.Outcome.CLEAR -> Unit
        }
        if (!traversalComplete) {
            throw ExactPressException(
                "INTERACTION_NOT_ACTUATED",
                "none",
                "exact-target-unresolved",
                "Exact Android occlusion traversal exhausted its budget; refusing partial evidence.",
            )
        }
    }

    // The exact focus tap binds the input's own accessibility node, then runs the
    // same occlusion guard before any tap.
    private fun requireFocusTapUnoccluded(input: UiObject2, appPackage: String?, x: Int, y: Int) {
        val node = inputNode(input, appPackage) ?: throw ExactPressException(
            "INTERACTION_NOT_ACTUATED",
            "none",
            "exact-target-unresolved",
            "The exact Android input could not be bound to one accessibility node; no tap or typing was performed.",
        )
        try {
            requireUnoccluded(node, Point(x, y))
        } finally {
            node.recycle()
        }
    }

    private fun inputNode(input: UiObject2, appPackage: String?): AccessibilityNodeInfo? {
        val className = runCatching { input.className }.getOrNull() ?: return null
        val identifier = runCatching { objectIdentifier(input) }.getOrNull()
        val visible = runCatching { Rect(input.visibleBounds) }.getOrNull() ?: return null
        val matches = mutableListOf<AccessibilityNodeInfo>()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        instrumentation.uiAutomation.windows.forEach { window ->
            val root = window.root ?: return@forEach
            if (window.type == AccessibilityWindowInfo.TYPE_APPLICATION &&
                (appPackage == null || root.packageName?.toString() == appPackage)
            ) {
                stack.addLast(AccessibilityNodeInfo.obtain(root))
            }
        }
        var visited = 0
        val bounds = Rect()
        while (stack.isNotEmpty() && visited++ < 20_000) {
            val node = stack.removeLast()
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let { stack.addLast(it) }
            }
            val nodeIdentifier = normalizeIdentifier(node.viewIdResourceName.orEmpty())
                .ifBlank { node.contentDescription?.toString().orEmpty() }
                .ifBlank { null }
            node.getBoundsInScreen(bounds)
            if (node.className?.toString() == className && nodeIdentifier == identifier &&
                (identifier != null || bounds == visible)
            ) {
                matches.add(node)
            } else {
                node.recycle()
            }
        }
        val complete = ExactPressSafety.traversalComplete(stack.size)
        while (stack.isNotEmpty()) stack.removeLast().recycle()
        val chosen = if (!complete) {
            null
        } else {
            matches.singleOrNull() ?: matches.filter {
                it.getBoundsInScreen(bounds)
                bounds == visible
            }.singleOrNull()
        }
        matches.forEach { if (it !== chosen) it.recycle() }
        return chosen
    }

    private fun exactTargetZOrderUnresolved(): ExactPressException = ExactPressException(
        "INTERACTION_NOT_ACTUATED",
        "none",
        "exact-target-unresolved",
        "Exact Android draw order at the requested point could not be resolved " +
            "(unavailable below API 24, or the node path exceeded its depth cap); " +
            "refusing rather than pressing a possibly covered control.",
    )

    private fun zOrderPath(node: AccessibilityNodeInfo): List<ExactPressSafety.ZOrderStep>? {
        val path = mutableListOf<ExactPressSafety.ZOrderStep>()
        var current: AccessibilityNodeInfo? = AccessibilityNodeInfo.obtain(node)
        var depth = 0
        while (current != null && depth++ < 64) {
            path.add(
                ExactPressSafety.ZOrderStep(
                    nodeIdentity = current.hashCode(),
                    drawingOrder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        current.drawingOrder
                    } else {
                        null
                    },
                ),
            )
            val parent = current.parent
            current.recycle()
            current = parent
        }
        if (current != null) {
            current.recycle()
            return null
        }
        return path.asReversed()
    }

    private fun liveTargetContains(node: AccessibilityNodeInfo, requested: Point): Boolean {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        return ExactPressSafety.liveTargetIsHittable(
            node.isEnabled,
            node.isVisibleToUser,
            !bounds.isEmpty && bounds.contains(requested.x, requested.y),
        )
    }

    private fun exactTargetNotHittable(): ExactPressException = ExactPressException(
        "INTERACTION_NOT_ACTUATED",
        "none",
        "exact-target-not-hittable",
        "Exact Android target is disabled, invisible, obscured, or no longer owns the requested point.",
    )

    private fun imeBoundsInScreen(): Rect? {
        val ime = instrumentation.uiAutomation.windows
            .firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } ?: return null
        val r = Rect()
        ime.getBoundsInScreen(r)
        return if (r.isEmpty) null else r
    }

    private fun applyKeyboardGuard(cmd: JSONObject, x: Int, y: Int): String {
        if (!cmd.optBoolean("guardKeyboard", true)) return "off"
        val b = imeBoundsInScreen() ?: return "no_keyboard"
        return if (KeyboardGuard.shouldDismiss(b.left, b.top, b.right, b.bottom, x, y, 150)) {
            device.pressBack()
            device.waitForIdle(1500)
            "dismissed"
        } else {
            "not_occluded"
        }
    }

    private fun type(cmd: JSONObject): JSONObject {
        recordedTypeTarget = null
        val text = cmd.optString("text")
        // GH #581: bind the declared input exactly — never "click then use
        // whatever is focused". One operation resolves the target, skips the
        // focus tap only when THAT input is focused, otherwise taps the
        // declared focus point and proves the same input gained focus.
        val resolved = resolveExactTypeTarget(cmd)
        val target = resolved.obj
        var focusTap = "skipped-exact-focused"
        if (!isFocusedSafely(target)) {
            val bounds = target.visibleBounds
            val fx = cmd.optDouble("focusX", cmd.optDouble("x", bounds.exactCenterX().toDouble()))
                .roundToInt()
            val fy = cmd.optDouble("focusY", cmd.optDouble("y", bounds.exactCenterY().toDouble()))
                .roundToInt()
            imeBoundsInScreen()?.let { ime ->
                if (ime.contains(fx, fy)) {
                    throw FocusTargetOccludedException(
                        "FOCUS_TARGET_OCCLUDED: the focus tap point sits inside the visible keyboard; no tap or typing was performed. Dismiss the keyboard or scroll the input into view, then retry."
                    )
                }
            }
            requireFocusTapUnoccluded(target, cmd.optString("appBundleId").ifBlank { null }, fx, fy)
            device.click(fx, fy)
            val deadline = SystemClock.uptimeMillis() + cmd.optLong("focusWaitMs", 1500L)
            var focused = false
            while (true) {
                if (isFocusedSafely(target)) {
                    focused = true
                    break
                }
                if (SystemClock.uptimeMillis() >= deadline) break
                SystemClock.sleep(100)
            }
            if (!focused) {
                throw TextTargetFocusFailedException(
                    "TEXT_TARGET_FOCUS_FAILED: the bound input did not gain focus after tapping the declared focus target; no typing was performed. Increase waitForKeyboardMs or refresh the snapshot and retry."
                )
            }
            focusTap = "performed"
        }

        // Story 10 (#391): ACTION_SET_TEXT primary — atomic, full-Unicode
        // (emoji survive), fires the change events RN's onChangeText listens
        // to. Read back to classify the outcome; per-char keyevents (Maestro's
        // 75 ms pacing) only when the set was flat-out ignored and every
        // character has a keyevent representation. The value goes through the
        // bound input's own node: UiObject2.setText would log it.
        val node = when (val binding = bindInputNode(target, requireFocused = true)) {
            is InputBinding.Bound -> binding.node
            else -> throw NoTextInputTargetException(
                "NO_TEXT_INPUT_TARGET: the focused input could not be bound to exactly one accessibility node; no typing was performed"
            )
        }
        val before = readInput(node).text
        node.performAction(
            AccessibilityNodeInfo.ACTION_SET_TEXT,
            Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            },
        )
        var outcome = TextInputRecipe.classifySetText(text, before, readInput(node).text)
        var method = "setText"

        if (outcome == TextInputRecipe.SetTextOutcome.REJECTED) {
            // Codex P2 (#564): an empty request is a CLEAR — it has no keyevent
            // representation, but the stale-length delete pass below is exactly
            // how to honor it, so it must not throw here. Non-empty text must
            // map to keyevents AND fit the paced-typing budget (round-3: past
            // ~200 chars the 75 ms pacing would blow the client's 35 s budget).
            if (!TextInputRecipe.keyEventFallbackViable(text)) {
                throw SetTextRejectedException(
                    "Bound field ignored ACTION_SET_TEXT and the text has no viable keyevent fallback (non-ASCII or exceeds the paced-typing budget).",
                    mutation = MutationDisposition.NONE,
                )
            }
            // Codex P2 round-2 (#564): keyevents land in whatever is focused
            // NOW — if focus moved (OTP auto-advance), typing would hit the
            // wrong field. Refuse; the Maestro tier re-taps the target ref.
            val stillFocused = isFocusedSafely(target)
            if (!stillFocused) {
                throw SetTextRejectedException(
                    "Focus moved away from the target after ACTION_SET_TEXT — refusing the keyevent fallback (it would type into the newly focused field).",
                    mutation = MutationDisposition.NONE,
                )
            }
            // The rejected set left the prior value in place — clear it with
            // move-to-end + deletes so the keyevent pass can't append.
            val staleLen = before?.length ?: 0
            if (staleLen > 0) {
                injectKey(KeyEvent.KEYCODE_MOVE_END, 0)
                repeat(staleLen) { injectKey(KeyEvent.KEYCODE_DEL, 0) }
            }
            for (ch in text) {
                val stroke = TextInputRecipe.keyStrokeFor(ch) ?: continue
                injectKey(
                    stroke.keyCode,
                    if (stroke.shift) KeyEvent.META_SHIFT_ON else 0,
                )
                SystemClock.sleep(TextInputRecipe.KEYEVENT_PACING_MS)
            }
            method = "keyevents"
            outcome = TextInputRecipe.classifySetText(text, before, readInput(node).text)
            // Codex P2 round-2 (#564): the keyevent tier is judged strictly —
            // a TRANSFORMED read-back on a field that started non-empty can be
            // an under-deleted `old + text` remnant, not a formatter, so only
            // exact matches (or empty-start transforms) count as landed.
            if (!TextInputRecipe.keyEventOutcomeUsable(outcome, beforeWasEmpty = before.isNullOrEmpty())) {
                throw SetTextRejectedException(
                    "Bound field ignored both ACTION_SET_TEXT and the keyevent fallback.",
                    mutation = MutationDisposition.OBSERVED,
                )
            }
        }
        // Codex P2 (#564): UNVERIFIED (no read-back — the target node went
        // stale after a re-render) is NOT retype-fodder: the set may have
        // landed, so a keyevent pass could double-apply. Report honestly and
        // let the bridge's own verification layers arbitrate.

        recordTypeTarget(target, node, cmd)
        // GH #581: requested text is never echoed back (secret safety).
        return JSONObject()
            .put("typed", true)
            .put("method", method)
            .put("setTextOutcome", outcome.name.lowercase())
            .put("focusTap", focusTap)
            .put("inputResolution", resolved.resolution)
    }

    private data class ResolvedInput(val obj: UiObject2, val resolution: String)

    private data class RecordedTypeTarget(
        val target: UiObject2,
        val node: AccessibilityNodeInfo,
        val operationToken: String?,
        val className: String,
        val identifier: String?,
        val bounds: Rect,
        val snapshotGeneration: Int?,
        val snapshotNodeIndex: Int?,
    )

    private var recordedTypeTarget: RecordedTypeTarget? = null

    private fun optionalInt(cmd: JSONObject, key: String): Int? =
        if (cmd.has(key) && !cmd.isNull(key)) cmd.getInt(key) else null

    private fun optionalString(cmd: JSONObject, key: String): String? =
        cmd.optString(key).ifBlank { null }

    private fun recordTypeTarget(target: UiObject2, node: AccessibilityNodeInfo, cmd: JSONObject) {
        val className = runCatching { target.className ?: "" }
            .getOrDefault(optionalString(cmd, "snapshotElementType").orEmpty())
        val identifier = runCatching { objectIdentifier(target) }
            .getOrDefault(optionalString(cmd, "snapshotIdentifier"))
        val bounds = runCatching { Rect(target.visibleBounds) }
            .getOrElse { describedBounds(cmd) ?: Rect() }
        recordedTypeTarget = RecordedTypeTarget(
            target = target,
            node = node,
            operationToken = optionalString(cmd, "operationToken"),
            className = className,
            identifier = identifier,
            bounds = bounds,
            snapshotGeneration = optionalInt(cmd, "snapshotGeneration"),
            snapshotNodeIndex = optionalInt(cmd, "snapshotNodeIndex"),
        )
    }

    private fun objectIdentifier(obj: UiObject2): String? {
        val res = obj.resourceName?.let { normalizeIdentifier(it) }
        if (!res.isNullOrBlank()) return res
        val desc = obj.contentDescription
        return if (desc.isNullOrBlank()) null else desc.toString()
    }

    private fun isFocusedSafely(obj: UiObject2): Boolean = try {
        obj.isFocused
    } catch (e: StaleObjectException) {
        false
    }

    private fun inputCandidates(): List<UiObject2> =
        device.findObjects(By.clazz(INPUT_CLASS_PATTERN)).orEmpty()

    private fun boundsMatch(a: Rect, b: Rect, tolerance: Int = 8): Boolean =
        abs(a.centerX() - b.centerX()) <= tolerance &&
            abs(a.centerY() - b.centerY()) <= tolerance &&
            abs(a.width() - b.width()) <= tolerance &&
            abs(a.height() - b.height()) <= tolerance

    private fun strictlyContains(outer: Rect, inner: Rect): Boolean =
        outer != inner && outer.contains(inner)

    private fun describedBounds(cmd: JSONObject): Rect? {
        val bounds = cmd.optJSONObject("targetBounds") ?: return null
        return Rect(
            bounds.getDouble("x").roundToInt(),
            bounds.getDouble("y").roundToInt(),
            (bounds.getDouble("x") + bounds.getDouble("width")).roundToInt(),
            (bounds.getDouble("y") + bounds.getDouble("height")).roundToInt(),
        )
    }

    private fun targetIdentities(candidates: List<UiObject2>): List<TextInputRecipe.TargetIdentity> =
        candidates.map { candidate ->
            val bounds = candidate.visibleBounds
            TextInputRecipe.TargetIdentity(
                type = candidate.className ?: "",
                identifier = objectIdentifier(candidate),
                frame = TextInputRecipe.TargetFrame(
                    bounds.left,
                    bounds.top,
                    bounds.right,
                    bounds.bottom,
                ),
            )
        }

    // Exact binding tiers mirroring the iOS runner: unique identifier across
    // ALL recognized inputs, then unique bounds-equality, then a unique (or
    // strictly nested) point hit. Never "first match", never ambient focus for
    // a supplied target.
    private fun resolveExactTypeTarget(cmd: JSONObject): ResolvedInput {
        val identifier = cmd.optString("snapshotIdentifier").ifBlank { null }
        val expectedClass = cmd.optString("snapshotElementType").ifBlank { null }
        val allCandidates = inputCandidates()
        val described = describedBounds(cmd)
        if (identifier != null) {
            return when (
                val resolution = TextInputRecipe.resolveIdentifier(
                    targetIdentities(allCandidates),
                    expectedClass,
                    identifier,
                    described?.let {
                        TextInputRecipe.TargetFrame(it.left, it.top, it.right, it.bottom)
                    },
                    requireFrame = true,
                )
            ) {
                is TextInputRecipe.TargetResolution.Unique -> ResolvedInput(
                    allCandidates[resolution.index],
                    "identifier",
                )
                TextInputRecipe.TargetResolution.Ambiguous -> throw NoTextInputTargetException(
                    "NO_TEXT_INPUT_TARGET: identifier \"$identifier\" matches multiple text inputs; no typing was performed"
                )
                TextInputRecipe.TargetResolution.Absent -> throw NoTextInputTargetException(
                    "NO_TEXT_INPUT_TARGET: no text input matches identifier \"$identifier\"; no typing was performed"
                )
            }
        }
        val candidates = allCandidates.filter {
            expectedClass == null || (it.className ?: "") == expectedClass
        }
        if (described != null) {
            val byBounds = candidates.filter { boundsMatch(it.visibleBounds, described) }
            if (byBounds.size > 1) {
                throw NoTextInputTargetException(
                    "NO_TEXT_INPUT_TARGET: the described bounds match ${byBounds.size} text inputs; no typing was performed"
                )
            }
            return ResolvedInput(
                byBounds.firstOrNull() ?: throw NoTextInputTargetException(
                    "NO_TEXT_INPUT_TARGET: no text input matches the described bounds; refresh the snapshot and rebind, no typing was performed"
                ),
                "bounds",
            )
        }
        if (cmd.has("x") && cmd.has("y")) {
            val px = cmd.getDouble("x").roundToInt()
            val py = cmd.getDouble("y").roundToInt()
            val containing = candidates.filter { it.visibleBounds.contains(px, py) }
                .sortedBy { it.visibleBounds.width().toLong() * it.visibleBounds.height() }
            when {
                containing.isEmpty() -> throw NoTextInputTargetException(
                    "NO_TEXT_INPUT_TARGET: no text input exists at ($px, $py); typing into a previously focused field was removed — bind the input's ref/testID and retry"
                )
                containing.size == 1 -> return ResolvedInput(containing[0], "point")
                else -> {
                    for (i in 0 until containing.size - 1) {
                        if (!strictlyContains(containing[i + 1].visibleBounds, containing[i].visibleBounds)) {
                            throw NoTextInputTargetException(
                                "NO_TEXT_INPUT_TARGET: multiple non-nested text inputs overlap ($px, $py); bind the input's ref/testID and retry"
                            )
                        }
                    }
                    return ResolvedInput(containing[0], "point")
                }
            }
        }
        val focused = device.findObject(By.focused(true).clazz(INPUT_CLASS_PATTERN))
            ?: throw NoTextInputTargetException(
                "NO_TEXT_INPUT_TARGET: no text input is focused and no target was provided; app-wide blind typing was removed"
            )
        return ResolvedInput(focused, "focused")
    }

    private fun verifyInput(cmd: JSONObject): JSONObject {
        val expected = cmd.optString("text")
        val recorded = recordedTypeTarget
        var target: UiObject2? = null
        var recordedNode: AccessibilityNodeInfo? = null
        var lostVerdict = "target-lost"
        val operationToken = optionalString(cmd, "operationToken")
        if (operationToken != null) {
            if (recorded?.operationToken == operationToken) {
                target = recorded.target
                recordedNode = recorded.node
            }
        } else {
            val candidates = inputCandidates()
            val descriptorAgrees = recorded != null && TextInputRecipe.recordedDescriptorAgrees(
                recorded.snapshotGeneration,
                recorded.snapshotNodeIndex,
                recorded.className,
                recorded.identifier,
                optionalInt(cmd, "snapshotGeneration"),
                optionalInt(cmd, "snapshotNodeIndex"),
                optionalString(cmd, "snapshotElementType"),
                optionalString(cmd, "snapshotIdentifier"),
            )
            if (recorded != null && descriptorAgrees) {
                if (recorded.identifier != null) {
                    when (
                        val resolution = TextInputRecipe.resolveIdentifier(
                            targetIdentities(candidates),
                            recorded.className,
                            recorded.identifier,
                            null,
                            requireFrame = false,
                        )
                    ) {
                        is TextInputRecipe.TargetResolution.Unique -> target = candidates[resolution.index]
                        TextInputRecipe.TargetResolution.Ambiguous -> lostVerdict = "ambiguous"
                        TextInputRecipe.TargetResolution.Absent -> Unit
                    }
                } else {
                    val byRecord = candidates.filter {
                        (it.className ?: "") == recorded.className &&
                            objectIdentifier(it) == null &&
                            boundsMatch(it.visibleBounds, recorded.bounds)
                    }
                    when {
                        byRecord.size == 1 -> target = byRecord[0]
                        byRecord.size > 1 -> lostVerdict = "ambiguous"
                    }
                }
            }
            if (target == null && lostVerdict != "ambiguous") {
                val identifier = cmd.optString("snapshotIdentifier").ifBlank { null }
                val expectedClass = cmd.optString("snapshotElementType").ifBlank { null }
                val described = describedBounds(cmd)
                if (identifier != null) {
                    val frame = described?.let {
                        TextInputRecipe.TargetFrame(it.left, it.top, it.right, it.bottom)
                    }
                    when (
                        val resolution = TextInputRecipe.resolveIdentifier(
                            targetIdentities(candidates),
                            expectedClass,
                            identifier,
                            frame,
                            requireFrame = true,
                        )
                    ) {
                        is TextInputRecipe.TargetResolution.Unique -> target = candidates[resolution.index]
                        TextInputRecipe.TargetResolution.Ambiguous -> lostVerdict = "ambiguous"
                        TextInputRecipe.TargetResolution.Absent -> Unit
                    }
                } else if (described != null) {
                    val byFrame = candidates.filter {
                        (expectedClass == null || (it.className ?: "") == expectedClass) &&
                            boundsMatch(it.visibleBounds, described)
                    }
                    when {
                        byFrame.size == 1 -> target = byFrame[0]
                        byFrame.size > 1 -> lostVerdict = "ambiguous"
                    }
                }
            }
        }
        val resolved = target
            ?: return JSONObject().put("verifyVerdict", lostVerdict).put("verifyStable", false)
        val bound = recordedNode ?: when (val binding = bindInputNode(resolved, requireFocused = false)) {
            is InputBinding.Bound -> binding.node
            InputBinding.Ambiguous ->
                return JSONObject().put("verifyVerdict", "ambiguous").put("verifyStable", false)
            InputBinding.Absent ->
                return JSONObject().put("verifyVerdict", "target-lost").put("verifyStable", false)
        }
        val secure = cmd.optBoolean("secureInput", false)
        var previous: TextInputRecipe.VerifyObservation? = null
        var verdict = "unreadable"
        var stable = false
        for (attempt in 0 until 3) {
            val read = readInput(bound)
            val observation = TextInputRecipe.verifyObservation(
                expected,
                read.text,
                read.hint,
                read.hintKnown,
                secure,
            )
            verdict = observation.verdict
            if (previous == observation) {
                stable = true
                break
            }
            previous = observation
            if (attempt < 2) SystemClock.sleep(150)
        }
        return JSONObject().put("verifyVerdict", verdict).put("verifyStable", stable)
    }

    // Story 10 (#391): read back from the ORIGINAL target node, never from
    // By.focused — ACTION_SET_TEXT can move focus as a side effect (OTP
    // auto-advance), and reading "whatever is focused now" would misread a
    // successful write as a rejection from the next empty field (codex P2
    // round-2). A node staled by a re-render yields null → UNVERIFIED.
    private data class InputRead(val text: String?, val hint: String?, val hintKnown: Boolean)

    private fun readInput(node: AccessibilityNodeInfo): InputRead {
        device.waitForIdle(500)
        val fresh = try {
            node.refresh()
        } catch (e: IllegalStateException) {
            false
        }
        val hintState = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        return InputRead(
            text = TextInputRecipe.readableText(
                fresh,
                node.text?.toString(),
                if (hintState) node.isShowingHintText else null,
            ),
            hint = if (fresh && hintState) node.hintText?.toString() else null,
            hintKnown = fresh && hintState,
        )
    }

    private sealed interface InputBinding {
        data class Bound(val node: AccessibilityNodeInfo) : InputBinding
        data object Ambiguous : InputBinding
        data object Absent : InputBinding
    }

    // The resolved input's own accessibility node, which UiObject2 does not
    // expose: across the windows UiAutomator searches, exactly one visible node
    // with the input's class, identifier and visible bounds (and, before a
    // write, input focus). An incomplete traversal cannot prove uniqueness.
    // A layout still settling (the keyboard opening) gets a short retry.
    private fun bindInputNode(target: UiObject2, requireFocused: Boolean): InputBinding {
        val deadline = SystemClock.uptimeMillis() + 1_000L
        while (true) {
            val binding = matchInputNode(target, requireFocused)
            if (binding !is InputBinding.Absent || SystemClock.uptimeMillis() >= deadline) return binding
            SystemClock.sleep(100)
        }
    }

    private fun matchInputNode(target: UiObject2, requireFocused: Boolean): InputBinding {
        val roots = windowRoots()
        val className: String
        val identifier: String?
        val visible: Rect
        val display: Rect
        try {
            className = target.className.orEmpty()
            identifier = objectIdentifier(target)
            visible = Rect(target.visibleBounds)
            val displayId = target.displayId
            display = Rect(0, 0, device.getDisplayWidth(displayId), device.getDisplayHeight(displayId))
        } catch (e: StaleObjectException) {
            return InputBinding.Absent
        }
        val matches = mutableListOf<AccessibilityNodeInfo>()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        roots.forEach { stack.addLast(it) }
        var visited = 0
        while (stack.isNotEmpty() && visited++ < 20_000) {
            val node = stack.removeLast()
            // UiAutomator's own search never enters an invisible subtree.
            if (!node.isVisibleToUser) {
                node.recycle()
                continue
            }
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let { stack.addLast(it) }
            }
            val nodeIdentifier = normalizeIdentifier(node.viewIdResourceName.orEmpty())
                .ifBlank { node.contentDescription?.toString().orEmpty() }
                .ifBlank { null }
            val same = node.className?.toString().orEmpty() == className &&
                nodeIdentifier == identifier &&
                (!requireFocused || node.isFocused) &&
                visibleBoundsInScreen(node, display, trimScrollableParent = true) == visible
            if (same) matches.add(node) else node.recycle()
        }
        val complete = ExactPressSafety.traversalComplete(stack.size)
        while (stack.isNotEmpty()) stack.removeLast().recycle()
        if (!complete || matches.size > 1) {
            matches.forEach { it.recycle() }
            return InputBinding.Ambiguous
        }
        return matches.singleOrNull()?.let { InputBinding.Bound(it) } ?: InputBinding.Absent
    }

    // UiDevice.pressKeyCode's key events without its debug line, which names
    // every keycode and would let a typed value be rebuilt from logcat.
    private fun injectKey(keyCode: Int, metaState: Int) {
        device.waitForIdle()
        val time = SystemClock.uptimeMillis()
        val automation = instrumentation.uiAutomation
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(
                time,
                time,
                action,
                keyCode,
                0,
                metaState,
                KeyCharacterMap.VIRTUAL_KEYBOARD,
                0,
                0,
                InputDevice.SOURCE_KEYBOARD,
            )
            if (!automation.injectInputEvent(event, true)) return
        }
    }

    private fun drag(cmd: JSONObject): JSONObject {
        val x1 = cmd.optDouble("x1", cmd.optDouble("x")).roundToInt()
        val y1 = cmd.optDouble("y1", cmd.optDouble("y")).roundToInt()
        val x2 = cmd.getDouble("x2").roundToInt()
        val y2 = cmd.getDouble("y2").roundToInt()
        val steps = durationToSteps(cmd.optInt("durationMs", 300))
        val ok = device.swipe(x1, y1, x2, y2, steps)
        return JSONObject().put("x1", x1).put("y1", y1).put("x2", x2).put("y2", y2).put("durationMs", cmd.optInt("durationMs", 300)).put("dragged", ok)
    }

    private fun longPress(cmd: JSONObject): JSONObject {
        val x = cmd.getDouble("x").roundToInt()
        val y = cmd.getDouble("y").roundToInt()
        val durationMs = cmd.optInt("durationMs", 600)
        val kbStart = SystemClock.uptimeMillis()
        val kb = applyKeyboardGuard(cmd, x, y)
        val kbMs = SystemClock.uptimeMillis() - kbStart
        val ok = device.swipe(x, y, x, y, durationToSteps(durationMs))
        return JSONObject().put("x", x).put("y", y).put("durationMs", durationMs).put("pressed", ok)
            .put("keyboardGuard", kb).put("keyboardGuardMs", kbMs)
    }

    private fun pinch(cmd: JSONObject): JSONObject {
        val scale = cmd.optDouble("scale", 1.0)
        val root = device.findObject(By.depth(0)) ?: throw IllegalStateException("No root object available for pinch")
        // UIAutomator's pinchOpen/pinchClose take a Float ratio (0.0-1.0)
        // representing the percentage of the object's diagonal length.
        // The local `percent` (1-100, derived from `abs(scale - 1.0) * 100`)
        // is converted to that ratio by dividing by 100f.
        val percent = max(1, (abs(scale - 1.0) * 100).roundToInt()).coerceAtMost(100)
        val ratio = percent / 100f
        if (scale >= 1.0) root.pinchOpen(ratio, 500) else root.pinchClose(ratio, 500)
        return JSONObject().put("scale", scale).put("percent", percent)
    }

    private fun findText(cmd: JSONObject): JSONObject {
        val text = cmd.optString("text")
        val exact = cmd.optBoolean("exact", false)
        val obj = findByTextOrId(text, exact)
            ?: return JSONObject().put("found", false).put("text", text)

        return try {
            JSONObject()
                .put("found", true)
                .put("text", text)
                .put("node", uiObjectToJson(obj))
        } catch (e: StaleObjectException) {
            JSONObject().put("found", false).put("text", text).put("stale", true)
        }
    }

    private fun screenshot(): JSONObject {
        val file = File(instrumentation.targetContext.cacheDir, "rn-android-runner-screenshot.png")
        if (!device.takeScreenshot(file)) {
            throw IllegalStateException("UiDevice.takeScreenshot returned false")
        }
        val base64 = Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
        return JSONObject().put("pngBase64", base64)
    }

    private fun findByTextOrId(query: String, exact: Boolean): UiObject2? {
        val safe = Pattern.quote(query)
        // Anchor at start; require explicit `:id/` separator; match query as the
        // complete id-name (no suffix bleed-through like `cancel_submit` matching `submit`).
        val idPattern = Pattern.compile("^[^:]+:id/$safe$")
        return device.findObject(By.res(idPattern))
            ?: device.findObject(By.desc(query))
            ?: device.findObject(By.text(query))
            ?: if (exact) null else device.findObject(By.textContains(query))
    }

    private fun uiObjectToJson(obj: UiObject2): JSONObject {
        val b = obj.visibleBounds
        return JSONObject()
            .put("type", obj.className ?: "")
            .put("label", obj.text ?: obj.contentDescription ?: "")
            .put("identifier", obj.resourceName?.let { normalizeIdentifier(it) } ?: "")
            .put("rect", JSONObject().put("x", b.left).put("y", b.top).put("width", b.width()).put("height", b.height()))
            .put("hittable", HittableSemantics.fromFoundObject(obj.isEnabled, b.width(), b.height()))
    }

    private fun parseBounds(raw: String?): Rect? {
        if (raw.isNullOrBlank()) return null
        val match = Regex("""\[(\d+),(\d+)]\[(\d+),(\d+)]""").find(raw) ?: return null
        val (l, t, r, b) = match.destructured
        return Rect(l.toInt(), t.toInt(), r.toInt(), b.toInt())
    }

    private fun normalizeIdentifier(resourceId: String): String =
        QaHierarchy.normalizeIdentifier(resourceId)

    private fun durationToSteps(durationMs: Int): Int {
        return (durationMs / 5).coerceIn(1, 200)
    }

    private fun error(code: String, message: String): JSONObject {
        return JSONObject()
            .put("ok", false)
            .put("error", JSONObject().put("code", code).put("message", message))
    }
}
