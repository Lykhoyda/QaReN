/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

/** Pure fail-closed decisions shared by exact accessibility press traversal. */
object ExactPressSafety {
    data class ZOrderStep(
        val nodeIdentity: Int,
        // null on API < 24, where AccessibilityNodeInfo.drawingOrder does not exist.
        val drawingOrder: Int?,
    )

    enum class OcclusionVerdict { CLEAR, OCCLUDED, UNKNOWN }

    fun traversalComplete(pendingNodeCount: Int): Boolean = pendingNodeCount == 0

    fun liveTargetIsHittable(
        enabled: Boolean,
        visibleToUser: Boolean,
        containsRequestedPoint: Boolean,
    ): Boolean = enabled && visibleToUser && containsRequestedPoint

    /**
     * Classifies whether a distinct same-window branch at the requested point
     * draws over the exact target. Ancestors and descendants are part of the
     * target's own ownership chain and therefore are not blockers; a missing
     * drawing order is reported as UNKNOWN rather than assumed either way.
     */
    fun sameWindowOcclusion(
        targetPath: List<ZOrderStep>,
        candidatePath: List<ZOrderStep>,
    ): OcclusionVerdict {
        val shared = targetPath.zip(candidatePath).takeWhile { (target, candidate) ->
            target.nodeIdentity == candidate.nodeIdentity
        }.size
        if (shared == targetPath.size || shared == candidatePath.size) return OcclusionVerdict.CLEAR
        val candidateOrder = candidatePath[shared].drawingOrder ?: return OcclusionVerdict.UNKNOWN
        val targetOrder = targetPath[shared].drawingOrder ?: return OcclusionVerdict.UNKNOWN
        return if (candidateOrder >= targetOrder) {
            OcclusionVerdict.OCCLUDED
        } else {
            OcclusionVerdict.CLEAR
        }
    }

    enum class CrossWindow { CLEAR, COVERED, UNRESOLVED }

    /** The DISPATCH_OCCLUSION_GUARD_V1 verdict before a tap or exact focus tap. */
    enum class Outcome { CLEAR, OCCLUDED, UNRESOLVED }

    /**
     * Whether a window drawn above the target's window covers the requested
     * point: an input-method, system or application window (an app modal
     * included), or any window of another package. A window sharing the
     * target window's layer leaves the draw order unresolved.
     */
    fun coveredByOtherWindow(
        windows: List<QaHierarchy.RawWindow>,
        targetWindowId: Int,
        x: Int,
        y: Int,
    ): CrossWindow {
        val target = windows.firstOrNull { it.id == targetWindowId } ?: return CrossWindow.UNRESOLVED
        var unresolved = false
        for (window in windows) {
            if (window.id == target.id || !window.bounds.contains(x, y)) continue
            val covers = window.kind != QaHierarchy.WindowKind.OTHER ||
                window.packageName != target.packageName
            if (!covers) continue
            if (window.layer > target.layer) return CrossWindow.COVERED
            if (window.layer == target.layer) unresolved = true
        }
        return if (unresolved) CrossWindow.UNRESOLVED else CrossWindow.CLEAR
    }

    fun occlusionOutcome(sameWindow: OcclusionVerdict, otherWindows: CrossWindow): Outcome = when {
        sameWindow == OcclusionVerdict.OCCLUDED || otherWindows == CrossWindow.COVERED -> Outcome.OCCLUDED
        sameWindow == OcclusionVerdict.UNKNOWN || otherWindows == CrossWindow.UNRESOLVED -> Outcome.UNRESOLVED
        else -> Outcome.CLEAR
    }
}
