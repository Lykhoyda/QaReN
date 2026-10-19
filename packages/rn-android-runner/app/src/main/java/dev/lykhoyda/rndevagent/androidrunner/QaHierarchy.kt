/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

/**
 * The QA snapshot shape, assembled from one live traversal of the accessibility
 * windows. Framework-free so it is unit-testable on the JVM: the dispatcher
 * copies `AccessibilityWindowInfo`/`AccessibilityNodeInfo` into [RawWindow]/[RawNode].
 *
 * App mode: `[0] Application` (display), one `Window` per app-package
 * application window bottom to top, each followed by its tree in pre-order,
 * then a synthetic `Keyboard` child of Application with the input-method
 * window's bounds. A window of another package above the app that intersects
 * it, or a system dialog owner's window standing in for the app's window,
 * becomes the snapshot under a synthetic `[0] Alert` root instead, as an iOS
 * system alert does.
 */
object QaHierarchy {
    const val MAX_NODES = 600
    const val SYSTEM_UI_PACKAGE = "com.android.systemui"

    // The packages whose front window is a system dialog: the permission controllers and the framework.
    val SYSTEM_DIALOG_OWNERS = setOf(
        "com.google.android.permissioncontroller",
        "com.android.permissioncontroller",
        "android",
    )

    data class Bounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val isEmpty: Boolean get() = right <= left || bottom <= top
        val isInverted: Boolean get() = right < left || bottom < top

        // Android clips a scrolled-out node's far edge to the viewport but keeps its
        // true origin, which inverts the rect; it is still that node's empty clipped rect.
        fun collapsed(): Bounds = Bounds(left, top, maxOf(left, right), maxOf(top, bottom))

        fun contains(x: Int, y: Int): Boolean =
            !isEmpty && x >= left && x < right && y >= top && y < bottom

        fun intersects(other: Bounds): Boolean =
            !isEmpty && !other.isEmpty &&
                left < other.right && other.left < right &&
                top < other.bottom && other.top < bottom
    }

    enum class WindowKind { APPLICATION, INPUT_METHOD, SYSTEM, OTHER }

    data class RawNode(
        val className: String?,
        val text: String?,
        val contentDescription: String?,
        val viewIdResourceName: String?,
        val packageName: String?,
        val bounds: Bounds?,
        val enabled: Boolean,
        val visibleToUser: Boolean,
        val selected: Boolean,
        val checked: Boolean,
        val password: Boolean,
        // AccessibilityNodeInfo.isHeading, read on API 28 and later; false below.
        val heading: Boolean,
        // A null child vanished or could not be read; it is counted as dropped.
        val children: List<RawNode?>,
        val editable: Boolean = false,
        // AccessibilityNodeInfo.drawingOrder among its siblings, read on API 24 and later.
        val drawingOrder: Int? = null,
        // AccessibilityNodeInfo.isClickable: only an enabled, visible, clickable view takes a touch.
        val clickable: Boolean = false,
        // The live node the presence pass refreshes and re-reads; opaque to the pure rules.
        val handle: Any? = null,
    )

    data class RawWindow(
        val id: Int,
        val kind: WindowKind,
        val layer: Int,
        val packageName: String?,
        val bounds: Bounds,
        val root: RawNode? = null,
    )

    data class QaNode(
        val index: Int,
        val depth: Int,
        val parentIndex: Int?,
        val type: String,
        val label: String,
        val identifier: String,
        val packageName: String,
        val rect: Bounds,
        val enabled: Boolean,
        val hittable: Boolean,
        val checked: Boolean,
        val selected: Boolean,
        val secure: Boolean,
        val visibleToUser: Boolean,
        val heading: Boolean,
        // Presence facts: never emitted as node fields.
        val editable: Boolean = false,
        val hasText: Boolean = false,
        val drawingOrder: Int? = null,
        val clickable: Boolean = false,
        val windowId: Int? = null,
        val source: RawNode? = null,
    )

    sealed interface Front {
        val keyboard: RawWindow?

        data class App(val windows: List<RawWindow>, override val keyboard: RawWindow?) : Front
        data class Alert(val window: RawWindow, override val keyboard: RawWindow?) : Front
    }

    sealed interface DialogMatch {
        // The button's child-index path from its window's root, so the live node is re-read before the tap.
        data class Button(val windowId: Int, val path: List<Int>, val label: String) : DialogMatch
        data class Refused(val code: String, val message: String) : DialogMatch
    }

    data class Assembled(
        val nodes: List<QaNode>,
        val droppedNodes: Int,
        val truncated: Boolean,
        val keyboardVisible: Boolean,
        // Exactly one app window and no foreign window in front (read by presence capture).
        val eligible: Boolean,
    )

    fun normalizeIdentifier(resourceId: String): String =
        resourceId.substringAfter(":id/", resourceId).substringAfterLast("/")

    /** Which windows the snapshot reads, from window metadata alone; null when the app has no window. */
    fun front(windows: List<RawWindow>, appPackage: String): Front? {
        val appWindows = windows
            .filter { it.kind == WindowKind.APPLICATION && it.packageName == appPackage }
            .sortedBy { it.layer }
        val keyboard = windows
            .filter { it.kind == WindowKind.INPUT_METHOD && !it.bounds.isEmpty }
            .maxByOrNull { it.layer }
        val top = appWindows.lastOrNull()
            ?: return standInDialog(windows)?.let { Front.Alert(it, keyboard) }
        val foreign = windows
            .filter {
                (it.kind == WindowKind.APPLICATION || it.kind == WindowKind.SYSTEM) &&
                    it.packageName != appPackage &&
                    it.packageName != SYSTEM_UI_PACKAGE &&
                    it.layer > top.layer &&
                    it.bounds.intersects(top.bounds)
            }
            .maxByOrNull { it.layer }
        return if (foreign != null) Front.Alert(foreign, keyboard) else Front.App(appWindows, keyboard)
    }

    // Android drops a window that a touch-modal window in front of it covers, so a system dialog
    // owner's application window with no app window listed is the dialog standing in for the app.
    private fun standInDialog(windows: List<RawWindow>): RawWindow? =
        windows.filter { it.kind == WindowKind.APPLICATION }.maxByOrNull { it.layer }
            ?.takeIf { it.packageName in SYSTEM_DIALOG_OWNERS }

    /**
     * The one enabled node whose text equals a requested label, in a front alert window owned by one of
     * [owners]. A label exposed only as a content description is no match: it is never tapped by coordinates.
     */
    fun dialogMatch(front: Front?, labels: List<String>, owners: Set<String>): DialogMatch {
        val alert = front as? Front.Alert
        if (alert == null || alert.window.packageName !in owners) {
            return DialogMatch.Refused("NO_SYSTEM_DIALOG", "no system dialog is in front of the app")
        }
        val found = mutableListOf<Pair<List<Int>, String>>()
        val pending = ArrayDeque<Pair<RawNode?, List<Int>>>()
        pending.addLast(alert.window.root to emptyList())
        while (pending.isNotEmpty()) {
            val (raw, path) = pending.removeLast()
            if (raw == null) continue
            val text = raw.text
            if (raw.enabled && text != null && text in labels) found.add(path to text)
            raw.children.forEachIndexed { index, child -> pending.addLast(child to path + index) }
        }
        return when (found.size) {
            0 -> DialogMatch.Refused("NO_SYSTEM_DIALOG", "the system dialog has no enabled button with a requested label")
            1 -> DialogMatch.Button(alert.window.id, found[0].first, found[0].second)
            else -> DialogMatch.Refused("TARGET_AMBIGUOUS", "the system dialog has ${found.size} buttons with a requested label")
        }
    }

    /** The tapped alert is closed once the app is in front again and that alert window is gone. */
    fun closed(before: Front.Alert, after: List<RawWindow>, appPackage: String): Boolean =
        front(after, appPackage) is Front.App && after.none { it.id == before.window.id }

    fun assemble(windows: List<RawWindow>, appPackage: String, display: Bounds): Assembled {
        val front = front(windows, appPackage)
            ?: return Assembled(emptyList(), 0, false, false, false)
        val out = Builder()
        when (front) {
            is Front.App -> {
                out.synthetic("Application", display, null, appPackage)
                front.windows.forEach { window ->
                    val index = out.synthetic("Window", window.bounds, 0, window.packageName.orEmpty(), window.id)
                    if (index != null) out.tree(window.root, index, window.id)
                }
            }
            is Front.Alert -> {
                out.synthetic("Alert", front.window.bounds, null, front.window.packageName.orEmpty(), front.window.id)
                out.tree(front.window.root, 0, front.window.id)
            }
        }
        front.keyboard?.let { out.synthetic("Keyboard", it.bounds, 0, it.packageName.orEmpty(), it.id) }
        return Assembled(
            nodes = out.nodes,
            droppedNodes = out.dropped,
            truncated = out.truncated,
            keyboardVisible = front.keyboard != null,
            eligible = front is Front.App && front.windows.size == 1,
        )
    }

    private class Builder {
        val nodes = mutableListOf<QaNode>()
        var dropped = 0
        var truncated = false

        fun synthetic(type: String, bounds: Bounds, parent: Int?, packageName: String, windowId: Int? = null): Int? =
            add(
                parent,
                QaNode(
                    index = 0,
                    depth = 0,
                    parentIndex = null,
                    type = type,
                    label = "",
                    identifier = "",
                    packageName = packageName,
                    rect = bounds,
                    enabled = true,
                    hittable = false,
                    checked = false,
                    selected = false,
                    secure = false,
                    visibleToUser = true,
                    heading = false,
                    windowId = windowId,
                ),
            )

        fun tree(root: RawNode?, parent: Int, windowId: Int) {
            val pending = ArrayDeque<Pair<RawNode?, Int>>()
            pending.addLast(root to parent)
            while (pending.isNotEmpty() && !truncated) {
                val (raw, parentIndex) = pending.removeLast()
                if (raw == null) {
                    dropped += 1
                    continue
                }
                val node = node(raw)
                val kept = if (node == null) {
                    dropped += 1
                    parentIndex
                } else {
                    add(parentIndex, node.copy(windowId = windowId)) ?: return
                }
                for (child in raw.children.asReversed()) pending.addLast(child to kept)
            }
        }

        private fun add(parent: Int?, node: QaNode): Int? {
            if (nodes.size >= MAX_NODES) {
                truncated = true
                return null
            }
            val index = nodes.size
            nodes.add(
                node.copy(
                    index = index,
                    depth = parent?.let { nodes[it].depth + 1 } ?: 0,
                    parentIndex = parent,
                ),
            )
            return index
        }
    }

    /** One raw node's QA fields, or null when its bounds cannot be kept (counted as dropped). */
    fun node(raw: RawNode): QaNode? {
        val bounds = raw.bounds?.let { if (it.isInverted && !raw.visibleToUser) it.collapsed() else it }
        if (bounds == null || bounds.isInverted) return null
        val desc = raw.contentDescription.orEmpty()
        return QaNode(
            index = 0,
            depth = 0,
            parentIndex = null,
            type = raw.className.orEmpty(),
            label = raw.text.orEmpty().ifBlank { desc },
            identifier = normalizeIdentifier(raw.viewIdResourceName.orEmpty()).ifBlank { desc },
            packageName = raw.packageName.orEmpty(),
            rect = bounds,
            enabled = raw.enabled,
            hittable = HittableSemantics.fromSnapshotNode(raw.enabled, raw.visibleToUser),
            checked = raw.checked,
            selected = raw.selected,
            secure = raw.password,
            visibleToUser = raw.visibleToUser,
            heading = raw.heading,
            editable = raw.editable,
            hasText = !raw.text.isNullOrBlank(),
            drawingOrder = raw.drawingOrder,
            clickable = raw.clickable,
            source = raw,
        )
    }
}
