/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.Bounds
import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.WindowKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExactPressSafetyTest {
    @Test fun completedTraversalIsUsable() =
        assertTrue(ExactPressSafety.traversalComplete(0))

    @Test fun cappedTraversalWithPendingNodesIsUnresolved() =
        assertFalse(ExactPressSafety.traversalComplete(1))

    @Test fun liveEnabledTargetOwningThePointIsHittable() =
        assertTrue(ExactPressSafety.liveTargetIsHittable(true, true, true))

    @Test fun disabledTargetIsNotHittable() =
        assertFalse(ExactPressSafety.liveTargetIsHittable(false, true, true))

    @Test fun invisibleOrObscuredTargetIsNotHittable() =
        assertFalse(ExactPressSafety.liveTargetIsHittable(true, false, true))

    @Test fun targetThatMovedAwayFromThePointIsNotHittable() =
        assertFalse(ExactPressSafety.liveTargetIsHittable(true, true, false))

    @Test fun bottomSheetActionAboveCoveredControlIsAnOccluder() {
        val target = listOf(step(1, 0), step(2, 0), step(3, 0))
        val deleteTaskOnSheet = listOf(step(1, 0), step(4, 1), step(5, 0))

        assertEquals(
            ExactPressSafety.OcclusionVerdict.OCCLUDED,
            ExactPressSafety.sameWindowOcclusion(target, deleteTaskOnSheet),
        )
    }

    @Test fun lowerSiblingDoesNotOccludeTopmostExactTarget() {
        val target = listOf(step(1, 0), step(4, 1), step(5, 0))
        val lowerControl = listOf(step(1, 0), step(2, 0), step(3, 0))

        assertEquals(
            ExactPressSafety.OcclusionVerdict.CLEAR,
            ExactPressSafety.sameWindowOcclusion(target, lowerControl),
        )
    }

    @Test fun targetOwnershipAncestorsAndDescendantsAreNotOccluders() {
        val target = listOf(step(1, 0), step(2, 0))
        val targetChild = listOf(step(1, 0), step(2, 0), step(3, 1))

        assertEquals(
            ExactPressSafety.OcclusionVerdict.CLEAR,
            ExactPressSafety.sameWindowOcclusion(target, targetChild),
        )
        assertEquals(
            ExactPressSafety.OcclusionVerdict.CLEAR,
            ExactPressSafety.sameWindowOcclusion(targetChild, target),
        )
    }

    @Test fun distinctSiblingWithEqualDrawingOrderFailsClosed() {
        val target = listOf(step(1, 0), step(2, 0))
        val overlappingSibling = listOf(step(1, 0), step(3, 0))

        assertEquals(
            ExactPressSafety.OcclusionVerdict.OCCLUDED,
            ExactPressSafety.sameWindowOcclusion(target, overlappingSibling),
        )
    }

    @Test fun missingDrawingOrderIsUnknownRatherThanOccluded() {
        val target = listOf(step(1, 0), step(2, null))
        val overlappingSibling = listOf(step(1, 0), step(3, null))

        assertEquals(
            ExactPressSafety.OcclusionVerdict.UNKNOWN,
            ExactPressSafety.sameWindowOcclusion(target, overlappingSibling),
        )
        assertEquals(
            ExactPressSafety.OcclusionVerdict.CLEAR,
            ExactPressSafety.sameWindowOcclusion(target, listOf(step(1, 0), step(2, null))),
        )
    }

    @Test fun sameWindowOccluderIsOccludedNotUnhittable() = assertEquals(
        ExactPressSafety.Outcome.OCCLUDED,
        ExactPressSafety.occlusionOutcome(
            ExactPressSafety.OcclusionVerdict.OCCLUDED,
            ExactPressSafety.CrossWindow.CLEAR,
        ),
    )

    @Test fun unresolvedDrawOrderIsUnresolved() = assertEquals(
        ExactPressSafety.Outcome.UNRESOLVED,
        ExactPressSafety.occlusionOutcome(
            ExactPressSafety.OcclusionVerdict.UNKNOWN,
            ExactPressSafety.CrossWindow.CLEAR,
        ),
    )

    @Test fun aCoveringWindowWinsOverAnUnresolvedSameWindowOrder() {
        assertEquals(
            ExactPressSafety.Outcome.OCCLUDED,
            ExactPressSafety.occlusionOutcome(
                ExactPressSafety.OcclusionVerdict.UNKNOWN,
                ExactPressSafety.CrossWindow.COVERED,
            ),
        )
        assertEquals(
            ExactPressSafety.Outcome.UNRESOLVED,
            ExactPressSafety.occlusionOutcome(
                ExactPressSafety.OcclusionVerdict.CLEAR,
                ExactPressSafety.CrossWindow.UNRESOLVED,
            ),
        )
        assertEquals(
            ExactPressSafety.Outcome.CLEAR,
            ExactPressSafety.occlusionOutcome(
                ExactPressSafety.OcclusionVerdict.CLEAR,
                ExactPressSafety.CrossWindow.CLEAR,
            ),
        )
    }

    @Test fun anInputMethodWindowAboveThePointCoversIt() {
        val windows = listOf(appWindow, window(2, WindowKind.INPUT_METHOD, 9, "com.example.ime", Bounds(0, 1500, 1080, 2400)))
        assertEquals(ExactPressSafety.CrossWindow.COVERED, ExactPressSafety.coveredByOtherWindow(windows, 1, 500, 1600))
        assertEquals(ExactPressSafety.CrossWindow.CLEAR, ExactPressSafety.coveredByOtherWindow(windows, 1, 500, 1400))
    }

    @Test fun systemAndOtherPackageWindowsAboveCoverThePoint() {
        for (cover in listOf(
            window(2, WindowKind.SYSTEM, 9, "com.android.systemui", Bounds(0, 0, 1080, 100)),
            window(2, WindowKind.APPLICATION, 9, "com.android.permissioncontroller", Bounds(0, 0, 1080, 100)),
            window(2, WindowKind.OTHER, 9, "com.example.overlay", Bounds(0, 0, 1080, 100)),
            window(2, WindowKind.APPLICATION, 9, null, Bounds(0, 0, 1080, 100)),
        )) {
            assertEquals(
                cover.toString(),
                ExactPressSafety.CrossWindow.COVERED,
                ExactPressSafety.coveredByOtherWindow(listOf(appWindow, cover), 1, 500, 50),
            )
        }
    }

    @Test fun anAppModalWindowAboveALowerTargetCoversIt() {
        val modal = window(2, WindowKind.APPLICATION, 9, app, Bounds(100, 600, 980, 1800))
        assertEquals(ExactPressSafety.CrossWindow.COVERED, ExactPressSafety.coveredByOtherWindow(listOf(appWindow, modal), 1, 500, 1000))
        assertEquals(ExactPressSafety.CrossWindow.CLEAR, ExactPressSafety.coveredByOtherWindow(listOf(appWindow, modal), 2, 500, 1000))
    }

    @Test fun windowsBelowOrAwayFromThePointDoNotCoverIt() {
        val windows = listOf(
            appWindow,
            window(2, WindowKind.APPLICATION, 1, "com.example.launcher", Bounds(0, 0, 1080, 2400)),
            window(3, WindowKind.SYSTEM, 9, "com.android.systemui", Bounds(0, 0, 1080, 100)),
            window(4, WindowKind.OTHER, 9, app, Bounds(0, 0, 1080, 2400)),
        )
        assertEquals(ExactPressSafety.CrossWindow.CLEAR, ExactPressSafety.coveredByOtherWindow(windows, 1, 500, 1000))
    }

    @Test fun anUnknownTargetWindowOrAnEqualLayerIsUnresolved() {
        val twin = window(2, WindowKind.APPLICATION, 3, app, Bounds(0, 0, 1080, 2400))
        assertEquals(ExactPressSafety.CrossWindow.UNRESOLVED, ExactPressSafety.coveredByOtherWindow(listOf(appWindow), 9, 500, 1000))
        assertEquals(ExactPressSafety.CrossWindow.UNRESOLVED, ExactPressSafety.coveredByOtherWindow(listOf(appWindow, twin), 1, 500, 1000))
    }

    private val app = "com.example.app"
    private val appWindow = window(1, WindowKind.APPLICATION, 3, app, Bounds(0, 0, 1080, 2400))

    private fun window(id: Int, kind: WindowKind, layer: Int, packageName: String?, bounds: Bounds) =
        QaHierarchy.RawWindow(id, kind, layer, packageName, bounds)

    private fun step(nodeIdentity: Int, drawingOrder: Int?) =
        ExactPressSafety.ZOrderStep(nodeIdentity, drawingOrder)
}
