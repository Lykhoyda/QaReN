/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import dev.lykhoyda.rndevagent.androidrunner.PresenceRules.Hit
import dev.lykhoyda.rndevagent.androidrunner.PresenceRules.LabelSource
import dev.lykhoyda.rndevagent.androidrunner.PresenceRules.Live
import dev.lykhoyda.rndevagent.androidrunner.PresenceRules.Reason
import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.Bounds
import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.RawNode
import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.RawWindow
import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.WindowKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PresenceRulesTest {
    private val app = "com.example.app"
    private val display = Bounds(0, 0, 1080, 2400)
    private val keyboardBounds = Bounds(0, 1517, 1080, 2400)
    private val appWindow = RawWindow(1, WindowKind.APPLICATION, 0, app, display)

    private fun raw(
        className: String = "android.widget.Button",
        bounds: Bounds = Bounds(40, 240, 1040, 340),
        viewId: String? = "save",
        text: String? = null,
        desc: String? = null,
        visibleToUser: Boolean = true,
        editable: Boolean = false,
        drawingOrder: Int? = 0,
        clickable: Boolean = false,
        enabled: Boolean = true,
        children: List<RawNode?> = emptyList(),
    ) = RawNode(
        className = className,
        text = text,
        contentDescription = desc,
        viewIdResourceName = viewId?.let { "$app:id/$it" },
        packageName = app,
        bounds = bounds,
        enabled = enabled,
        visibleToUser = visibleToUser,
        selected = false,
        checked = false,
        password = false,
        heading = false,
        children = children,
        editable = editable,
        drawingOrder = drawingOrder,
        clickable = clickable,
    )

    private fun assembled(root: RawNode, vararg windows: RawWindow) =
        QaHierarchy.assemble(listOf(appWindow.copy(root = root)) + windows, app, display).nodes

    private fun observe(
        nodes: List<QaHierarchy.QaNode>,
        index: Int,
        keyboard: Bounds? = null,
        live: () -> Live? = { Live(Hit.CLEAR, nodes[index]) },
    ) = PresenceRules.observe(
        nodes[index],
        PresenceRules.labelSources(nodes)[index],
        PresenceRules.descriptorGroups(nodes)[index],
        keyboard,
        live,
    )

    @Test fun eachRuleOfTheTableInOrder() {
        val nodes = assembled(
            raw(
                className = "android.view.ViewGroup", viewId = "root", bounds = display, drawingOrder = 0,
                children = listOf(
                    raw(className = "android.view.ViewGroup", viewId = null, drawingOrder = 0),
                    raw(viewId = "scrolled", bounds = Bounds(40, 2600, 1040, 2600), visibleToUser = false, drawingOrder = 1),
                    raw(viewId = "empty", bounds = Bounds(40, 400, 40, 500), drawingOrder = 2),
                    raw(viewId = "twin", bounds = Bounds(40, 600, 1040, 700), drawingOrder = 3),
                    raw(viewId = "twin", bounds = Bounds(40, 600, 1040, 700), drawingOrder = 4),
                    raw(viewId = "save", drawingOrder = 5),
                ),
            ),
        )
        val types = nodes.map { it.identifier.ifBlank { it.type } }
        assertEquals(
            listOf("Application", "Window", "root", "android.view.ViewGroup", "scrolled", "empty", "twin", "twin", "save"),
            types,
        )
        // Structural and non-anchors are skipped without a reason, as iOS skips them.
        for (index in listOf(0, 1, 3)) {
            val skipped = observe(nodes, index)
            assertFalse(skipped.observed)
            assertNull(skipped.reason)
        }
        assertEquals(Reason.CLIPPED, observe(nodes, 4).reason)
        assertEquals(Reason.EMPTY_FRAME, observe(nodes, 5).reason)
        assertEquals(Reason.AMBIGUOUS_DESCRIPTOR, observe(nodes, 6).reason)
        assertEquals(Reason.AMBIGUOUS_DESCRIPTOR, observe(nodes, 7).reason)
        assertEquals(Reason.READ_UNAVAILABLE, observe(nodes, 8) { null }.reason)
        assertEquals(Reason.NOT_HITTABLE, observe(nodes, 8) { Live(Hit.COVERED, nodes[8]) }.reason)
        assertEquals(Reason.NOT_HITTABLE, observe(nodes, 8) { Live(Hit.UNRESOLVED, nodes[8]) }.reason)
        val moved = nodes[8].copy(rect = Bounds(40, 250, 1040, 350))
        assertEquals(Reason.POST_HIT_MISMATCH, observe(nodes, 8) { Live(Hit.CLEAR, moved) }.reason)
        assertEquals(Reason.POST_HIT_MISMATCH, observe(nodes, 8) { Live(Hit.CLEAR, null) }.reason)
        val observed = observe(nodes, 8)
        assertTrue(observed.observed)
        assertNull(observed.reason)
    }

    @Test fun aStructuralNodeIsNeverObservedAndTheStaticRowsNeverReadTheLiveNode() {
        val nodes = assembled(raw(viewId = "save"), RawWindow(2, WindowKind.INPUT_METHOD, 1, "ime", keyboardBounds))
        assertEquals(listOf("Application", "Window", "android.widget.Button", "Keyboard"), nodes.map { it.type })
        for (index in listOf(0, 1, 3)) assertFalse(observe(nodes, index) { error("read a structural node") }.observed)
        val hidden = assembled(raw(viewId = "far", bounds = Bounds(40, 2600, 1040, 2600), visibleToUser = false))
        observe(hidden, 2) { error("read a clipped node") }
    }

    @Test fun aFieldUnderTheKeyboardIsKeyboardCoveredNotScrolledOut() {
        val nodes = assembled(
            raw(
                className = "android.widget.ScrollView", viewId = "form", bounds = display,
                children = listOf(
                    raw(className = "android.widget.EditText", viewId = "under", bounds = Bounds(63, 2044, 1017, 2137), visibleToUser = false),
                    raw(className = "android.widget.EditText", viewId = "below", bounds = Bounds(63, 2600, 1017, 2600), visibleToUser = false, drawingOrder = 1),
                ),
            ),
        )
        assertEquals(Reason.KEYBOARD_COVERED, observe(nodes, 3, keyboardBounds).reason)
        assertEquals(Reason.CLIPPED, observe(nodes, 4, keyboardBounds).reason)
        assertEquals(Reason.CLIPPED, observe(nodes, 3).reason)
    }

    @Test fun anEnabledClickableNodeDrawnAboveTheCentreOrAnyWindowAboveCoversIt() {
        val nodes = assembled(
            raw(
                className = "android.view.ViewGroup", viewId = "root", bounds = display,
                children = listOf(
                    raw(viewId = "save", drawingOrder = 0, clickable = true, children = listOf(raw(className = "android.widget.TextView", viewId = null, text = "Save"))),
                    raw(className = "android.view.ViewGroup", viewId = null, bounds = Bounds(0, 200, 1080, 400), drawingOrder = 1, clickable = true),
                    raw(className = "android.view.ViewGroup", viewId = null, bounds = Bounds(0, 0, 1080, 2400), visibleToUser = false, drawingOrder = 2, clickable = true),
                ),
            ),
        )
        val save = 3
        assertEquals("save", nodes[save].identifier)
        val windows = listOf(appWindow)
        // A clickable sibling drawn later takes the touch.
        assertEquals(Hit.COVERED, PresenceRules.hit(nodes, save, windows))
        // Its own descendants never cover it; the not-visible full-screen node is not drawn.
        val uncovered = nodes.filterIndexed { i, _ -> i != 5 }.mapIndexed { i, n -> n.copy(index = i) }
        assertEquals(Hit.CLEAR, PresenceRules.hit(uncovered, save, windows))
        val statusBar = RawWindow(9, WindowKind.SYSTEM, 1, "com.android.systemui", Bounds(0, 0, 1080, 300))
        assertEquals(Hit.COVERED, PresenceRules.hit(uncovered, save, windows + statusBar))
        val ime = RawWindow(8, WindowKind.INPUT_METHOD, 1, "ime", Bounds(0, 250, 1080, 2400))
        assertEquals(Hit.COVERED, PresenceRules.hit(uncovered, save, windows + ime))
        val sameLayer = RawWindow(7, WindowKind.APPLICATION, 0, app, display)
        assertEquals(Hit.UNRESOLVED, PresenceRules.hit(uncovered, save, windows + sameLayer))
        // A clickable sibling whose draw order is unknown leaves the hit unresolved.
        val noOrder = nodes.map { if (it.index == 5) it.copy(drawingOrder = null) else it }
        assertEquals(Hit.UNRESOLVED, PresenceRules.hit(noOrder, save, windows))
        // A disabled clickable sibling takes no touch.
        val disabled = nodes.map { if (it.index == 5) it.copy(enabled = false) else it }
        assertEquals(Hit.CLEAR, PresenceRules.hit(disabled, save, windows))
    }

    @Test fun transparentNonClickableChromeAboveTheCentreDoesNotCoverIt() {
        // The Test App's three full-screen covers, as the S3P-0 probe read them: the dev client's
        // ComposeView with its View, React Native's DebuggingOverlay host, and the parked bottom
        // sheet's container. None is clickable, so a touch passes through each of them.
        val nodes = assembled(
            raw(
                className = "android.widget.FrameLayout", viewId = null, bounds = display,
                children = listOf(
                    raw(
                        className = "android.view.ViewGroup", viewId = "app-root", bounds = display, drawingOrder = 0,
                        children = listOf(
                            raw(viewId = "save", drawingOrder = 0, clickable = true),
                            raw(
                                className = "android.view.ViewGroup", viewId = null, bounds = display, drawingOrder = 1,
                                children = listOf(raw(className = "android.view.View", viewId = null, bounds = display)),
                            ),
                            raw(className = "android.view.ViewGroup", viewId = null, bounds = display, drawingOrder = 2),
                        ),
                    ),
                    raw(
                        className = "androidx.compose.ui.platform.ComposeView", viewId = null, bounds = display, drawingOrder = 1,
                        children = listOf(raw(className = "android.view.View", viewId = null, bounds = display)),
                    ),
                ),
            ),
        )
        val save = nodes.indexOfFirst { it.identifier == "save" }
        assertEquals(Hit.CLEAR, PresenceRules.hit(nodes, save, listOf(appWindow)))
        // The same chrome, clickable, is a cover again: the rule weighs touches, not pixels.
        for (cover in nodes.indices.filter { nodes[it].identifier.isBlank() && nodes[it].index > save && nodes[it].type != "Application" && nodes[it].type != "Window" }) {
            val clickable = nodes.map { if (it.index == cover) it.copy(clickable = true) else it }
            assertEquals(nodes[cover].type, Hit.COVERED, PresenceRules.hit(clickable, save, listOf(appWindow)))
        }
        // A non-clickable cover with no draw order is not a cover, so it cannot leave the hit unresolved.
        val noOrder = nodes.map { if (it.index > save && it.identifier.isBlank()) it.copy(drawingOrder = null) else it }
        assertEquals(Hit.CLEAR, PresenceRules.hit(noOrder, save, listOf(appWindow)))
    }

    @Test fun labelSourcesNameWhereTheLabelCameFrom() {
        val nodes = assembled(
            raw(
                className = "android.view.ViewGroup", viewId = "card", bounds = display,
                children = listOf(
                    raw(className = "android.widget.EditText", viewId = "email", text = "typed", editable = true),
                    raw(viewId = "close", desc = "Close", drawingOrder = 1),
                    raw(className = "android.widget.TextView", viewId = null, text = "Title", drawingOrder = 2),
                ),
            ),
        )
        assertEquals(
            listOf(LabelSource.NONE, LabelSource.NONE, LabelSource.DESCENDANT, LabelSource.VALUE, LabelSource.DIRECT, LabelSource.DIRECT),
            PresenceRules.labelSources(nodes),
        )
    }

    @Test fun revalidationComparesEveryEvidenceFieldAndTheAncestry() {
        val nodes = assembled(raw(className = "android.view.ViewGroup", viewId = "root", bounds = display, children = listOf(raw())))
        assertTrue(PresenceRules.sameEnumeration(nodes, assembled(raw(className = "android.view.ViewGroup", viewId = "root", bounds = display, children = listOf(raw())))))
        for (changed in listOf(
            nodes[3].copy(label = "Other"),
            nodes[3].copy(rect = Bounds(40, 241, 1040, 340)),
            nodes[3].copy(enabled = false),
            nodes[3].copy(selected = true),
            nodes[3].copy(secure = true),
            nodes[3].copy(editable = true),
            nodes[3].copy(visibleToUser = false),
            nodes[3].copy(clickable = true),
            nodes[3].copy(parentIndex = 1, depth = 2),
        )) {
            assertFalse(changed.toString(), PresenceRules.sameEnumeration(nodes, nodes.dropLast(1) + changed))
        }
        assertFalse(PresenceRules.sameEnumeration(nodes, nodes.dropLast(1)))
    }
}
