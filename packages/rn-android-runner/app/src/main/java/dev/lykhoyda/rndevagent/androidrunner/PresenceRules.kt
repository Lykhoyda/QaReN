/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.Bounds
import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.QaNode
import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.RawWindow

/**
 * The A11Y_PRESENCE_V2 per-node decisions over a QA snapshot. Framework-free so
 * the JVM tests cover every rule; the dispatcher supplies the live refresh,
 * re-read and window list.
 *
 * A node is observed only when no window and no enabled, visible, clickable node
 * of its window lies above its visible centre; transparent chrome that takes no
 * touch is not a cover. Anything uncertain is unknown with a reason, and a node
 * Android hides under the on-screen keyboard is keyboard-covered, not scrolled out.
 */
object PresenceRules {
    enum class LabelSource(val wire: String) { DIRECT("direct"), VALUE("value"), DESCENDANT("descendant"), NONE("none") }

    enum class Reason(val wire: String) {
        CLIPPED("clipped"),
        KEYBOARD_COVERED("keyboard-covered"),
        EMPTY_FRAME("empty-frame"),
        AMBIGUOUS_DESCRIPTOR("ambiguous-descriptor"),
        READ_UNAVAILABLE("read-unavailable"),
        NOT_HITTABLE("not-hittable"),
        POST_HIT_MISMATCH("post-hit-mismatch"),
    }

    data class Observation(val observed: Boolean, val labelSource: LabelSource, val reason: Reason? = null)

    enum class Hit { CLEAR, COVERED, UNRESOLVED }

    /** The live re-read after the hit check; null when the node could not be refreshed. */
    data class Live(val hit: Hit, val reread: QaNode?)

    private val STRUCTURAL = setOf("Application", "Window", "Keyboard", "Alert")

    fun structural(node: QaNode): Boolean = node.type in STRUCTURAL && node.source == null

    fun labelSources(nodes: List<QaNode>): List<LabelSource> {
        val textBelow = BooleanArray(nodes.size)
        for (index in nodes.indices.reversed()) {
            val parent = nodes[index].parentIndex ?: continue
            if (nodes[index].hasText || textBelow[index]) textBelow[parent] = true
        }
        return nodes.mapIndexed { index, node ->
            when {
                structural(node) -> LabelSource.NONE
                node.editable && node.hasText -> LabelSource.VALUE
                node.label.isNotBlank() -> LabelSource.DIRECT
                textBelow[index] -> LabelSource.DESCENDANT
                else -> LabelSource.NONE
            }
        }
    }

    private fun descriptor(node: QaNode) = listOf(node.type, node.identifier, node.label, node.rect)

    /** How many nodes share each node's descriptor (class, identifier, label, rect). */
    fun descriptorGroups(nodes: List<QaNode>): List<Int> {
        val counts = nodes.filterNot(::structural).groupingBy(::descriptor).eachCount()
        return nodes.map { if (structural(it)) 1 else counts.getValue(descriptor(it)) }
    }

    /** The table of the presence contract, first match wins; [live] runs only when the static rows pass. */
    fun observe(
        node: QaNode,
        labelSource: LabelSource,
        groupSize: Int,
        keyboard: Bounds?,
        live: () -> Live?,
    ): Observation {
        fun unknown(reason: Reason?) = Observation(false, labelSource, reason)
        if (structural(node) || (node.identifier.isBlank() && labelSource == LabelSource.NONE)) return unknown(null)
        // Checked before the empty-rect rule: a clipped node also has an empty rect.
        if (!node.visibleToUser) {
            val covered = keyboard != null && node.rect.intersects(keyboard)
            return unknown(if (covered) Reason.KEYBOARD_COVERED else Reason.CLIPPED)
        }
        if (node.rect.isEmpty) return unknown(Reason.EMPTY_FRAME)
        if (groupSize > 1) return unknown(Reason.AMBIGUOUS_DESCRIPTOR)
        val read = live() ?: return unknown(Reason.READ_UNAVAILABLE)
        if (read.hit != Hit.CLEAR) return unknown(Reason.NOT_HITTABLE)
        if (read.reread == null || !sameEvidence(node, read.reread)) return unknown(Reason.POST_HIT_MISMATCH)
        return Observation(true, labelSource)
    }

    /**
     * Whether anything that takes a touch lies above [target]'s visible centre: an enabled, visible,
     * clickable node of its window drawn above it, other than its own ancestors and descendants, or
     * any window above that window. A window covering the point at the same layer, or such a node
     * with a missing draw order, is unresolved.
     */
    fun hit(nodes: List<QaNode>, target: Int, windows: List<RawWindow>): Hit {
        val node = nodes[target]
        val x = (node.rect.left + node.rect.right) / 2
        val y = (node.rect.top + node.rect.bottom) / 2
        val window = windows.firstOrNull { it.id == node.windowId } ?: return Hit.UNRESOLVED
        var unresolved = false
        for (other in windows) {
            if (other.id == window.id || !other.bounds.contains(x, y)) continue
            if (other.layer > window.layer) return Hit.COVERED
            if (other.layer == window.layer) unresolved = true
        }
        val path = zOrderPath(nodes, target) ?: return Hit.UNRESOLVED
        for ((index, other) in nodes.withIndex()) {
            if (index == target || other.windowId != node.windowId || structural(other)) continue
            if (!other.enabled || !other.visibleToUser || !other.clickable || !other.rect.contains(x, y)) continue
            val otherPath = zOrderPath(nodes, index) ?: return Hit.UNRESOLVED
            when (ExactPressSafety.sameWindowOcclusion(path, otherPath)) {
                ExactPressSafety.OcclusionVerdict.CLEAR -> Unit
                ExactPressSafety.OcclusionVerdict.OCCLUDED -> return Hit.COVERED
                ExactPressSafety.OcclusionVerdict.UNKNOWN -> unresolved = true
            }
        }
        return if (unresolved) Hit.UNRESOLVED else Hit.CLEAR
    }

    // Root-first draw-order steps from the window's top node; null when a parent is missing.
    private fun zOrderPath(nodes: List<QaNode>, index: Int): List<ExactPressSafety.ZOrderStep>? {
        val steps = ArrayDeque<ExactPressSafety.ZOrderStep>()
        var current: Int? = index
        while (current != null) {
            val node = nodes.getOrNull(current) ?: return null
            if (structural(node)) break
            steps.addFirst(ExactPressSafety.ZOrderStep(current, node.drawingOrder))
            current = node.parentIndex
        }
        return steps.toList()
    }

    /** Every evidence field the core reads, as the presence pass compares them. */
    fun sameEvidence(a: QaNode, b: QaNode): Boolean =
        a.type == b.type && a.identifier == b.identifier && a.label == b.label && a.rect == b.rect &&
            a.enabled == b.enabled && a.selected == b.selected && a.secure == b.secure &&
            a.editable == b.editable && a.visibleToUser == b.visibleToUser && a.clickable == b.clickable

    /** The revalidation: the same nodes with the same evidence and the same ancestry. */
    fun sameEnumeration(a: List<QaNode>, b: List<QaNode>): Boolean =
        a.size == b.size && a.indices.all { i ->
            sameEvidence(a[i], b[i]) && a[i].depth == b[i].depth && a[i].parentIndex == b[i].parentIndex
        }
}
