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
 * it becomes the snapshot under a synthetic `[0] Alert` root instead, as an
 * iOS system alert does.
 */
object QaHierarchy {
    const val MAX_NODES = 600
    const val SYSTEM_UI_PACKAGE = "com.android.systemui"

    data class Bounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val isEmpty: Boolean get() = right <= left || bottom <= top
        val isInverted: Boolean get() = right < left || bottom < top

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
        // A null child vanished or could not be read; it is counted as dropped.
        val children: List<RawNode?>,
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
    )

    sealed interface Front {
        val keyboard: RawWindow?

        data class App(val windows: List<RawWindow>, override val keyboard: RawWindow?) : Front
        data class Alert(val window: RawWindow, override val keyboard: RawWindow?) : Front
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
        val top = appWindows.lastOrNull() ?: return null
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

    fun assemble(windows: List<RawWindow>, appPackage: String, display: Bounds): Assembled {
        val front = front(windows, appPackage)
            ?: return Assembled(emptyList(), 0, false, false, false)
        val out = Builder()
        when (front) {
            is Front.App -> {
                out.synthetic("Application", display, null, appPackage)
                front.windows.forEach { window ->
                    val index = out.synthetic("Window", window.bounds, 0, window.packageName.orEmpty())
                    if (index != null) out.tree(window.root, index)
                }
            }
            is Front.Alert -> {
                out.synthetic("Alert", front.window.bounds, null, front.window.packageName.orEmpty())
                out.tree(front.window.root, 0)
            }
        }
        front.keyboard?.let { out.synthetic("Keyboard", it.bounds, 0, it.packageName.orEmpty()) }
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

        fun synthetic(type: String, bounds: Bounds, parent: Int?, packageName: String): Int? =
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
                ),
            )

        fun tree(root: RawNode?, parent: Int) {
            val pending = ArrayDeque<Pair<RawNode?, Int>>()
            pending.addLast(root to parent)
            while (pending.isNotEmpty() && !truncated) {
                val (raw, parentIndex) = pending.removeLast()
                if (raw == null) {
                    dropped += 1
                    continue
                }
                val bounds = raw.bounds
                val kept = if (bounds == null || bounds.isInverted) {
                    dropped += 1
                    parentIndex
                } else {
                    add(parentIndex, copy(raw, bounds)) ?: return
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

        private fun copy(raw: RawNode, bounds: Bounds): QaNode {
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
            )
        }
    }
}
